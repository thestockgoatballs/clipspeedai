const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../lib/supabase');
const { checkAndIncrementClipUsage } = require('../lib/rateLimit');
const { extractVideoId } = require('../pipeline/download');

// POST /analyze
router.post('/', async (req, res) => {
  try {
    const { url, youtube_url, captionStyle } = req.body;
    const videoUrl = url || youtube_url; // FIX 1: frontend sends both 'url' and 'youtube_url'
    const userId = req.user.id;

    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL. Paste a youtube.com or youtu.be link.' });
    }

    const usage = await checkAndIncrementClipUsage(userId);
    if (!usage.allowed) {
      return res.status(403).json({
        error: usage.error,
        plan: usage.plan,
        used: usage.used,
        limit: usage.limit,
        upgrade: true,
      });
    }

    const projectId = uuidv4();
    const { error: dbError } = await supabase.from('projects').insert({
      id: projectId,
      user_id: userId,
      video_url: videoUrl,
      video_id: videoId,
      status: 'queued', // FIX 2: was 'pending' but frontend polls for 'queued'
    });

    if (dbError) {
      console.error('DB error:', dbError);
      return res.status(500).json({ error: 'Failed to create project' });
    }

    const queue = req.app.get('videoQueue');
    await queue.add('process-video', {
      projectId,
      videoUrl,
      userId,
      captionStyle: captionStyle || 'bold',
    }, {
      jobId: projectId,
      attempts: 3,                                  // bumped from 2 to 3
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });

    console.log(`📋 Queued project ${projectId} for ${videoUrl}`);

    // Get queue position to show user
    const waiting = await queue.getWaiting();
    const position = waiting.findIndex(j => j.id === projectId) + 1;

    res.json({
      projectId,
      project_id: projectId, // FIX 1: frontend reads 'project_id' not 'projectId'
      status: 'queued',
      message: position > 1 ? `You're #${position} in line` : 'Starting shortly...',
      videoId,
    });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Failed to start analysis' });
  }
});

// GET /analyze/:projectId/status  — frontend polls this
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
      id: project.id,          // FIX 1: frontend also reads 'id'
      status: project.status,  // queued|downloading|transcribing|analyzing|cutting|captioning|uploading|done|failed
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

// GET /analyze/:projectId  — frontend also polls this URL (without /status)
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    const { data: project, error } = await supabase
      .from('projects')
      .select('id, status, error_message, total_clips_found')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json({
      id: project.id,
      status: project.status,
      error: project.error_message || null,
      clips_count: project.total_clips_found || 0,
    });

  } catch (err) {
    res.status(500).json({ error: 'Failed to get project' });
  }
});

module.exports = router;
