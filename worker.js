const { Worker } = require('bullmq');
const IORedis    = require('ioredis');
const { supabase }                        = require('./supabase');
const { downloadVideo, cleanupVideo }     = require('./download');
const { transcribeVideo }                 = require('./transcribe');
const { analyzeTranscript }               = require('./analyze');
const { cutClips }                        = require('./cut');
const { addCaptionsBatch, addWatermarkBatch } = require('./captions'); // ← batch imports
const { enhanceAudio }                    = require('./audioEnhance');
const { generateThumbnail }               = require('./thumbnailGen');
const { uploadClips }                     = require('./upload');

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

async function updateProjectStatus(projectId, status, extra = {}) {
  await supabase
    .from('projects')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', projectId);
}

const worker = new Worker('video-processing', async (job) => {
  const { projectId, videoUrl, userId, captionStyle } = job.data;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`⚡ PROCESSING JOB: ${projectId}`);
  console.log(`📎 URL: ${videoUrl}`);
  console.log(`${'═'.repeat(60)}\n`);

  let videoMeta = null;

  try {
    // STEP 1: Download
    await updateProjectStatus(projectId, 'downloading');
    job.updateProgress(10);
    videoMeta = await downloadVideo(videoUrl);
    await supabase.from('projects').update({
      video_id:       videoMeta.videoId,
      video_title:    videoMeta.title,
      video_duration: videoMeta.durationFormatted,
      creator_name:   videoMeta.uploader,
    }).eq('id', projectId);
    console.log(`📥 Downloaded: ${videoMeta.title} (${videoMeta.durationFormatted})`);

    // STEP 2: Transcribe (uses pre-extracted audioPath for speed)
    await updateProjectStatus(projectId, 'transcribing');
    job.updateProgress(25);
    const transcript = await transcribeVideo(videoMeta.videoPath, videoMeta.audioPath);
    await supabase.from('projects').update({ transcript: transcript.fullText }).eq('id', projectId);
    console.log(`🎤 Transcribed: ${transcript.segments.length} segments`);

    // STEP 3: AI Analysis
    await updateProjectStatus(projectId, 'analyzing');
    job.updateProgress(45);
    const analysis = await analyzeTranscript(transcript, videoMeta);
    await supabase.from('projects').update({
      total_clips_found: analysis.totalClipsFound || analysis.clips.length,
      avg_viral_score:   analysis.avgViralScore   || 0,
      creator_detected:  !!analysis.creator?.name,
      creator_name:      analysis.creator?.name   || videoMeta.uploader,
    }).eq('id', projectId);
    console.log(`🧠 Analysis: ${analysis.clips.length} viral moments found`);

    // STEP 4: Cut clips (parallel)
    await updateProjectStatus(projectId, 'cutting');
    job.updateProgress(60);
    const cutResults = await cutClips(videoMeta.videoPath, analysis.clips, projectId);
    console.log(`✂️  Cut: ${cutResults.filter(r => r.success).length} clips`);

    // STEP 5: Build word lists for every clip (needed for captions)
    const successfulResults = cutResults.filter(r => r.success);
    for (const result of successfulResults) {
      const clip      = analysis.clips.find(c => c.id === result.clipId);
      result.clipMeta = clip;
      result.words    = [];
      if (!clip) continue;
      for (const seg of transcript.segments) {
        if (!seg.words) continue;
        for (const w of seg.words) {
          if (w.start >= clip.startSeconds && w.end <= clip.endSeconds) {
            result.words.push({
              word:  w.word,
              start: w.start - clip.startSeconds,
              end:   w.end   - clip.startSeconds,
            });
          }
        }
      }
    }

    // STEP 5a: Batch captions (4 clips at once, hardware accelerated)
    await updateProjectStatus(projectId, 'captioning');
    job.updateProgress(72);

    const captionInputs = successfulResults
      .filter(r => r.words.length > 0)
      .map(r => ({
        clipPath:  r.clipPath,
        words:     r.words,
        style:     captionStyle || 'wordpop', // default to most viral style
        clipId:    r.clipId,
        projectId,
        duration:  r.clipMeta?.durationSeconds,
      }));

    const captionResults = await addCaptionsBatch(captionInputs);
    // Write captionedPath back onto each result
    for (const cr of captionResults) {
      const r = cutResults.find(r => r.clipId === cr.clipId);
      if (r) r.captionedPath = cr.captionedPath;
    }
    console.log(`💬 Captions done: ${captionResults.length} clips`);

    // STEP 5b: Audio enhancement (parallel, all clips at once)
    job.updateProgress(80);
    await Promise.all(
      successfulResults.map(async (result) => {
        try {
          const input         = result.captionedPath || result.clipPath;
          result.captionedPath = await enhanceAudio(input, result.clipId, projectId);
          console.log(`🔊 Enhanced: clip ${result.clipId}`);
        } catch (e) {
          console.warn(`⚠️  Audio enhance failed clip ${result.clipId}: ${e.message}`);
        }
      })
    );

    // STEP 5c: Thumbnail generation (parallel, all clips at once)
    await Promise.all(
      successfulResults.map(async (result) => {
        try {
          result.thumbnailPath = await generateThumbnail(
            result.captionedPath || result.clipPath, result.clipId, projectId
          );
          console.log(`🖼️  Thumbnail: clip ${result.clipId}`);
        } catch (e) {
          console.warn(`⚠️  Thumbnail failed clip ${result.clipId}: ${e.message}`);
        }
      })
    );

    // STEP 5d: Watermark for free tier (batch)
    const { data: userProfile } = await supabase
      .from('profiles').select('plan').eq('id', userId).single();
    const isFreePlan = !userProfile || userProfile.plan === 'free';

    if (isFreePlan) {
      console.log('💧 Free tier — batch watermarking...');
      const wmInputs = successfulResults.map(r => ({
        clipPath:  r.captionedPath || r.clipPath,
        clipId:    r.clipId,
        projectId,
      }));
      const wmResults = await addWatermarkBatch(wmInputs);
      for (const wm of wmResults) {
        // addWatermarkBatch returns paths in same order
      }
      // Re-map: addWatermarkBatch returns paths in input order
      wmInputs.forEach((inp, i) => {
        const r = cutResults.find(r => r.clipId === inp.clipId);
        if (r) {
          r.watermarkedPath = wmResults[i];
          r.captionedPath   = wmResults[i];
        }
      });
    }

    // STEP 6: Upload to R2 (parallel inside uploadClips)
    await updateProjectStatus(projectId, 'uploading');
    job.updateProgress(88);
    const uploadResults = await uploadClips(cutResults, projectId);

    // STEP 7: Save clips to DB
    const clipRecords = analysis.clips.map((clip) => {
      const upload = uploadResults.find(u => u.clipId === clip.id);
      const cut    = cutResults.find(r => r.clipId === clip.id);
      return {
        project_id:         projectId,
        user_id:            userId,
        clip_number:        clip.id,
        start_time:         clip.startTime,
        end_time:           clip.endTime,
        duration:           clip.duration,
        duration_seconds:   clip.durationSeconds,
        viral_score:        clip.viralScore,
        engagement_score:   clip.engagementScore   || 0,
        retention_score:    clip.retentionScore     || 0,
        shareability_score: clip.shareabilityScore  || 0,
        ai_header:          clip.aiHeader,
        hook_line:          clip.hookLine,
        clip_title:         clip.clipTitle,
        seo_title:          clip.seoTitle,
        description:        clip.description,
        platform:           clip.platform,
        predicted_views:    clip.predictedViews,
        hashtags:           clip.hashtags,
        caption_style:      captionStyle || 'wordpop',
        why_viral:          clip.whyViral,
        emotion:            clip.emotion,
        category:           clip.category,
        transcript_segment: clip.transcriptSegment || '',
        video_url:          upload?.videoUrl        || null,
        thumbnail_url:      upload?.thumbnailUrl    || null,
        has_captions:       !!cut?.captionedPath,
        audio_enhanced:     true,
      };
    });

    await supabase.from('clips').insert(clipRecords);

    // DONE
    await updateProjectStatus(projectId, 'complete');
    job.updateProgress(100);
    cleanupVideo(videoMeta.videoId);

    console.log(`\n✅ PROJECT COMPLETE: ${projectId}`);
    console.log(`   ${clipRecords.length} clips · ${uploadResults.filter(u => u.videoUrl).length} downloadable\n`);

    return { success: true, clipsProcessed: clipRecords.length, projectId };

  } catch (err) {
    console.error(`\n❌ JOB FAILED: ${projectId}`, err);
    await updateProjectStatus(projectId, 'failed', { error_message: err.message });
    if (videoMeta?.videoId) cleanupVideo(videoMeta.videoId);
    throw err;
  }

}, {
  connection: redis,
  concurrency: 2,
  limiter: { max: 10, duration: 60000 },
});

worker.on('completed', job      => console.log(`✅ Job ${job.id} completed`));
worker.on('failed',   (job, err) => console.error(`❌ Job ${job?.id} failed:`, err.message));

console.log('🔄 Video processing worker started');
module.exports = worker;
