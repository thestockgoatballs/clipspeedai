const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');

/**
 * GET /export/:clipId
 * Returns the download URL for a clip's .mp4 file
 */
router.get('/:clipId', async (req, res) => {
  try {
    const { clipId } = req.params;
    const userId = req.user.id;

    // Get clip with video URL
    const { data: clip, error } = await supabase
      .from('clips')
      .select('id, video_url, thumbnail_url, clip_title, viral_score, user_id')
      .eq('id', clipId)
      .eq('user_id', userId)
      .single();

    if (error || !clip) {
      return res.status(404).json({ error: 'Clip not found' });
    }

    if (!clip.video_url) {
      return res.status(404).json({ error: 'Clip video not yet processed' });
    }

    // Check if user is on free plan (add watermark info)
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();

    const isFreePlan = !profile || profile.plan === 'free';

    // Mark clip as exported
    await supabase.from('clips').update({ exported: true }).eq('id', clipId);

    res.json({
      clipId: clip.id,
      downloadUrl: clip.video_url,
      thumbnailUrl: clip.thumbnail_url,
      title: clip.clip_title,
      viralScore: clip.viral_score,
      watermarked: isFreePlan,
      message: isFreePlan 
        ? 'Free plan exports include ClipSpeedAI watermark. Upgrade to remove it.'
        : 'Download ready — no watermark.',
    });

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export clip' });
  }
});

/**
 * POST /export/batch
 * Batch export multiple clips
 * Body: { clipIds: ["id1", "id2", ...] }
 */
router.post('/batch', async (req, res) => {
  try {
    const { clipIds } = req.body;
    const userId = req.user.id;

    if (!clipIds || !Array.isArray(clipIds) || clipIds.length === 0) {
      return res.status(400).json({ error: 'clipIds array is required' });
    }

    if (clipIds.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 clips per batch export' });
    }

    const { data: clips, error } = await supabase
      .from('clips')
      .select('id, video_url, thumbnail_url, clip_title, viral_score, ai_header, hashtags, seo_title')
      .in('id', clipIds)
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch clips' });
    }

    // Mark all as exported
    await supabase.from('clips').update({ exported: true }).in('id', clipIds);

    res.json({
      clips: clips.map(c => ({
        clipId: c.id,
        downloadUrl: c.video_url,
        thumbnailUrl: c.thumbnail_url,
        title: c.clip_title,
        viralScore: c.viral_score,
        aiHeader: c.ai_header,
        hashtags: c.hashtags,
        seoTitle: c.seo_title,
      })),
      total: clips.length,
    });

  } catch (err) {
    console.error('Batch export error:', err);
    res.status(500).json({ error: 'Failed to batch export' });
  }
});

module.exports = router;
