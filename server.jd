import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import Replicate from "replicate";
import multer from "multer";
import { v4 as uuid } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
const upload = multer({ storage: multer.memoryStorage() });

// ── Auth middleware ───────────────────────────────────────────
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid token" });
  req.user = data.user;
  next();
}

// ════════════════════════════════════════════════════════════
//  BRAND TEMPLATES
// ════════════════════════════════════════════════════════════

app.get("/templates", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("brand_templates")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post("/templates", auth, async (req, res) => {
  const {
    name, accent, secondary, bg, textColor, font, captionSize,
    captionAnimation, captionPosition, transition, showEmojis, showLogo,
    logoPos, watermark, platforms, introEnabled, outroEnabled, aiEnhance
  } = req.body;

  const aiSuggestion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: `You are an expert video branding AI. Given this brand template config, suggest 1 micro-improvement in JSON: { "tip": "...", "field": "...", "suggestedValue": "..." }
Config: font=${font}, captionAnimation=${captionAnimation}, platforms=${platforms?.join(",")}`
    }],
    response_format: { type: "json_object" },
    max_tokens: 120,
  });

  let aiTip = null;
  try { aiTip = JSON.parse(aiSuggestion.choices[0].message.content); } catch {}

  const { data, error } = await supabase.from("brand_templates").insert({
    id: uuid(), user_id: req.user.id, name, accent, secondary, bg, textColor,
    font, captionSize, captionAnimation, captionPosition, transition,
    showEmojis, showLogo, logoPos, watermark, platforms,
    introEnabled, outroEnabled, aiEnhance, aiTip,
    isDefault: false, created_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error });
  res.status(201).json({ template: data, aiTip });
});

