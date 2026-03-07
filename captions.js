const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const CAPTIONS_DIR  = '/tmp/clipspeed/captions';
const MAX_PARALLEL  = 4; // burn captions on 4 clips simultaneously

// ── Hardware acceleration detection (cached at startup) ──────────────────
let _hwAccel = null;
function detectHWAccel() {
  if (_hwAccel !== null) return _hwAccel;
  try {
    const { execSync } = require('child_process');
    const encoders = execSync('ffmpeg -encoders 2>/dev/null', { timeout: 5000 }).toString();
    if (encoders.includes('h264_nvenc'))   { _hwAccel = { enc: 'h264_nvenc',   extra: ['-rc', 'vbr', '-cq', '23'] }; }
    else if (encoders.includes('h264_videotoolbox')) { _hwAccel = { enc: 'h264_videotoolbox', extra: ['-q:v', '65'] }; }
    else if (encoders.includes('h264_vaapi'))         { _hwAccel = { enc: 'h264_vaapi',        extra: ['-qp', '23']  }; }
    else { _hwAccel = { enc: 'libx264', extra: ['-preset', 'fast', '-crf', '23'] }; }
  } catch { _hwAccel = { enc: 'libx264', extra: ['-preset', 'fast', '-crf', '23'] }; }
  console.log(`🎬 Caption encoder: ${_hwAccel.enc}`);
  return _hwAccel;
}

// ── Caption style definitions ─────────────────────────────────────────────
const STYLES = {
  // Classic bold white — safe, readable, works everywhere
  bold: {
    fontName: 'Arial', fontSize: 20,
    primary: '&H00FFFFFF', outline: '&H00000000', back: '&H80000000',
    bold: -1, outlineW: 3, shadow: 1.2, alignment: 2, marginV: 65,
    effect: (txt) => `{\\an2\\fad(80,60)\\blur1}${txt}`,
  },
  // MrBeast — big yellow Impact, massive outline, pure energy
  mrbeast: {
    fontName: 'Impact', fontSize: 26,
    primary: '&H0000FFFF', outline: '&H00000000', back: '&HA0000000',
    bold: -1, outlineW: 5, shadow: 2, alignment: 2, marginV: 55,
    effect: (txt) => `{\\an2\\fad(60,40)\\blur0.5}${txt}`,
  },
  // Word-pop — each word pops in individually (most viral style 2024-25)
  wordpop: {
    fontName: 'Arial Black', fontSize: 22,
    primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000',
    bold: -1, outlineW: 4, shadow: 1.5, alignment: 2, marginV: 60,
    perWord: true, // triggers word-by-word dialogue lines
    effect: (txt) => `{\\an2\\fad(0,40)\\t(0,80,\\fscx110\\fscy110)\\t(80,160,\\fscx100\\fscy100)}${txt}`,
  },
  // Subtitles with highlight — active word turns yellow
  karaoke: {
    fontName: 'Arial', fontSize: 18,
    primary: '&H00FFFFFF', secondary: '&H000088FF', outline: '&H00000000', back: '&H80000000',
    bold: -1, outlineW: 2.5, shadow: 1, alignment: 2, marginV: 70,
    effect: (txt) => `{\\an2\\fad(100,80)}${txt}`,
  },
  // Minimal clean — thin font, subtle outline, creator/educational vibe
  minimal: {
    fontName: 'Helvetica Neue', fontSize: 16,
    primary: '&H00FFFFFF', outline: '&H90000000', back: '&H00000000',
    bold: 0, outlineW: 1.5, shadow: 0, alignment: 2, marginV: 80,
    effect: (txt) => `{\\an2\\fad(120,100)}${txt}`,
  },
  // Neon glow — bright green, blurred glow, gaming/tech niche
  neon: {
    fontName: 'Arial', fontSize: 21,
    primary: '&H0000FF88', outline: '&H00003300', back: '&H00000000',
    bold: -1, outlineW: 2, shadow: 4, alignment: 2, marginV: 58,
    effect: (txt) => `{\\an2\\fad(80,60)\\blur2.5\\shad4}${txt}`,
  },
  // Fire mode — red-to-orange gradient feel, hype content
  fire: {
    fontName: 'Impact', fontSize: 24,
    primary: '&H000055FF', outline: '&H00000022', back: '&H00000000',
    bold: -1, outlineW: 4, shadow: 2.5, alignment: 2, marginV: 58,
    effect: (txt) => `{\\an2\\fad(50,40)\\blur0.8\\3c&H000000FF&}${txt}`,
  },
};

