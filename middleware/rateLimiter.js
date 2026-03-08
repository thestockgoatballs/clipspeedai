const { supabase } = require('../lib/supabase');

const PLAN_LIMITS = {
  free:     30,
  starter:  200,
  pro:      600,
  pack3:    900,
  pack4:    1200,
  agency:   1500,
};

async function checkAndIncrementClipUsage(userId) {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('plan, clips_used_this_month, clips_limit')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    return { allowed: false, error: 'Profile not found', upgrade: true };
  }

  const limit = profile.clips_limit || PLAN_LIMITS[profile.plan] || 10;
  const used  = profile.clips_used_this_month || 0;

  if (used >= limit) {
    return {
      allowed: false,
      error:   `Clip limit reached (${used}/${limit}). Upgrade your plan for more clips.`,
      plan: profile.plan, used, limit, upgrade: true,
    };
  }

  await supabase
    .from('profiles')
    .update({ clips_used_this_month: used + 1 })
    .eq('id', userId);

  return { allowed: true, plan: profile.plan, used: used + 1, limit, remaining: limit - used - 1 };
}

async function resetMonthlyUsage() {
  await supabase.from('profiles').update({ clips_used_this_month: 0 }).neq('plan', '');
  console.log('🔄 Monthly clip usage reset for all users');
}

function rateLimiter(type) {
  return async (req, res, next) => {
    try {
      if (type === 'analyze') {
        const result = await checkAndIncrementClipUsage(req.user.id);
        if (!result.allowed) {
          return res.status(403).json({
            error:   result.error,
            upgrade: true,
            plan:    result.plan,
            used:    result.used,
            limit:   result.limit,
          });
        }
      }
      next();
    } catch (err) {
      console.error('Rate limiter error:', err.message);
      next();
    }
  };
}

module.exports = { rateLimiter, checkAndIncrementClipUsage, resetMonthlyUsage, PLAN_LIMITS };
