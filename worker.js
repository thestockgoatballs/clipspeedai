const { Worker } = require('bullmq');
const IORedis    = require('ioredis');
const { supabase }                  = require('./supabase');
const { downloadVideo, cleanupVideo } = require('./download');
const { transcribeVideo }           = require('./transcribe');
const { analyzeTranscript }         = require('./analyze');
const { cutClips }                  = require('./cut');
const { addCaptions, addWatermark } = require('./captions');
const { enhanceAudio }              = require('./audioEnhance');
const { generateThumbnail }         = require('./thumbnailGen');
const { uploadClips }               = require('./upload');

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

    // STEP 2: Transcribe
    await updateProjectStatus(projectId, 'transcribing');
    job.updateProgress(25);
    const transcript = await transcribeVideo(videoMeta.videoPath);
    await supabase.from('projects').update({ transcript: transcript.fullText }).eq('id', projectId);
    console.log(`🎤 Transcribed: ${transcript.segments.length} segments`);

    // STEP 3: AI Analysis
    await updateProjectStatus(projectId, 'analyzing');
    job.updateProgress(45);
    const analysis = await analyzeTranscript(transcript, videoMeta);
    await supabase.from('projects').update({
      total_clips_found: analysis.totalClipsFound || analysis.clips.length,
      avg_viral_score:   analysis.avgViralScore || 0,
      creator_detected:  !!analysis.creator?.name,
      creator_name:      analysis.creator?.name || videoMeta.uploader,
    }).eq('id', projectId);
    console.log(`🧠 Analysis: ${analysis.clips.length} viral moments found`);

    // STEP 4: Cut clips
    await updateProjectStatus(projectId, 'cutting');
    job.updateProgress(60);
    const cutResults = await cutClips(videoMeta.videoPath, analysis.clips, projectId);
    console.log(`✂️  Cut: ${cutResults.filter(r => r.success).length} clips`);

    // STEP 5: Captions + Audio Enhancement (per clip)
    await updateProjectStatus(projectId, 'captioning');
    job.updateProgress(75);

    for (const result of cutResults) {
      if (!result.success) continue;

      const clip = analysis.clips.find(c => c.id === result.clipId);
      if (!clip) continue;

      // 5a — Build word list for this clip
      const clipWords = [];
      for (const seg of transcript.segments) {
        if (!seg.words) continue;
        for (const w of seg.words) {
          if (w.start >= clip.startSeconds && w.end <= clip.endSeconds) {
            clipWords.push({
              word:  w.word,
              start: w.start - clip.startSeconds,
              end:   w.end   - clip.startSeconds,
            });
          }
        }
      }

      // 5b — Add captions
      if (clipWords.length > 0) {
        result.captionedPath = await addCaptions(
          result.clipPath, clipWords, captionStyle || 'bold', clip.id, projectId
        );
      }

      // 5c — Enhance audio (studio quality: EQ + compression + loudnorm)
      try {
        const inputForEnhance = result.captionedPath || result.clipPath;
        const enhanced = await enhanceAudio(inputForEnhance, result.clipId, projectId);
        result.captionedPath = enhanced;
        console.log(`🔊 Enhanced audio: clip ${result.clipId}`);
      } catch (enhErr) {
        console.warn(`⚠️  Audio enhance failed for clip ${result.clipId}: ${enhErr.message}`);
      }

      // 5d — Generate thumbnail from highest-motion frame
      try {
        result.thumbnailPath = await generateThumbnail(
          result.captionedPath || result.clipPath, result.clipId, projectId
        );
        console.log(`🖼️  Thumbnail ready: clip ${result.clipId}`);
      } catch (thumbErr) {
        console.warn(`⚠️  Thumbnail failed for clip ${result.clipId}: ${thumbErr.message}`);
      }
    }

    // STEP 5.5: Watermark for free tier
    const { data: userProfile } = await supabase
      .from('profiles').select('plan').eq('id', userId).single();
    const isFreePlan = !userProfile || userProfile.plan === 'free';

    if (isFreePlan) {
      console.log('💧 Free tier — adding watermark...');
      for (const result of cutResults) {
        if (!result.success) continue;
        const pathToMark = result.captionedPath || result.clipPath;
        result.watermarkedPath = await addWatermark(pathToMark, result.clipId, projectId);
        result.captionedPath   = result.watermarkedPath;
      }
    }

    // STEP 6: Upload to R2
    await updateProjectStatus(projectId, 'uploading');
    job.updateProgress(88);
    const uploadResults = await uploadClips(cutResults, projectId);

    // STEP 7: Save to DB
    const clipRecords = analysis.clips.map((clip) => {
      const upload = uploadResults.find(u => u.clipId === clip.id);
      const cut    = cutResults.find(r => r.clipId === clip.id);
      return {
        project_id:          projectId,
        user_id:             userId,
        clip_number:         clip.id,
        start_time:          clip.startTime,
        end_time:            clip.endTime,
        duration:            clip.duration,
        duration_seconds:    clip.durationSeconds,
        viral_score:         clip.viralScore,
        engagement_score:    clip.engagementScore    || 0,
        retention_score:     clip.retentionScore     || 0,
        shareability_score:  clip.shareabilityScore  || 0,
        ai_header:           clip.aiHeader,
        hook_line:           clip.hookLine,
        clip_title:          clip.clipTitle,
        seo_title:           clip.seoTitle,
        description:         clip.description,
        platform:            clip.platform,
        predicted_views:     clip.predictedViews,
        hashtags:            clip.hashtags,
        caption_style:       captionStyle || 'Bold Word-by-Word',
        why_viral:           clip.whyViral,
        emotion:             clip.emotion,
        category:            clip.category,
        transcript_segment:  clip.transcriptSegment || '',
        video_url:           upload?.videoUrl        || null,
        thumbnail_url:       upload?.thumbnailUrl    || null,
        has_captions:        !!cut?.captionedPath,
        audio_enhanced:      true,
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

worker.on('completed', job  => console.log(`✅ Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`❌ Job ${job?.id} failed:`, err.message));

console.log('🔄 Video processing worker started');
module.exports = worker;
