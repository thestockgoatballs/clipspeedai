require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const IORedis    = require('ioredis');
const { Queue }  = require('bullmq');

const { rateLimiter }            = require('./middleware/rateLimiter');
const { verifyAuth, getProfile } = require('./lib/supabase');

// ── Auth middleware ───────────────────────────────────────────
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const user = await verifyAuth(token);
    if (!user)  return res.status(401).json({ error: 'Invalid or expired token' });

    // Attach profile (plan needed by rateLimiter)
    const profile  = await getProfile(user.id);
    req.user       = { ...user, plan: profile?.plan || 'free' };
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Redis + BullMQ queue ──────────────────────────────────────
const redis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
});

const videoQueue = new Queue('video-processing', { connection: redis });
app.set('videoQueue', videoQueue);

// ── Core middleware ───────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin:      process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check (no auth) ────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name: 'ClipSpeedAI API', status: 'running' });
});

// ── Public routes (no auth) ───────────────────────────────────
try { app.use('/auth',    require('./routes/auth'));    } catch (e) { console.warn('⚠️  auth route failed:',    e.message); }
try { app.use('/webhook', require('./routes/webhook')); } catch (e) { console.warn('⚠️  webhook route failed:', e.message); }

// ── Protected routes (auth + rate limiter) ────────────────────
try { app.use('/analyze',   authMiddleware, rateLimiter('analyze'),   require('./routes/analyze'));   } catch (e) { console.warn('⚠️  analyze route failed:',   e.message); }
try { app.use('/clips',     authMiddleware,                           require('./routes/clips'));     } catch (e) { console.warn('⚠️  clips route failed:',     e.message); }
try { app.use('/export',    authMiddleware, rateLimiter('export'),    require('./routes/export'));    } catch (e) { console.warn('⚠️  export route failed:',    e.message); }
try { app.use('/claude',    authMiddleware, rateLimiter('claude'),    require('./routes/claude'));    } catch (e) { console.warn('⚠️  claude route failed:',    e.message); }
try { app.use('/billing',   authMiddleware,                           require('./routes/billing'));   } catch (e) { console.warn('⚠️  billing route failed:',   e.message); }
try { app.use('/analytics', authMiddleware,                           require('./routes/analytics')); } catch (e) { console.warn('⚠️  analytics route failed:', e.message); }
try { app.use('/templates', authMiddleware,                           require('./routes/templates')); } catch (e) { console.warn('⚠️  templates route failed:', e.message); }
try { app.use('/broll',     authMiddleware,                           require('./routes/broll'));     } catch (e) { console.warn('⚠️  broll route failed:',     e.message); }

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 ClipSpeedAI API running on port ${PORT}`);
  console.log(`📋 Queue: video-processing connected`);
  console.log(`🛡️  Rate limiter: active on /analyze, /export, /claude\n`);
});

module.exports = app;
