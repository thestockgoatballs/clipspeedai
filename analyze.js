const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase, checkClipLimit, getProfile } = require('../lib/supabase');
function extractVideoId(url) {
  var m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
router.post('/', async (req, res) => {
  try {
    const { url, captionStyle } = req.body;
    const userId = req.user.id;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({
        error: 'Invalid YouTube URL. Paste a youtube.com or youtu.be link.',
      });
    }
    const profile = await getProfile(userId);
    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    const canClip = await checkClipLimit(userId);
    if (!canClip) {
      return res.status(403).json({
        error: 'Clip limit reached for your plan',
        plan: profile.plan,
        used: profile.clips_used_this_month,
        limit: profile.clips_limit,
        upgrade: true,
      });
    }
    const projectId = uuidv4();
    const { error: dbError } = await supabase.from('projects').insert({
      id: projectId,
      user_id: userId,
      video_url: url,
      video_id: videoId,
      status: 'pending',
    });
    if (dbError) {
      console.error('DB error:', dbError);
      return res.status(500).json({ error: 'Failed to create project' });
    }
    const queue = req.app.get('videoQueue');
    await queue.add('process-video', {
      projectId,
      url,
      youtubeUrl: url,
      videoUrl: url,
      userId,
      plan: profile.plan || 'free',  // ✅ pass plan to worker
      captionStyle: captionStyle || 'bold',
    }, {
      jobId: projectId,
      attempts: 3,
      lockDuration: 600000,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });
    console.log(`📋 Queued project ${projectId} for user ${userId} | Plan: ${profile.plan || 'free'} | URL: ${url}`);
    res.json({
      projectId,
      status: 'pending',
      message: 'Video queued for processing',
      videoId,
    });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Failed to start analysis' });
  }
});
router.get('/:projectId/status', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();
    if (error || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const queue = req.app.get('videoQueue');
    const job = await queue.getJob(projectId);
    const progress = job ? await job.progress : 0;
    res.json({
      projectId: project.id,
      status: project.status,
      progress: typeof progress === 'number' ? progress : 0,
      videoTitle: project.video_title,
      creatorName: project.creator_name,
      totalClips: project.total_clips_found,
      avgScore: project.avg_viral_score,
      error: project.error_message,
      createdAt: project.created_at,
    });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});
module.exports = router;
