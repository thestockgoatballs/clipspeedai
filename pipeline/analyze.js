const OpenAI = require('openai');
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Viral detection prompt ────────────────────────────────────
// Engineered specifically for short-form social (TikTok/Reels/Shorts).
// Uses gpt-4o-mini — 33x cheaper than gpt-4o, same quality for this task.
const SYSTEM_PROMPT = `You are the world's best viral short-form video editor.
You have studied every viral TikTok, Reel, and YouTube Short.
You know exactly which moments make people stop scrolling, watch twice, and share.

Your job: analyze a video transcript and identify the 8-12 best clips to extract.

VIRAL MOMENT RULES — a clip scores high if it has:
1. HOOK (first 2 seconds grabs attention — shocking stat, bold claim, emotional peak)
2. EMOTION (rage, shock, laugh, inspiration, fear, awe — the stronger the better)
3. SELF-CONTAINED (makes complete sense without watching the rest of the video)
4. RELATABLE or CONTROVERSIAL (people want to share it or argue about it)
5. PUNCHY ENDING (ends on a punchline, revelation, or cliff-hanger)

AVOID:
- Clips that start mid-sentence with no context
- Clips that are just transitions or intros
- Clips with no emotional peak
- Clips longer than 60 seconds or shorter than 8 seconds

OUTPUT: Respond with ONLY a valid JSON array. No markdown, no explanation, no backticks.`;

const USER_PROMPT = (transcript, videoMeta) => `
VIDEO: "${videoMeta?.title || 'Unknown'}" by ${videoMeta?.uploader || 'Unknown'}
DURATION: ${videoMeta?.duration || 'Unknown'} seconds

TRANSCRIPT WITH TIMESTAMPS:
${transcript.segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n')}

Find the 8-12 best viral clips. Return ONLY this JSON array:
[
  {
    "id": 1,
    "startSeconds": 12.5,
    "endSeconds": 28.3,
    "startTime": "0:12",
    "endTime": "0:28",
    "duration": "16s",
    "durationSeconds": 15.8,
    "clipTitle": "Short punchy title for the clip",
    "hookLine": "The exact first sentence that hooks viewers",
    "aiHeader": "ALL CAPS CAPTION FOR THE CLIP",
    "seoTitle": "SEO-optimized YouTube/TikTok title",
    "description": "2-sentence description for posting",
    "hashtags": "#viral #fyp #relevant #hashtags",
    "whyViral": "One sentence explaining why this will perform",
    "emotion": "shock|laugh|rage|inspiration|fear|awe|curiosity",
    "category": "moment|story|fact|opinion|reaction|advice",
    "platform": "tiktok|reels|shorts",
    "predictedViews": "500K-2M",
    "viralScore": 87,
    "hookScore": 85,
    "flowScore": 82,
    "valueScore": 90,
    "trendScore": 78,
    "transcriptSegment": "The actual transcript text for this clip"
  }
]

Score each clip honestly. Only include clips with viralScore >= 65.
Sort by viralScore descending.`;

// ── Main export ───────────────────────────────────────────────
async function analyzeTranscript(transcript, videoMeta) {
  console.log(`🧠 Analyzing transcript (${transcript.fullText?.length || 0} chars)...`);

  if (!transcript?.segments?.length) {
    throw new Error('No transcript segments to analyze');
  }

  // For very long videos, chunk the transcript to stay within token limits
  const segments = transcript.segments;
  const CHUNK_SEGMENT_LIMIT = 180; // ~30 min of content per call

  let allClips = [];

  if (segments.length <= CHUNK_SEGMENT_LIMIT) {
    // Single call for most videos
    allClips = await detectViralMoments(transcript, videoMeta);
  } else {
    // Chunked analysis for long videos (60min+)
    console.log(`📏 Long video — chunking into segments...`);
    const chunks = chunkSegments(segments, CHUNK_SEGMENT_LIMIT, 10); // 10 segment overlap

    const chunkResults = await Promise.all(
      chunks.map((chunk, i) => {
        const chunkTranscript = {
          ...transcript,
          segments: chunk,
          fullText: chunk.map(s => s.text).join(' '),
        };
        return detectViralMoments(chunkTranscript, videoMeta)
          .catch(e => { console.warn(`Chunk ${i} failed: ${e.message}`); return []; });
      })
    );

    allClips = chunkResults.flat();
  }

  // Deduplicate overlapping clips (keep highest scoring)
  const deduped = deduplicateClips(allClips);

  // Re-number IDs sequentially
  const clips = deduped
    .sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0))
    .slice(0, 12) // max 12 clips
    .map((clip, i) => ({ ...clip, id: i + 1 }));

  const avgScore = clips.length
    ? Math.round(clips.reduce((s, c) => s + (c.viralScore || 0), 0) / clips.length)
    : 0;

  console.log(`✅ Found ${clips.length} viral moments (avg score: ${avgScore})`);

  return {
    clips,
    totalClipsFound: clips.length,
    avgViralScore:   avgScore,
    creator: {
      name:     videoMeta?.uploader || null,
      platform: videoMeta?.platform || 'youtube',
    },
  };
}

