const express = require('express');
const router = express.Router();
const { supabase, getProfile } = require('../lib/supabase');

// GET /api/clips — return user's processed clips
router.get('/', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    // Get user from Supabase
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

    // Get user's clips from the clips table
    const { data: clips, error: clipsErr } = await supabase
      .from('clips')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (clipsErr) {
      console.error('Clips fetch error:', clipsErr);
      return res.status(500).json({ error: 'Failed to fetch clips' });
    }

    // Get user profile for credits
    const profile = await getProfile(user.id);
    const creditsUsed = profile?.clips_used_this_month || 0;
    const creditsTotal = profile?.credits_total || 50;
    const creditsRemaining = Math.max(0, creditsTotal - creditsUsed);

    res.json({
      clips: (clips || []).map(c => ({
        id: c.id,
        url: c.video_url || c.url,
        title: c.title || c.clip_title || 'Clip',
        viral_score: c.viral_score,
        duration: c.duration,
        created_at: c.created_at
      })),
      credits: creditsRemaining
    });

  } catch (err) {
    console.error('GET /api/clips error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