app.patch("/templates/:id", auth, async (req, res) => {
  const { data, error } = await supabase
    .from("brand_templates")
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete("/templates/:id", auth, async (req, res) => {
  const { error } = await supabase
    .from("brand_templates")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

app.post("/templates/:id/set-default", auth, async (req, res) => {
  await supabase.from("brand_templates")
    .update({ isDefault: false })
    .eq("user_id", req.user.id);
  const { data, error } = await supabase
    .from("brand_templates")
    .update({ isDefault: true })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post("/templates/:id/apply-all", auth, async (req, res) => {
  const { data: template } = await supabase
    .from("brand_templates").select("*")
    .eq("id", req.params.id).single();
  const { data: clips } = await supabase
    .from("clips").select("id")
    .eq("user_id", req.user.id);
  const updates = clips.map(c =>
    supabase.from("clips")
      .update({ template_id: req.params.id, updated_at: new Date().toISOString() })
      .eq("id", c.id)
  );
  await Promise.all(updates);
  res.json({ success: true, applied: clips.length, template: template.name });
});

app.post("/templates/:id/logo", auth, upload.single("logo"), async (req, res) => {
  const ext = req.file.mimetype.split("/")[1];
  const path = `logos/${req.user.id}/${req.params.id}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("assets").upload(path, req.file.buffer, {
      contentType: req.file.mimetype, upsert: true
    });
  if (upErr) return res.status(500).json({ error: upErr });
  const { data: { publicUrl } } = supabase.storage.from("assets").getPublicUrl(path);
  await supabase.from("brand_templates")
    .update({ logoUrl: publicUrl }).eq("id", req.params.id);
  res.json({ logoUrl: publicUrl });
});

app.post("/templates/ai-preset", auth, async (req, res) => {
  const { description } = req.body;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "system",
      content: "You are an expert brand designer for viral short-form video. Return ONLY valid JSON."
    }, {
      role: "user",
      content: `Generate a brand template config for this creator: "${description}".
Return JSON: { name, accent, secondary, bg, textColor, font, captionAnimation, captionPosition, transition, showEmojis, platforms[] }
Font options: Inter, Montserrat, Poppins, Oswald, "Bebas Neue", "Playfair Display", "DM Sans", "Space Grotesk"
Animation options: None, Pop, Fade, "Slide Up", Bounce, Typewriter, Glitch, "Neon Pulse"
Transition options: None, "Smooth Cut", "Whip Pan", "Zoom Burst", "Glitch Cut", Flash, Spin, Morph`
    }],
    response_format: { type: "json_object" },
    max_tokens: 300,
  });
  const preset = JSON.parse(completion.choices[0].message.content);
  res.json(preset);
});

// ════════════════════════════════════════════════════════════
//  B-ROLL & CAPTIONS
// ════════════════════════════════════════════════════════════

app.post("/clips/:clipId/broll/auto-match", auth, async (req, res) => {
  const { segments } = req.body;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "system",
      content: "You are a professional video editor AI. Match B-roll visuals to transcript segments. Return ONLY JSON."
    }, {
      role: "user",
      content: `For each transcript segment, suggest a specific B-roll clip description (5-8 words, vivid, cinematic).
Segments: ${JSON.stringify(segments.map(s => ({ id: s.id, text: s.text, emotion: s.emotion })))}
Return: { matches: [{ segmentId, broll: "description", category: "Cinematic|Urban|Nature|Business|Abstract|Tech" }] }`
    }],
    response_format: { type: "json_object" },
    max_tokens: 400,
  });
  const { matches } = JSON.parse(completion.choices[0].message.content);
  const updates = matches.map(m =>
    supabase.from("clip_segments")
      .update({ broll: m.broll, broll_category: m.category })
      .eq("clip_id", req.params.clipId)
      .eq("segment_id", m.segmentId)
  );
  await Promise.all(updates);
  res.json({ matches });
});

app.post("/clips/:clipId/broll/generate", auth, async (req, res) => {
  const { prompt, segmentId } = req.body;
  const output = await replicate.run(
    "stability-ai/sdxl:39ed52f2319f9b70426f8e43636e35b42ce6d31bfb53d2b5e58d0be0a6c83fce",
    { input: { prompt: `${prompt}, cinematic, 4K, short form video b-roll, no text`, width: 1080, height: 1920 } }
  );
  const brollUrl = Array.isArray(output) ? output[0] : output;
  await supabase.from("clip_segments").update({
    broll: prompt, broll_url: brollUrl, broll_generated: true,
  }).eq("clip_id", req.params.clipId).eq("segment_id", segmentId);
  res.json({ brollUrl, prompt });
});

app.post("/clips/:clipId/captions/optimize", auth, async (req, res) => {
  const { segments, platform, style } = req.body;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "system",
      content: "You are a viral content caption optimizer. Return ONLY JSON."
    }, {
      role: "user",
      content: `Optimize these captions for maximum virality on ${platform}.
Style: ${style}. For each segment, suggest: highlight words, emotion, emoji.
Segments: ${JSON.stringify(segments.map(s => ({ id: s.id, text: s.text })))}
Return: { optimized: [{ id, text, highlightWords: [], emotion: "hook|emphasis|peak|neutral", emoji: "..." }] }`
    }],
    response_format: { type: "json_object" },
    max_tokens: 500,
  });
  const { optimized } = JSON.parse(completion.choices[0].message.content);
  await Promise.all(optimized.map(seg =>
    supabase.from("clip_segments").update({
      highlight_words: seg.highlightWords,
      emotion: seg.emotion,
      emoji: seg.emoji,
    }).eq("clip_id", req.params.clipId).eq("segment_id", seg.id)
  ));
  res.json({ optimized });
});

app.post("/clips/reframe/:clipId", auth, async (req, res) => {
  const { platforms } = req.body;
  const RATIOS = { tiktok:"9:16", reels:"9:16", shorts:"9:16", linkedin:"16:9", twitter:"16:9", square:"1:1" };
  const jobs = platforms.map(p => ({
    clip_id: req.params.clipId,
    user_id: req.user.id,
    platform: p,
    ratio: RATIOS[p] || "9:16",
    id: uuid(),
    status: "queued",
    created_at: new Date().toISOString(),
  }));
  const { data, error } = await supabase.from("reframe_jobs").insert(jobs).select();
  if (error) return res.status(500).json({ error });
  res.status(202).json({ jobs: data, message: `Reframing for ${platforms.length} platforms queued` });
});

app.get("/captions/styles", auth, async (req, res) => {
  res.json({
    styles: [
      { id:"fire",    label:"Fire",    primary:"#ff4d00", highlight:"#fff700", font:"Poppins",          animation:"Pop" },
      { id:"clean",   label:"Clean",   primary:"#ffffff", highlight:"#6366f1", font:"Inter",            animation:"Fade" },
      { id:"neon",    label:"Neon",    primary:"#bf5af2", highlight:"#00d4ff", font:"Space Grotesk",    animation:"Neon Pulse" },
      { id:"gold",    label:"Gold",    primary:"#ffd700", highlight:"#ffffff", font:"Playfair Display", animation:"Fade" },
      { id:"viral",   label:"Viral",   primary:"#00ff87", highlight:"#ff00ff", font:"Oswald",           animation:"Glitch" },
      { id:"minimal", label:"Minimal", primary:"#f8fafc", highlight:"#94a3b8", font:"DM Sans",          animation:"Slide Up" },
    ]
  });
});

// ════════════════════════════════════════════════════════════
//  ANALYTICS
// ════════════════════════════════════════════════════════════

app.get("/analytics/overview", auth, async (req, res) => {
  const { range = "7d" } = req.query;
  const days = { "24h":1, "7d":7, "30d":30, "90d":90, "all":365 }[range] || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: clips } = await supabase
    .from("clip_analytics")
    .select("views, likes, shares, comments, watch_time, platform, posted_at")
    .eq("user_id", req.user.id)
    .gte("posted_at", since);
  const total_views    = clips.reduce((a,c) => a + (c.views||0), 0);
  const total_likes    = clips.reduce((a,c) => a + (c.likes||0), 0);
  const total_shares   = clips.reduce((a,c) => a + (c.shares||0), 0);
  const total_comments = clips.reduce((a,c) => a + (c.comments||0), 0);
  const avg_watch_time = clips.length
    ? (clips.reduce((a,c) => a + (c.watch_time||0), 0) / clips.length).toFixed(1) : 0;
  const by_platform = clips.reduce((acc, c) => {
    acc[c.platform] = (acc[c.platform] || 0) + c.views;
    return acc;
  }, {});
  res.json({ total_views, total_likes, total_shares, total_comments, avg_watch_time, by_platform, clip_count: clips.length });
});

app.get("/analytics/clips", auth, async (req, res) => {
  const { sort = "views", platform, range = "7d", limit = 20 } = req.query;
  const days = { "24h":1, "7d":7, "30d":30, "90d":90, "all":365 }[range] || 7;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = supabase.from("clip_analytics")
    .select("*, clips(name, duration, thumbnail_url)")
    .eq("user_id", req.user.id)
    .gte("posted_at", since)
    .order(sort, { ascending: false })
    .limit(parseInt(limit));
  if (platform && platform !== "all") q = q.eq("platform", platform);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post("/analytics/ai-insights", auth, async (req, res) => {
  const { data: topClips } = await supabase
    .from("clip_analytics")
    .select("views, watch_time, shares, platform, caption_style, broll_count, posted_hour, viral_score")
    .eq("user_id", req.user.id)
    .order("views", { ascending: false })
    .limit(10);
  const { data: recentClips } = await supabase
    .from("clip_analytics")
    .select("views, watch_time, viral_score, posted_at, platform")
    .eq("user_id", req.user.id)
    .order("posted_at", { ascending: false })
    .limit(5);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{
      role: "system",
      content: "You are an elite viral content strategist AI. Analyze creator data and return actionable insights. Return ONLY JSON."
    }, {
      role: "user",
      content: `Analyze this creator's performance data and return 5 hyper-specific AI insights.
Top clips: ${JSON.stringify(topClips)}
Recent clips: ${JSON.stringify(recentClips)}
Return: { insights: [{ icon, color, title, description, action, urgency: "high|medium|low" }] }`
    }],
    response_format: { type: "json_object" },
    max_tokens: 800,
  });
  const { insights } = JSON.parse(completion.choices[0].message.content);
  res.json({ insights });
});

app.get("/analytics/best-times", auth, async (req, res) => {
  const { data: analytics } = await supabase
    .from("clip_analytics")
    .select("views, posted_hour, posted_day, platform")
    .eq("user_id", req.user.id)
    .order("views", { ascending: false });
  const hourMap = Array.from({ length: 24 }, (_, i) => {
    const clips = analytics.filter(a => a.posted_hour === i);
    const avg = clips.length ? clips.reduce((a,c) => a+c.views,0)/clips.length : 0;
    return { hour: i, avgViews: Math.round(avg), sampleSize: clips.length };
  });
  const bestHour = [...hourMap].sort((a,b)=>b.avgViews-a.avgViews)[0]?.hour;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: `A creator's best posting hour is ${bestHour}:00. Write a 1-sentence insight explaining why and what to do.`
    }],
    max_tokens: 80,
  });
  res.json({
    hourData: hourMap,
    bestHour,
    aiInsight: completion.choices[0].message.content,
    weekSchedule: Array.from({ length: 7 }, (_, i) => ({
      day: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i],
      recommendedHour: bestHour,
      confidenceScore: Math.round(70 + Math.random()*28),
    })),
  });
});

app.post("/analytics/predict-viral", auth, async (req, res) => {
  const { hookText, duration, platform, captionStyle, hasBroll, postHour } = req.body;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{
      role: "system",
      content: "You are a viral content prediction AI. Return ONLY JSON."
    }, {
      role: "user",
      content: `Predict the viral score (0-100) for this clip:
Hook: "${hookText}", Duration: ${duration}s, Platform: ${platform}
Caption style: ${captionStyle}, B-roll: ${hasBroll}, Post hour: ${postHour}:00
Return: { viralScore: number, grade: "S|A+|A|B+|B|C", factors: [{ name, impact: "positive|negative|neutral", note }], recommendation: "one sentence" }`
    }],
    response_format: { type: "json_object" },
    max_tokens: 300,
  });
  const prediction = JSON.parse(completion.choices[0].message.content);
  res.json(prediction);
});

