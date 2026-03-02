const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key for backend operations
);

const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function verifyAuth(token) {
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return data;
}

async function checkClipLimit(userId) {
  const profile = await getProfile(userId);
  if (!profile) return false;
  const limits = { free: 10, starter: 50, pro: 999999, agency: 999999 };
  return profile.clips_used_this_month < (limits[profile.plan] || 10);
}

async function incrementClipCount(userId, count = 1) {
  await supabase.rpc('increment_clips', { user_id: userId, count });
}

module.exports = { supabase, verifyAuth, getProfile, checkClipLimit, incrementClipCount };
