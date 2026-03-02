require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const analyzeRoutes = require('./routes/analyze');
const clipsRoutes = require('./routes/clips');
const exportRoutes = require('./routes/export');
const webhookRoutes = require('./routes/webhook');
const { verifyAuth } = require('./lib/supabase');

const app = express();
const PORT = process.env.PORT || 8080;

// Redis connection for job queue
const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const videoQueue = new Queue('video-processing', { connection: redis });

// Make queue available to routes
app.set('videoQueue', videoQueue);

// Middleware
app.use(helmet());
app.use(cors({
  origin: [process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000', 'https://clipspeed.ai'],
  credentials: true
}));

// Stripe webhook needs raw body - MUST be before express.json()
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Health check (no auth needed)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'clipspeedai-backend', version: '1.0.0' });
});

// Auth middleware for protected routes
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const user = await verifyAuth(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
};

// Routes
app.use('/analyze', authMiddleware, analyzeRoutes);
app.use('/clips', authMiddleware, clipsRoutes);
app.use('/export', authMiddleware, exportRoutes);
app.use('/webhook', webhookRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`⚡ ClipSpeedAI backend running on port ${PORT}`);
  console.log(`📦 Redis connected: ${!!redis.status}`);
});

// Start the worker in the same process (or run separately with npm run worker)
require('./queue/worker');