// ── ASS file generator ────────────────────────────────────────────────────
function generateASS(words, styleName, clipDuration) {
  const s = STYLES[styleName] || STYLES.bold;

  const header = `[Script Info]
Title: ClipSpeedAI
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primary},${s.secondary || s.primary},${s.outline},${s.back},${s.bold},0,0,0,100,100,0.3,0,1,${s.outlineW},${s.shadow},${s.alignment},40,40,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (!words || words.length === 0) return header;

  let dialogues = '';

  if (s.perWord) {
    // Word-pop: each word gets its own timed line (most viral)
    for (const w of words) {
      const start = formatASSTime(Math.max(0, w.start));
      const end   = formatASSTime(Math.min(clipDuration || 9999, w.end + 0.08));
      const txt   = s.effect(w.word.toUpperCase());
      dialogues  += `Dialogue: 0,${start},${end},Default,,0,0,0,,${txt}\n`;
    }
  } else {
    // Chunk mode: 3-word groups (all other styles)
    const CHUNK = 3;
    for (let i = 0; i < words.length; i += CHUNK) {
      const chunk = words.slice(i, i + CHUNK);
      if (!chunk.length) continue;
      const text  = chunk.map(w => w.word).join(' ').toUpperCase();
      const start = formatASSTime(Math.max(0, chunk[0].start));
      const end   = formatASSTime(Math.min(clipDuration || 9999, chunk[chunk.length - 1].end + 0.12));
      dialogues  += `Dialogue: 0,${start},${end},Default,,0,0,0,,${s.effect(text)}\n`;
    }
  }

  return header + dialogues;
}

function formatASSTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// ── Core burn function (single clip) ─────────────────────────────────────
function burnCaptions(clipPath, assPath, outputPath) {
  return new Promise((resolve, reject) => {
    const hw  = detectHWAccel();
    const esc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

    const args = [
      '-y', '-i', clipPath,
      '-vf', `ass='${esc}'`,
      '-c:v', hw.enc, ...hw.extra,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    const ff = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
    ff.on('error', reject);
  });
}

// ── Watermark (free tier) ─────────────────────────────────────────────────
function addWatermarkSingle(clipPath, outputPath) {
  return new Promise((resolve, reject) => {
    const hw  = detectHWAccel();
    // Semi-transparent badge bottom-right — clean, not intrusive
    const vf = [
      "drawtext=text='ClipSpeedAI'",
      "fontsize=26",
      "fontcolor=white@0.40",
      "x=w-tw-28",
      "y=h-th-28",
      "font=Arial",
      "borderw=1.5",
      "bordercolor=black@0.25",
    ].join(':');

    const args = [
      '-y', '-i', clipPath,
      '-vf', vf,
      '-c:v', hw.enc, ...hw.extra,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];

    const ff = spawn('ffmpeg', args, { stdio: 'pipe' });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`watermark ffmpeg exit ${code}: ${stderr.slice(-200)}`));
    });
    ff.on('error', reject);
  });
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Add captions to a single clip.
 * @param {string} clipPath         - Input video path
 * @param {Array}  transcriptWords  - [{word, start, end}, ...]
 * @param {string} style            - bold | mrbeast | wordpop | karaoke | minimal | neon | fire
 * @param {string} clipId
 * @param {string} projectId
 * @param {number} clipDuration     - seconds (for clamping end times)
 * @returns {Promise<string>}       - output path
 */
async function addCaptions(clipPath, transcriptWords, style = 'bold', clipId, projectId, clipDuration) {
  console.log(`💬 Captioning clip ${clipId} [${style}]...`);

  const dir = path.join(CAPTIONS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });

  const assPath    = path.join(dir, `clip_${clipId}.ass`);
  const outputPath = clipPath.replace('.mp4', '_captioned.mp4');

  fs.writeFileSync(assPath, generateASS(transcriptWords, style, clipDuration));

  try {
    await burnCaptions(clipPath, assPath, outputPath);
    console.log(`  ✓ Captioned clip ${clipId}`);
    return outputPath;
  } catch (err) {
    console.error(`  ✗ Caption burn failed ${clipId}: ${err.message}`);
    return clipPath; // fail-open: return original so job doesn't die
  } finally {
    try { fs.unlinkSync(assPath); } catch {}
  }
}

/**
 * Add captions to multiple clips in parallel (MAX_PARALLEL at a time).
 * @param {Array} clips - [{ clipPath, words, style, clipId, projectId, duration }, ...]
 * @returns {Promise<Array>} - same order, each item { clipId, captionedPath }
 */
async function addCaptionsBatch(clips) {
  console.log(`💬 Captioning ${clips.length} clips (${MAX_PARALLEL} parallel)...`);
  const results = new Array(clips.length);

  for (let i = 0; i < clips.length; i += MAX_PARALLEL) {
    const batch = clips.slice(i, i + MAX_PARALLEL);
    const done  = await Promise.all(
      batch.map(async (c, bi) => {
        const out = await addCaptions(c.clipPath, c.words, c.style, c.clipId, c.projectId, c.duration);
        return { clipId: c.clipId, captionedPath: out };
      })
    );
    done.forEach((r, bi) => { results[i + bi] = r; });
  }

  return results;
}

/**
 * Add watermark to a single clip (free tier).
 */
async function addWatermark(clipPath, clipId, projectId) {
  console.log(`💧 Watermarking clip ${clipId}...`);
  const outputPath = clipPath.replace('.mp4', '_watermarked.mp4');
  try {
    await addWatermarkSingle(clipPath, outputPath);
    console.log(`  ✓ Watermarked clip ${clipId}`);
    return outputPath;
  } catch (err) {
    console.error(`  ✗ Watermark failed ${clipId}: ${err.message}`);
    return clipPath;
  }
}

/**
 * Add watermark to multiple clips in parallel.
 */
async function addWatermarkBatch(clips) {
  return Promise.all(
    clips.map(c => addWatermark(c.clipPath, c.clipId, c.projectId))
  );
}

module.exports = { addCaptions, addCaptionsBatch, addWatermark, addWatermarkBatch, STYLES };
