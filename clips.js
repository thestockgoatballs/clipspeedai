const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

/**
 * GET /clips/:projectId
 * Returns all clips for a project, sorted by viral score
 */
router.get('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Verify project belongs to user
    const { data: project } = await supabase
      .from('projects')
      .select('id, status, video_title, creator_name, total_clips_found, avg_viral_score')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get clips
    const { data: clips, error } = await supabase
      .from('clips')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('viral_score', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch clips' });
    }

    res.json({
      project,
      clips: clips || [],
      total: clips?.length || 0,
    });

  } catch (err) {
    console.error('Clips fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

/**
 * GET /clips/detail/:clipId
 * Returns full details for a single clip
 */
router.get('/detail/:clipId', async (req, res) => {
  try {
    const { clipId } = req.params;
    const userId = req.user.id;

    const { data: clip, error } = await supabase
      .from('clips')
      .select('*, projects(video_title, creator_name, video_url, video_id)')
      .eq('id', clipId)
      .eq('user_id', userId)
      .single();

    if (error || !clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    res.json(clip);

  } catch (err) {
    console.error('Clip detail error:', err);
    res.status(500).json({ error: 'Failed to fetch clip' });
  }
});

/**
 * GET /clips/user/all
 * Returns all clips for the current user across all projects
 */
router.get('/user/all', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0, minScore = 0 } = req.query;

    const { data: clips, error, count } = await supabase
      .from('clips')
      .select('*, projects(video_title, creator_name)', { count: 'exact' })
      .eq('user_id', userId)
      .gte('viral_score', parseInt(minScore))
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch clips' });
    }

    res.json({
      clips: clips || [],
      total: count || 0,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

  } catch (err) {
    console.error('User clips error:', err);
    res.status(500).json({ error: 'Failed to fetch clips' });
  }
});

module.exports = router;
