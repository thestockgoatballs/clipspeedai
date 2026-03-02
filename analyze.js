const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../lib/supabase');
const { checkAndIncrementClipUsage } = require('../lib/rateLimit');
const { extractVideoId } = require('../pipeline/download');

/**
 * POST /analyze
 * Body: { url: "https://www.youtube.com/watch?v=..." }
 * 
 * Creates a project and queues the video for processing.
 * Returns the project ID for polling status.
 */
router.post('/', async (req, res) => {
  try {
    const { url, captionStyle } = req.body;
    const userId = req.user.id;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL. Paste a youtube.com or youtu.be link.' });
    }

    // Check user's plan and clip limit
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

    // Create project in database
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

    // Add to processing queue
    const queue = req.app.get('videoQueue');
    await queue.add('process-video', {
      projectId,
      videoUrl: url,
      userId,
      captionStyle: captionStyle || 'bold',
    }, {
      jobId: projectId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 }, // keep completed jobs for 1 hour
      removeOnFail: { age: 86400 }, // keep failed jobs for 24 hours
    });

    console.log(`📋 Queued project ${projectId} for ${url}`);

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

/**
 * GET /analyze/:projectId/status
 * Returns current processing status + progress
 */
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

    // Get job progress from queue
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
