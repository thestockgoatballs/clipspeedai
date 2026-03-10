// ClipSpeedAI API v3 — March 9 2026
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { rateLimiter } = require('./middleware/rateLimiter');
const { verifyAuth, getProfile } = require('./lib/supabase');

const app = express();
app.use(cors({ origin: '*' }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));

const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const videoQueue = new Queue('video-processing', { connection: redis });
app.set('videoQueue', videoQueue);

// Auth middleware
async function authMiddleware(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const user = await verifyAuth(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (e) { res.status(401).json({ error: 'Auth failed' }); }
}

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), version: 'v3-mar9' }));
app.get('/', (req, res) => res.json({ app: 'ClipSpeedAI', version: 'v3-mar9' }));

// Routes — NO rateLimiter on /analyze (it's inside the route file on POST only)
try { app.use('/analyze', authMiddleware, require('./routes/analyze')); } catch(e) { console.error('Route error /analyze:', e.message); }
try { app.use('/clips', authMiddleware, require('./routes/clips')); } catch(e) { console.error('Route error /clips:', e.message); }
try { app.use('/export', authMiddleware, rateLimiter('export'), require('./routes/export')); } catch(e) {}
try { app.use('/billing', require('./routes/billing')); } catch(e) {}
try { app.use('/webhook', require('./routes/webhook')); } catch(e) {}
try { app.use('/referral', authMiddleware, require('./routes/referral')); } catch(e) {}
try { app.use('/claude', authMiddleware, rateLimiter('claude'), require('./routes/claude')); } catch(e) {}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('✅ Analyze status polling: NO rate limiter');
  console.log(`🚀 ClipSpeedAI API v3 running on port ${PORT}`);
});