// ── Single GPT call ───────────────────────────────────────────
async function detectViralMoments(transcript, videoMeta, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model:       'gpt-4o-mini',  // 33x cheaper than gpt-4o, same quality for this task
        max_tokens:  4000,
        temperature: 0.4,            // low temp = consistent, reliable output
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: USER_PROMPT(transcript, videoMeta) },
        ],
      });

      const raw = response.choices[0]?.message?.content?.trim() || '';
      const clips = parseClipsJSON(raw);

      if (!Array.isArray(clips) || clips.length === 0) {
        throw new Error('No clips returned from GPT');
      }

      // Validate and sanitize each clip
      return clips
        .filter(c => c.startSeconds != null && c.endSeconds != null)
        .filter(c => c.endSeconds - c.startSeconds >= 6)   // min 6s
        .filter(c => c.endSeconds - c.startSeconds <= 65)  // max 65s
        .filter(c => (c.viralScore || 0) >= 60)
        .map(c => sanitizeClip(c, transcript));

    } catch (err) {
      console.error(`GPT attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === retries) {
        console.error('All GPT retries exhausted — using fallback clip detection');
        return fallbackClipDetection(transcript, videoMeta);
      }
      await sleep(1500 * (attempt + 1)); // backoff
    }
  }
  return [];
}

// ── JSON parser (handles GPT formatting quirks) ───────────────
function parseClipsJSON(raw) {
  // Strip markdown code fences if present
  let cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Extract JSON array if wrapped in extra text
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) cleaned = arrayMatch[0];

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Attempt to fix common GPT JSON errors (trailing commas, single quotes)
    const fixed = cleaned
      .replace(/,\s*([}\]])/g, '$1')  // trailing commas
      .replace(/'/g, '"');             // single quotes
    try {
      return JSON.parse(fixed);
    } catch (_) {
      throw new Error(`JSON parse failed: ${e.message}`);
    }
  }
}

// ── Sanitize a clip object ────────────────────────────────────
function sanitizeClip(clip, transcript) {
  const start = parseFloat(clip.startSeconds) || 0;
  const end   = parseFloat(clip.endSeconds)   || start + 30;

  // Pull actual transcript text for this time range if not provided
  const transcriptSegment = clip.transcriptSegment ||
    transcript.segments
      .filter(s => s.start >= start - 0.5 && s.end <= end + 0.5)
      .map(s => s.text)
      .join(' ')
      .trim();

  return {
    id:                clip.id || 1,
    startSeconds:      start,
    endSeconds:        end,
    startTime:         clip.startTime         || formatTime(start),
    endTime:           clip.endTime           || formatTime(end),
    duration:          clip.duration          || `${Math.round(end - start)}s`,
    durationSeconds:   end - start,
    clipTitle:         clip.clipTitle         || 'Viral Clip',
    hookLine:          clip.hookLine          || '',
    aiHeader:          (clip.aiHeader         || clip.clipTitle || '').toUpperCase(),
    seoTitle:          clip.seoTitle          || clip.clipTitle || '',
    description:       clip.description       || '',
    hashtags:          clip.hashtags          || '#viral #fyp',
    whyViral:          clip.whyViral          || '',
    emotion:           clip.emotion           || 'excitement',
    category:          clip.category          || 'moment',
    platform:          clip.platform          || 'tiktok',
    predictedViews:    clip.predictedViews    || '100K-500K',
    viralScore:        Math.min(99, Math.max(0, parseInt(clip.viralScore)  || 70)),
    hookScore:         Math.min(99, Math.max(0, parseInt(clip.hookScore)   || 70)),
    flowScore:         Math.min(99, Math.max(0, parseInt(clip.flowScore)   || 70)),
    valueScore:        Math.min(99, Math.max(0, parseInt(clip.valueScore)  || 70)),
    trendScore:        Math.min(99, Math.max(0, parseInt(clip.trendScore)  || 70)),
    engagementScore:   parseInt(clip.engagementScore)   || 70,
    retentionScore:    parseInt(clip.retentionScore)    || 70,
    shareabilityScore: parseInt(clip.shareabilityScore) || 70,
    transcriptSegment,
  };
}

// ── Fallback: evenly-spaced clips if GPT fails ────────────────
function fallbackClipDetection(transcript, videoMeta) {
  console.log('⚠️  Using fallback clip detection');
  const duration = videoMeta?.duration || transcript.segments[transcript.segments.length - 1]?.end || 600;
  const clipDur  = 30;
  const count    = Math.min(8, Math.floor(duration / clipDur));
  const clips    = [];

  for (let i = 0; i < count; i++) {
    const start = Math.floor(duration / count * i);
    const end   = Math.min(duration, start + clipDur);
    const segs  = transcript.segments.filter(s => s.start >= start && s.end <= end);
    const text  = segs.map(s => s.text).join(' ').trim();

    clips.push(sanitizeClip({
      id:           i + 1,
      startSeconds: start,
      endSeconds:   end,
      clipTitle:    `Clip ${i + 1}`,
      hookLine:     text.slice(0, 80),
      viralScore:   70,
      hookScore:    70, flowScore: 70, valueScore: 70, trendScore: 70,
      emotion:      'excitement',
      transcriptSegment: text,
    }, transcript));
  }

  return clips;
}

// ── Deduplicate overlapping clips ─────────────────────────────
function deduplicateClips(clips) {
  const sorted = [...clips].sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0));
  const kept   = [];

  for (const clip of sorted) {
    const overlaps = kept.some(k => {
      const overlapStart = Math.max(clip.startSeconds, k.startSeconds);
      const overlapEnd   = Math.min(clip.endSeconds,   k.endSeconds);
      const overlap      = overlapEnd - overlapStart;
      const minDur       = Math.min(clip.durationSeconds, k.durationSeconds);
      return overlap > 0 && overlap / minDur > 0.4; // >40% overlap = duplicate
    });
    if (!overlaps) kept.push(clip);
  }

  return kept;
}

// ── Chunk long transcripts ────────────────────────────────────
function chunkSegments(segments, chunkSize, overlap) {
  const chunks = [];
  let i = 0;
  while (i < segments.length) {
    chunks.push(segments.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

// ── Helpers ───────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { analyzeTranscript };
