const { Worker } = require('bullmq');
const IORedis    = require('ioredis');
const { supabase }                            = require('./lib/supabase');
const { downloadVideo, cleanupVideo }         = require('./download');
const { transcribeVideo }                     = require('./transcribe');
const { analyzeTranscript }                   = require('./analyze');
const { cutClips }                            = require('./cut');
const { addCaptionsBatch, addWatermarkBatch } = require('./captions');
const { enhanceAudio }                        = require('./audioEnhance');
const { generateThumbnail }                   = require('./thumbnailGen');
const { uploadClips }                         = require('./upload');
const { DURATION_CAPS }                       = require('../routes/referral');

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
    await job.updateProgress(10);                          // FIX: awaited
    videoMeta = await downloadVideo(videoUrl);
    await supabase.from('projects').update({
      video_id:       videoMeta.videoId,
      video_title:    videoMeta.title,
      video_duration: videoMeta.durationFormatted,
      creator_name:   videoMeta.uploader,
    }).eq('id', projectId);
    console.log(`📥 Downloaded: ${videoMeta.title} (${videoMeta.durationFormatted})`);

    // ── DURATION CAP CHECK ────────────────────────────────────
    const { data: userProfile } = await supabase
      .from('profiles').select('plan').eq('id', userId).single();
    const plan    = userProfile?.plan || 'free';
    const capSecs = DURATION_CAPS[plan] ?? DURATION_CAPS.free;

    if (videoMeta.durationSeconds && videoMeta.durationSeconds > capSecs) {
      const capMins = Math.round(capSecs / 60);
      const vidMins = Math.round(videoMeta.durationSeconds / 60);
      await updateProjectStatus(projectId, 'failed', {
        error_message: `Video is ${vidMins} min — your ${plan} plan supports up to ${capMins} min. Upgrade to process longer videos.`,
      });
      if (videoMeta?.videoId) cleanupVideo(videoMeta.videoId);
      return { success: false, reason: 'duration_cap', capMins, vidMins, plan };
    }
    console.log(`✅ Duration OK: ${Math.round((videoMeta.durationSeconds||0)/60)} min (cap: ${Math.round(capSecs/60)} min)`);
    // ─────────────────────────────────────────────────────────

    // STEP 2: Transcribe
    await updateProjectStatus(projectId, 'transcribing');
    await job.updateProgress(25);                          // FIX: awaited
    const transcript = await transcribeVideo(videoMeta.videoPath, videoMeta.audioPath);
    await supabase.from('projects').update({ transcript: transcript.fullText }).eq('id', projectId);
    console.log(`🎤 Transcribed: ${transcript.segments.length} segments`);

    // STEP 3: AI Analysis
    await updateProjectStatus(projectId, 'analyzing');
    await job.updateProgress(45);                          // FIX: awaited
    const analysis = await analyzeTranscript(transcript, videoMeta);
    await supabase.from('projects').update({
      total_clips_found: analysis.totalClipsFound || analysis.clips?.length || analysis.length,
      avg_viral_score:   analysis.avgViralScore   || 0,
      creator_detected:  !!analysis.creator?.name,
      creator_name:      analysis.creator?.name   || videoMeta.uploader,
    }).eq('id', projectId);

    // analyzeTranscript returns array directly — normalize here
    const clips = Array.isArray(analysis) ? analysis : (analysis.clips || []);
    console.log(`🧠 Analysis: ${clips.length} viral moments found`);

    // STEP 4: Cut clips (parallel)
    await updateProjectStatus(projectId, 'cutting');
    await job.updateProgress(60);                          // FIX: awaited
    const cutResults = await cutClips(videoMeta.videoPath, clips, projectId);
    console.log(`✂️  Cut: ${cutResults.filter(r => r.success).length} clips`);

    // STEP 5: Build word lists per clip
    const successfulResults = cutResults.filter(r => r.success);
    for (const result of successfulResults) {
      const clip      = clips.find(c => c.id === result.clipId);
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

    // STEP 5a: Batch captions
    await updateProjectStatus(projectId, 'captioning');
    await job.updateProgress(72);                          // FIX: awaited
    const captionInputs = successfulResults
      .filter(r => r.words.length > 0)
      .map(r => ({
        clipPath:  r.clipPath,
        words:     r.words,
        style:     captionStyle || 'wordpop',
        clipId:    r.clipId,
        projectId,
        duration:  r.clipMeta?.durationSeconds,
      }));
    const captionResults = await addCaptionsBatch(captionInputs);
    for (const cr of captionResults) {
      const r = cutResults.find(r => r.clipId === cr.clipId);
      if (r) r.captionedPath = cr.captionedPath;
    }
    console.log(`💬 Captions done: ${captionResults.length} clips`);

    // STEP 5b: Audio enhancement
    await job.updateProgress(80);                          // FIX: awaited
    await Promise.all(
      successfulResults.map(async (result) => {
        try {
          const input = result.captionedPath || result.clipPath;
          const enhanced = await enhanceAudio(input, result.clipId, projectId);
          if (enhanced) result.captionedPath = enhanced;  // FIX: only reassign if non-null
          console.log(`🔊 Enhanced: clip ${result.clipId}`);
        } catch (e) {
          console.warn(`⚠️  Audio enhance failed clip ${result.clipId}: ${e.message}`);
        }
      })
    );

    // STEP 5c: Thumbnails
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

    // STEP 5d: Watermark free tier
    const isFreePlan = !userProfile || userProfile.plan === 'free';
    if (isFreePlan) {
      console.log('💧 Free tier — batch watermarking...');
      const wmInputs  = successfulResults.map(r => ({
        clipPath: r.captionedPath || r.clipPath, clipId: r.clipId, projectId,
      }));
      const wmResults = await addWatermarkBatch(wmInputs);
      wmInputs.forEach((inp, i) => {
        const r = cutResults.find(r => r.clipId === inp.clipId);
        if (r && wmResults[i]) { r.watermarkedPath = wmResults[i]; r.captionedPath = wmResults[i]; }
      });
    }

    // STEP 6: Upload to R2
    await updateProjectStatus(projectId, 'uploading');
    await job.updateProgress(88);                          // FIX: awaited
    const uploadResults = await uploadClips(cutResults, projectId);

    // STEP 7: Save to DB
    const clipRecords = clips.map((clip) => {
      const upload = uploadResults.find(u => u.clipId === clip.id);
      const cut    = cutResults.find(r => r.clipId === clip.id);
      return {
        project_id:         projectId,
        user_id:            userId,
        clip_number:        clip.id,
        start_time:         clip.startTime       || clip.startSeconds,
        end_time:           clip.endTime         || clip.endSeconds,
        duration:           clip.duration,
        duration_seconds:   clip.durationSeconds || (clip.endSeconds - clip.startSeconds),
        viral_score:        clip.viralScore      || clip.viral_score || 0,
        engagement_score:   clip.engagementScore   || 0,
        retention_score:    clip.retentionScore     || 0,
        shareability_score: clip.shareabilityScore  || 0,
        ai_header:          clip.aiHeader  || clip.title,
        hook_line:          clip.hookLine  || clip.hook,
        clip_title:         clip.clipTitle || clip.title,
        seo_title:          clip.seoTitle  || clip.title,
        description:        clip.description || clip.reason,
        platform:           clip.platform,
        predicted_views:    clip.predictedViews,
        hashtags:           clip.hashtags,
        caption_style:      captionStyle || 'wordpop',
        why_viral:          clip.whyViral || clip.reason,
        emotion:            clip.emotion,
        category:           clip.category,
        transcript_segment: clip.transcriptSegment || '',
        video_url:          upload?.videoUrl     || null,
        thumbnail_url:      upload?.thumbnailUrl || null,
        has_captions:       !!cut?.captionedPath,
        audio_enhanced:     true,
      };
    });

    await supabase.from('clips').insert(clipRecords);

    // DONE
    await updateProjectStatus(projectId, 'completed');     // FIX: 'complete' → 'completed'
    await job.updateProgress(100);                         // FIX: awaited
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
