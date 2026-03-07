const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── In-process profile cache ──────────────────────────────────
// Eliminates repeat DB round-trips for the same user within a job.
// TTL: 60 seconds — short enough to pick up plan upgrades quickly.
const _profileCache = new Map(); // userId → { data, expiresAt }
const CACHE_TTL_MS  = 60_000;

function _cacheGet(userId) {
  const entry = _profileCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _profileCache.delete(userId); return null; }
  return entry.data;
}
function _cacheSet(userId, data) {
  _profileCache.set(userId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}
function invalidateProfile(userId) { _profileCache.delete(userId); }

// ── Auth ──────────────────────────────────────────────────────
async function verifyAuth(token) {
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ── Profile: single query, cached ────────────────────────────
// OLD: getProfile() + checkClipLimit() = 2 DB round-trips per job
// NEW: getProfileAndLimit() = 1 round-trip, cached for 60s
async function getProfileAndLimit(userId) {
  const cached = _cacheGet(userId);
  if (cached) return cached;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, plan, clips_used_this_month, clips_limit, stripe_customer_id, stripe_subscription_id, name, email')
    .eq('id', userId)
    .single();

  if (error || !data) return null;

  // Derive limit from plan if clips_limit column is missing/null
  const PLAN_LIMITS = { free: 10, starter: 50, pro: 999999, agency: 999999 };
  data.clips_limit = data.clips_limit ?? PLAN_LIMITS[data.plan] ?? 10;
  data.canClip      = data.clips_used_this_month < data.clips_limit;

  _cacheSet(userId, data);
  return data;
}

// Keep legacy shims so existing routes don't break
async function getProfile(userId) { return getProfileAndLimit(userId); }
async function checkClipLimit(userId) {
  const p = await getProfileAndLimit(userId);
  return p ? p.canClip : false;
}

// ── Increment clip count (RPC — single round-trip) ───────────
async function incrementClipCount(userId, count = 1) {
  invalidateProfile(userId); // bust cache so next read is fresh
  const { error } = await supabase.rpc('increment_clips', {
    user_id: userId,
    count,
  });
  if (error) console.error('incrementClipCount error:', error.message);
}

// ── Batch-insert clips (one INSERT instead of N) ─────────────
// Always use this instead of individual inserts in the worker.
async function insertClips(clipRecords) {
  const { data, error } = await supabase.from('clips').insert(clipRecords).select('id');
  if (error) throw new Error(`insertClips failed: ${error.message}`);
  return data;
}

// ── Project status helper (single update, typed) ─────────────
async function setProjectStatus(projectId, status, extra = {}) {
  const { error } = await supabase
    .from('projects')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', projectId);
  if (error) console.error(`setProjectStatus(${status}) error:`, error.message);
}

// ── Transcript cache: skip re-download + re-transcription ─────
// Before starting a job, check if we've already transcribed this videoId.
// If yes, reuse the stored transcript — saves download + Whisper cost entirely.
async function getCachedTranscript(videoId) {
  const { data } = await supabase
    .from('projects')
    .select('transcript, video_title, creator_name, video_duration')
    .eq('video_id', videoId)
    .eq('status', 'complete')
    .not('transcript', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ── Analytics aggregation (real, not fake) ───────────────────
async function getUserAnalytics(userId) {
  // All in one RPC call instead of multiple selects
  const { data, error } = await supabase.rpc('get_user_analytics', { p_user_id: userId });
  if (error || !data) {
    // Fallback: manual query if RPC doesn't exist yet
    const [projects, clips] = await Promise.all([
      supabase.from('projects').select('id, created_at, total_clips_found, avg_viral_score, status').eq('user_id', userId).order('created_at', { ascending: false }).limit(30),
      supabase.from('clips').select('id, viral_score, exported, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(200),
    ]);
    const c = clips.data || [];
    return {
      totalProjects:    projects.data?.length || 0,
      totalClips:       c.length,
      totalExports:     c.filter(x => x.exported).length,
      avgViralScore:    c.length ? Math.round(c.reduce((a, x) => a + (x.viral_score || 0), 0) / c.length) : 0,
      topScore:         c.length ? Math.max(...c.map(x => x.viral_score || 0)) : 0,
      recentProjects:   projects.data || [],
      recentClips:      c.slice(0, 10),
    };
  }
  return data;
}

module.exports = {
  supabase,
  supabaseAuth,
  verifyAuth,
  getProfile,
  getProfileAndLimit,
  checkClipLimit,
  incrementClipCount,
  insertClips,
  setProjectStatus,
  getCachedTranscript,
  getUserAnalytics,
  invalidateProfile,
};
