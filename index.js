// ClipSpeedAI API v3 — March 9 2026
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

// ═══ ENV CHECK ═══
const required = ['REDIS_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

// ═══ REDIS + QUEUE ═══
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 200, 5000)
});
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (e) => console.error('❌ Redis error:', e.message));

const clipQueue = new Queue('clip-processing', { connection: redis });

// ═══ SUPABASE ═══
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ═══ EXPRESS ═══
const app = express();
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// ═══ HEALTH CHECK ═══
app.get('/api/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', redis: 'connected', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', redis: 'disconnected' });
  }
});

// ═══ AUTH MIDDLEWARE ═══
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;

    // Get or create profile
    let { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (!profile) {
      const { data: newProfile } = await supabase
        .from('profiles')
        .insert({ id: user.id, email: user.email, credits_total: 50, clips_used_this_month: 0 })
        .select()
        .single();
      profile = newProfile;
    }
    req.profile = profile;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(401).json({ error: 'Auth failed' });
  }
}

// ═══ POST /api/analyze — Start clip generation ═══
app.post('/api/analyze', authMiddleware, async (req, res) => {
  try {
    const { url, kickUsername } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Validate YouTube URL
    const ytRegex = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/;
    const match = url.match(ytRegex);
    if (!match) return res.status(400).json({ error: 'Invalid YouTube URL' });

    // Check credits
    const used = req.profile?.clips_used_this_month || 0;
    const total = req.profile?.credits_total || 50;
    if (used >= total) return res.status(403).json({ error: 'No credits remaining. Upgrade your plan or refer friends!' });

    // Create job
    const { v4: uuidv4 } = require('uuid');
    const jobId = uuidv4();

    const job = await clipQueue.add('process-video', {
      jobId,
      url,
      videoId: match[1],
      userId: req.user.id,
      email: req.user.email,
      kickUsername: kickUsername || null
    }, {
      jobId,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 20
    });

    console.log(`🚀 Job ${jobId} queued for ${match[1]}${kickUsername ? ` (Kick: ${kickUsername})` : ''}`);
    res.json({ jobId, status: 'queued', videoId: match[1] });

  } catch (err) {
    console.error('POST /api/analyze error:', err);
    res.status(500).json({ error: 'Failed to queue job' });
  }
});

// ═══ GET /api/status/:jobId — Poll job status ═══
app.get('/api/status/:jobId', authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await clipQueue.getJob(jobId);

    if (!job) return res.json({ jobId, state: 'not_found' });

    const state = await job.getState();
    const progress = job.progress || 0;

    res.json({
      jobId,
      state,
      progress,
      result: state === 'completed' ? job.returnvalue : null,
      error: state === 'failed' ? job.failedReason : null
    });

  } catch (err) {
    console.error('GET /api/status error:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// ═══ GET /api/clips — Get user's processed clips ═══
app.get('/api/clips', authMiddleware, async (req, res) => {
  try {
    const { data: clips, error: clipsErr } = await supabase
      .from('clips')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (clipsErr) {
      console.error('Clips fetch error:', clipsErr);
      return res.status(500).json({ error: 'Failed to fetch clips' });
    }

    const creditsUsed = req.profile?.clips_used_this_month || 0;
    const creditsTotal = req.profile?.credits_total || 50;
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

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ClipSpeedAI API running on port ${PORT}`);
  console.log(`📡 Redis: ${process.env.REDIS_URL ? 'configured' : 'MISSING'}`);
  console.log(`🔐 Supabase: ${process.env.SUPABASE_URL ? 'configured' : 'MISSING'}`);
});