app.get("/analytics/streak", auth, async (req, res) => {
  const { data: posts } = await supabase
    .from("clip_analytics")
    .select("posted_at")
    .eq("user_id", req.user.id)
    .order("posted_at", { ascending: false });
  let streak = 0;
  let checkDate = new Date();
  checkDate.setHours(0,0,0,0);
  for (let i = 0; i < 365; i++) {
    const dateStr = checkDate.toISOString().split("T")[0];
    const posted = posts.some(p => p.posted_at.startsWith(dateStr));
    if (posted) { streak++; checkDate.setDate(checkDate.getDate()-1); }
    else break;
  }
  const { data: weekPosts } = await supabase
    .from("clip_analytics")
    .select("views, watch_time")
    .eq("user_id", req.user.id)
    .gte("posted_at", new Date(Date.now()-7*86400000).toISOString());
  const challenges = [
    { id:"weekly_3",   label:"Post 3 clips this week",      progress: Math.min(weekPosts?.length||0,3),   total:3,   reward:"🏅 Momentum Badge" },
    { id:"views_100k", label:"Hit 100K views in 7 days",    progress: Math.min(Math.round((weekPosts?.reduce((a,c)=>a+c.views,0)||0)/1000),100), total:100, reward:"💎 Viral Badge" },
    { id:"watch_80",   label:"80%+ watch time on 5 clips",  progress: Math.min(weekPosts?.filter(c=>c.watch_time>=80).length||0,5), total:5, reward:"⚡ Quality Creator" },
  ];
  res.json({ streak, challenges, totalClips: posts.length });
});

app.get("/analytics/live", auth, async (req, res) => {
  const { data } = await supabase
    .from("live_view_cache")
    .select("count")
    .eq("user_id", req.user.id)
    .single();
  res.json({ liveViews: data?.count || 0 });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(process.env.PORT || 3001, () =>
  console.log("🚀 AI Clip Platform backend running — Opus Clip is cooked.")
);
