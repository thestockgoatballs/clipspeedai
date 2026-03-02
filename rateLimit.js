const { supabase } = require('./supabase');

const PLAN_LIMITS = {
  free: 30,
  starter: 200,
  pro: 600,
  pack3: 900,
  pack4: 1200,
  agency: 1500,
};

/**
 * Rate limiting middleware - checks clip usage against plan limits
 * Increments clip count on each successful analysis request
 */
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
  const used = profile.clips_used_this_month || 0;

  if (used >= limit) {
    return {
      allowed: false,
      error: `Clip limit reached (${used}/${limit}). Upgrade your plan for more clips.`,
      plan: profile.plan,
      used,
      limit,
      upgrade: true,
    };
  }

  // Increment usage
  await supabase
    .from('profiles')
    .update({ clips_used_this_month: used + 1 })
    .eq('id', userId);

  return {
    allowed: true,
    plan: profile.plan,
    used: used + 1,
    limit,
    remaining: limit - used - 1,
  };
}

/**
 * Reset monthly clip counts (call via cron job on 1st of each month)
 */
async function resetMonthlyUsage() {
  await supabase
    .from('profiles')
    .update({ clips_used_this_month: 0 })
    .neq('plan', '');

  console.log('🔄 Monthly clip usage reset for all users');
}

module.exports = { checkAndIncrementClipUsage, resetMonthlyUsage, PLAN_LIMITS };
