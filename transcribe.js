const OpenAI  = require('openai');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_DIR     = '/tmp/clipspeed/chunks';
const CHUNK_SECONDS = 540;   // 9-min chunks (under Whisper's 25MB limit with headroom)
const OVERLAP_SEC   = 4;     // 4s overlap to catch words at boundaries
const MAX_PARALLEL  = 5;     // fire 5 Whisper calls simultaneously

/**
 * KEY UPGRADES vs old version:
 *  1. Uses pre-extracted audioPath from download.js (skips re-extraction)
 *  2. Chunks transcribed IN PARALLEL (up to 5 simultaneous Whisper calls)
 *     → 60-min video: was 6 serial calls (~90s) → now parallel (~15s)
 *  3. Overlap deduplication prevents doubled words at chunk boundaries
 *  4. All execSync replaced with async spawn
 */
async function transcribeVideo(videoPath, audioPath = null) {
  console.log('🎤 Transcribing audio...');
  fs.mkdirSync(CHUNK_DIR, { recursive: true });

  // Use pre-extracted audio if available (saves 10-20s)
  let workingAudio = audioPath;

  if (!workingAudio || !fs.existsSync(workingAudio) || fs.statSync(workingAudio).size < 5_000) {
    console.log('🎵 Extracting audio from video...');
    workingAudio = videoPath.replace(/\.[^.]+$/, '_audio.mp3');
    await spawnAsync('ffmpeg', [
      '-y', '-i', videoPath,
      '-vn', '-acodec', 'libmp3lame',
      '-ar', '16000', '-ac', '1', '-b:a', '64k',
      workingAudio,
    ], { timeout: 120_000 });
  } else {
    console.log(`🎵 Using pre-extracted audio (${(fs.statSync(workingAudio).size/1024/1024).toFixed(1)}MB)`);
  }

  const audioSize = fs.statSync(workingAudio).size;
  const WHISPER_LIMIT = 24 * 1024 * 1024; // 24MB

  let result;
  if (audioSize <= WHISPER_LIMIT) {
    // Single call — fast path
    result = await transcribeSingle(workingAudio);
  } else {
    // Parallel chunked transcription
    result = await transcribeParallel(workingAudio, audioSize);
  }

  // Clean up extracted audio (not the pre-extracted one from download)
  if (!audioPath || workingAudio !== audioPath) {
    try { fs.unlinkSync(workingAudio); } catch (_) {}
  }

  console.log(`✅ Transcribed: ${result.segments.length} segments, ${result.fullText.length} chars`);
  return result;
}

// ── Single Whisper call (videos < ~45 min) ────────────────────
async function transcribeSingle(audioPath) {
  const response = await openai.audio.transcriptions.create({
    file:                    fs.createReadStream(audioPath),
    model:                   'whisper-1',
    response_format:         'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    language:                'en',
  });

  return formatResponse(response, 0);
}

// ── Parallel chunked transcription (videos > ~45 min) ─────────
async function transcribeParallel(audioPath, audioSize) {
  console.log(`📏 Large audio (${(audioSize/1024/1024).toFixed(0)}MB) — splitting for parallel transcription...`);

  // Get audio duration
  const duration = await getAudioDuration(audioPath);
  const chunkCount = Math.ceil(duration / CHUNK_SECONDS);
  console.log(`📦 ${chunkCount} chunks × ${CHUNK_SECONDS}s — firing ${Math.min(chunkCount, MAX_PARALLEL)} in parallel`);

  // Generate chunk time ranges
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = Math.max(0, i * CHUNK_SECONDS - (i > 0 ? OVERLAP_SEC : 0));
    const end   = Math.min(duration, (i + 1) * CHUNK_SECONDS + OVERLAP_SEC);
    chunks.push({ index: i, start, end, duration: end - start, timeOffset: i * CHUNK_SECONDS });
  }

  // Process in batches of MAX_PARALLEL
  const allSegments = new Array(chunkCount);
  const allTexts    = new Array(chunkCount);

  for (let i = 0; i < chunks.length; i += MAX_PARALLEL) {
    const batch = chunks.slice(i, i + MAX_PARALLEL);
    console.log(`  ⚡ Batch ${Math.floor(i/MAX_PARALLEL)+1}: chunks ${i+1}-${Math.min(i+MAX_PARALLEL, chunks.length)}`);

    await Promise.all(batch.map(async (chunk) => {
      const chunkPath = path.join(CHUNK_DIR, `chunk_${Date.now()}_${chunk.index}.mp3`);
      try {
        // Extract chunk
        await spawnAsync('ffmpeg', [
          '-y',
          '-ss', chunk.start.toFixed(3),
          '-t',  chunk.duration.toFixed(3),
          '-i',  audioPath,
          '-acodec', 'libmp3lame',
          '-ar', '16000', '-ac', '1', '-b:a', '64k',
          chunkPath,
        ], { timeout: 60_000 });

        if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size < 1_000) {
          throw new Error(`Chunk ${chunk.index} extraction produced empty file`);
        }

        // Transcribe chunk
        const response = await openai.audio.transcriptions.create({
          file:                    fs.createReadStream(chunkPath),
          model:                   'whisper-1',
          response_format:         'verbose_json',
          timestamp_granularities: ['word', 'segment'],
          language:                'en',
        });

        const formatted = formatResponse(response, chunk.timeOffset);
        allSegments[chunk.index] = formatted.segments;
        allTexts[chunk.index]    = response.text;

      } catch (err) {
        console.error(`  ✗ Chunk ${chunk.index} failed: ${err.message}`);
        allSegments[chunk.index] = [];
        allTexts[chunk.index]    = '';
      } finally {
        try { fs.unlinkSync(chunkPath); } catch (_) {}
      }
    }));
  }

  // Merge and deduplicate overlapping words at chunk boundaries
  const mergedSegments = deduplicateOverlap(allSegments.flat(), OVERLAP_SEC);
  const fullText       = allTexts.filter(Boolean).join(' ').trim();

  return {
    fullText,
    segments: mergedSegments,
    language: 'en',
    duration,
  };
}

// ── Format Whisper response into our schema ───────────────────
function formatResponse(response, timeOffset) {
  const segments = (response.segments || []).map(seg => ({
    start: seg.start + timeOffset,
    end:   seg.end   + timeOffset,
    text:  seg.text.trim(),
    words: (seg.words || []).map(w => ({
      word:  w.word,
      start: w.start + timeOffset,
      end:   w.end   + timeOffset,
    })),
  }));

  return {
    fullText: response.text || '',
    segments,
    language: response.language || 'en',
    duration: response.duration || 0,
  };
}

// ── Remove duplicate words caused by chunk overlap ────────────
function deduplicateOverlap(segments, overlapSec) {
  if (!segments.length) return segments;

  const result = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const curr = segments[i];
    // Skip segment if it overlaps significantly with previous
    if (curr.start < prev.end - 0.1) continue;
    result.push(curr);
  }
  return result;
}

// ── Get audio duration ────────────────────────────────────────
async function getAudioDuration(audioPath) {
  try {
    const out = await spawnCapture('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      audioPath,
    ]);
    return parseFloat(out.trim()) || 600;
  } catch (_) { return 600; }
}

// ── Async spawn helpers ───────────────────────────────────────
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'pipe' });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)));
    p.on('error', reject);
    if (opts.timeout) setTimeout(() => { p.kill(); reject(new Error(`${cmd} timed out`)); }, opts.timeout);
  });
}

function spawnCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'pipe' });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.slice(-200))));
    p.on('error', reject);
  });
}

module.exports = { transcribeVideo };
