const IORedis = require('ioredis');

const redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
});

const LIMITS = {
    free:    { max: 3,  window: 60 },
    starter: { max: 10, window: 60 },
    pro:     { max: 20, window: 60 },
    agency:  { max: 40, window: 60 },
};

function rateLimiter(routeName) {
    return async (req, res, next) => {
        const userId = req.user?.id;
        if (!userId) return next();

        const plan  = req.user?.plan || 'free';
        const rule  = LIMITS[plan]   || LIMITS.free;
        const key   = `rl:${routeName}:${userId}`;

        try {
            const count = await redis.incr(key);
            if (count === 1) await redis.expire(key, rule.window);

            if (count > rule.max) {
                const ttl = await redis.ttl(key);
                return res.status(429).json({
                    error:   'Rate limit exceeded',
                    retryIn: ttl,
                    limit:   rule.max,
                    window:  rule.window,
                    upgrade: plan === 'free',
                });
            }
        } catch (_) {
            // Redis error — fail open so users are never blocked by infra issues
        }

        next();
    };
}

module.exports = { rateLimiter };
