const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { supabase } = require('../lib/supabase');
const { downloadVideo, cleanupVideo } = require('../pipeline/download');
const { transcribeVideo } = require('../pipeline/transcribe');
const { analyzeTranscript } = require('../pipeline/analyze');
const { cutClips } = require('../pipeline/cut');
const { addCaptions, addWatermark } = require('../pipeline/captions');
const { uploadClips } = require('../pipeline/upload');

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
    // ═══════════════════════════════════════
    // STEP 1: Download the video
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'downloading');
    job.updateProgress(10);

    videoMeta = await downloadVideo(videoUrl);
    
    await supabase.from('projects').update({
      video_id: videoMeta.videoId,
      video_title: videoMeta.title,
      video_duration: videoMeta.durationFormatted,
      creator_name: videoMeta.uploader,
    }).eq('id', projectId);

    console.log(`📥 Downloaded: ${videoMeta.title} (${videoMeta.durationFormatted})`);

    // ═══════════════════════════════════════
    // STEP 2: Transcribe audio
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'transcribing');
    job.updateProgress(25);

    const transcript = await transcribeVideo(videoMeta.videoPath);
    
    await supabase.from('projects').update({
      transcript: transcript.fullText,
    }).eq('id', projectId);

    console.log(`🎤 Transcribed: ${transcript.segments.length} segments, ${transcript.fullText.length} chars`);

    // ═══════════════════════════════════════
    // STEP 3: AI Analysis (find viral moments)
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'analyzing');
    job.updateProgress(45);

    const analysis = await analyzeTranscript(transcript, videoMeta);

    await supabase.from('projects').update({
      total_clips_found: analysis.totalClipsFound || analysis.clips.length,
      avg_viral_score: analysis.avgViralScore || 0,
      creator_detected: !!analysis.creator?.name,
      creator_name: analysis.creator?.name || videoMeta.uploader,
    }).eq('id', projectId);

    console.log(`🧠 Analysis: ${analysis.clips.length} viral moments found`);

    // ═══════════════════════════════════════
    // STEP 4: Cut clips with FFmpeg
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'cutting');
    job.updateProgress(60);

    const cutResults = await cutClips(videoMeta.videoPath, analysis.clips, projectId);

    console.log(`✂️ Cut: ${cutResults.filter(r => r.success).length} clips`);

    // ═══════════════════════════════════════
    // STEP 5: Add captions to clips
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'captioning');
    job.updateProgress(75);

    for (const result of cutResults) {
      if (!result.success) continue;

      // Find transcript words that fall within this clip's time range
      const clip = analysis.clips.find(c => c.id === result.clipId);
      if (!clip) continue;

      const clipWords = [];
      for (const seg of transcript.segments) {
        if (seg.words) {
          for (const w of seg.words) {
            if (w.start >= clip.startSeconds && w.end <= clip.endSeconds) {
              clipWords.push({
                word: w.word,
                start: w.start - clip.startSeconds, // relative to clip start
                end: w.end - clip.startSeconds,
              });
            }
          }
        }
      }

      if (clipWords.length > 0) {
        const captionedPath = await addCaptions(
          result.clipPath, clipWords, captionStyle || 'bold', clip.id, projectId
        );
        result.captionedPath = captionedPath;
      }
    }

    // ═══════════════════════════════════════
    // STEP 5.5: Add watermark for free tier users
    // ═══════════════════════════════════════
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();
    
    const isFreePlan = !userProfile || userProfile.plan === 'free';
    
    if (isFreePlan) {
      console.log('💧 Free tier — adding watermark to all clips...');
      for (const result of cutResults) {
        if (!result.success) continue;
        const pathToWatermark = result.captionedPath || result.clipPath;
        const watermarked = await addWatermark(pathToWatermark, result.clipId, projectId);
        result.watermarkedPath = watermarked;
      }
    }

    // ═══════════════════════════════════════
    // STEP 6: Upload to R2 storage
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'uploading');
    job.updateProgress(88);

    const uploadResults = await uploadClips(cutResults, projectId);

    // ═══════════════════════════════════════
    // STEP 7: Save clips to database
    // ═══════════════════════════════════════
    const clipRecords = analysis.clips.map((clip, i) => {
      const upload = uploadResults.find(u => u.clipId === clip.id);
      return {
        project_id: projectId,
        user_id: userId,
        clip_number: clip.id,
        start_time: clip.startTime,
        end_time: clip.endTime,
        duration: clip.duration,
        duration_seconds: clip.durationSeconds,
        viral_score: clip.viralScore,
        engagement_score: clip.engagementScore || 0,
        retention_score: clip.retentionScore || 0,
        shareability_score: clip.shareabilityScore || 0,
        ai_header: clip.aiHeader,
        hook_line: clip.hookLine,
        clip_title: clip.clipTitle,
        seo_title: clip.seoTitle,
        description: clip.description,
        platform: clip.platform,
        predicted_views: clip.predictedViews,
        hashtags: clip.hashtags,
        caption_style: captionStyle || 'Bold Word-by-Word',
        why_viral: clip.whyViral,
        emotion: clip.emotion,
        category: clip.category,
        transcript_segment: clip.transcriptSegment || '',
        video_url: upload?.videoUrl || null,
        thumbnail_url: upload?.thumbnailUrl || null,
        has_captions: !!cutResults.find(r => r.clipId === clip.id)?.captionedPath,
      };
    });

    await supabase.from('clips').insert(clipRecords);

    // ═══════════════════════════════════════
    // DONE!
    // ═══════════════════════════════════════
    await updateProjectStatus(projectId, 'complete');
    job.updateProgress(100);

    // Clean up temp files
    cleanupVideo(videoMeta.videoId);

    console.log(`\n✅ PROJECT COMPLETE: ${projectId}`);
    console.log(`   ${clipRecords.length} clips processed and uploaded`);
    console.log(`   ${uploadResults.filter(u => u.videoUrl).length} downloadable .mp4 files\n`);

    return { 
      success: true, 
      clipsProcessed: clipRecords.length,
      projectId 
    };

  } catch (err) {
    console.error(`\n❌ JOB FAILED: ${projectId}`);
    console.error(err);

    await updateProjectStatus(projectId, 'failed', { error_message: err.message });

    // Clean up on failure
    if (videoMeta?.videoId) cleanupVideo(videoMeta.videoId);

    throw err;
  }

}, {
  connection: redis,
  concurrency: 2, // Process 2 videos at a time
  limiter: {
    max: 10,
    duration: 60000, // Max 10 jobs per minute
  },
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on('progress', (job, progress) => {
  // Could emit to WebSocket for real-time progress
});

console.log('🔄 Video processing worker started');

module.exports = worker;
