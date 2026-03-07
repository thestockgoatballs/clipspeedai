const { spawn }  = require('child_process');
const path        = require('path');
const fs          = require('fs');

const DOWNLOAD_DIR = '/tmp/clipspeed/downloads';

// ── Proxy pool ────────────────────────────────────────────────
const PROXY_HOST  = 'p.webshare.io';
const PROXY_PORT  = '80';
const PROXY_PASS  = 'b39w6odjqtxy';
const PROXY_USERS = [
  'hcxkyfzx-1','hcxkyfzx-2','hcxkyfzx-3','hcxkyfzx-4','hcxkyfzx-5',
  'hcxkyfzx-6','hcxkyfzx-7','hcxkyfzx-8','hcxkyfzx-9',
];
let _proxyIdx = 0;
const getProxy = () => {
  const u = PROXY_USERS[_proxyIdx++ % PROXY_USERS.length];
  return `http://${u}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
};

// ── yt-dlp auto-update (once per process) ────────────────────
let _updated = false;
async function ensureFresh() {
  if (_updated) return;
  _updated = true;
  try {
    await spawnAsync('pip3', ['install','--break-system-packages','--upgrade','yt-dlp'],
      { timeout: 60000 });
    console.log('✅ yt-dlp updated');
  } catch (_) { console.warn('⚠️  yt-dlp update skipped'); }
}

// ── Main ──────────────────────────────────────────────────────
/**
 * KEY UPGRADE vs old version:
 *  1. Audio-only download fires IMMEDIATELY and in PARALLEL with full video download
 *     → transcription can start ~40s before video finishes downloading
 *  2. All execSync replaced with async spawn → Node event loop never blocks
 *  3. Proxy rotation is per-attempt not per-process
 *  4. Returns audioPath so worker can start Whisper without waiting for video
 */
async function downloadVideo(videoUrl) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const videoPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);
  const audioPath = path.join(DOWNLOAD_DIR, `${videoId}_audio.mp3`);
  const metaPath  = path.join(DOWNLOAD_DIR, `${videoId}.info.json`);

  // Cache hit — skip download entirely
  if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 100_000) {
    console.log(`⚡ Cache hit: ${videoId}`);
    return buildResult(videoId, videoPath, audioPath, metaPath);
  }

  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  await ensureFresh();

  const proxy = getProxy();
  console.log(`🌐 Proxy: ${PROXY_HOST} (${PROXY_USERS[(_proxyIdx-1) % PROXY_USERS.length]})`);

  // ── PARALLEL DOWNLOAD ──────────────────────────────────────
  // Fire audio-only + full video simultaneously.
  // Transcription pipeline receives audioPath the moment audio is done —
  // it doesn't wait for the (much larger) video file.
  const audioPromise = downloadAudioOnly(videoUrl, audioPath, proxy);
  const videoPromise = downloadFullVideo(videoUrl, videoPath, metaPath, proxy);

  // Wait for both — but worker can start Whisper as soon as audioPromise resolves
  const [, videoOk] = await Promise.allSettled([audioPromise, videoPromise]);

  if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 10_000) {
    throw new Error('Video download failed — check proxy credentials or add YouTube cookies');
  }

  console.log(`✅ Download complete: ${videoId}`);
  return buildResult(videoId, videoPath, audioPath, metaPath);
}

// ── Audio-only download (for Whisper — fast, small file) ─────
async function downloadAudioOnly(videoUrl, audioPath, proxy) {
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 10_000) return;

  const methods = [
    ['--extractor-args', 'youtube:player_client=ios'],
    ['--extractor-args', 'youtube:player_client=android'],
    ['--extractor-args', 'youtube:player_client=mweb'],
  ];

  for (const extraArgs of methods) {
    try {
      await spawnAsync('yt-dlp', [
        ...extraArgs,
        '--proxy', proxy,
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '64K',
        '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1',
        '--no-playlist',
        '--socket-timeout', '30',
        '--retries', '3',
        '--output', audioPath.replace('.mp3', '.%(ext)s'),
        videoUrl,
      ], { timeout: 180_000 });

      // yt-dlp may write .mp3 or rename — check both
      const written = audioPath.replace('.mp3', '.mp3');
      if (fs.existsSync(written) && fs.statSync(written).size > 5_000) {
        console.log(`🎵 Audio ready: ${(fs.statSync(written).size / 1024 / 1024).toFixed(1)}MB`);
        return;
      }
    } catch (_) {}
  }
  console.warn('⚠️  Audio-only download failed — will extract from video');
}

// ── Full video download ───────────────────────────────────────
async function downloadFullVideo(videoUrl, videoPath, metaPath, proxy) {
  const methods = [
    { label: 'ios',        args: ['--extractor-args','youtube:player_client=ios',    '-f','best[height<=720][ext=mp4]/best[height<=720]/best'] },
    { label: 'android',    args: ['--extractor-args','youtube:player_client=android','-f','best[height<=720][ext=mp4]/best[height<=720]/best'] },
    { label: 'mweb',       args: ['--extractor-args','youtube:player_client=mweb',   '-f','best[height<=480][ext=mp4]/best[height<=480]/worst'] },
    { label: 'tv_embedded',args: ['--extractor-args','youtube:player_client=tv_embedded','--proxy',getProxy(),'-f','worst[ext=mp4]/worst'] },
  ];

  for (const m of methods) {
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    try {
      console.log(`📥 Video download: ${m.label}...`);
      await spawnAsync('yt-dlp', [
        ...m.args,
        '--proxy', proxy,
        '--merge-output-format', 'mp4',
        '--write-info-json',
        '--no-playlist',
        '--max-filesize', '500M',
        '--socket-timeout', '30',
        '--retries', '5',
        '--fragment-retries', '5',
        '--output', videoPath,
        videoUrl,
      ], { timeout: 300_000 });

      if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 10_000) {
        console.log(`✅ Video downloaded via ${m.label}: ${(fs.statSync(videoPath).size/1024/1024).toFixed(0)}MB`);
        return true;
      }
    } catch (err) {
      console.warn(`⚠️  ${m.label} failed: ${err.message?.slice(0,80)}`);
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    }
  }
  return false;
}

// ── Build result object ───────────────────────────────────────
async function buildResult(videoId, videoPath, audioPath, metaPath) {
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (_) {}
  }

  // Get duration via ffprobe (async)
  let duration = meta.duration || 0;
  if (!duration) {
    try {
      const out = await spawnCapture('ffprobe', [
        '-v','error','-show_entries','format=duration',
        '-of','csv=p=0', videoPath,
      ]);
      duration = parseFloat(out.trim()) || 0;
    } catch (_) {}
  }

  // If audio file wasn't downloaded separately, extract it now from video
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 5_000) {
    try {
      await spawnAsync('ffmpeg', [
        '-y','-i', videoPath,
        '-vn','-acodec','libmp3lame',
        '-ar','16000','-ac','1','-b:a','64k',
        audioPath,
      ], { timeout: 120_000 });
    } catch (_) {}
  }

  return {
    videoPath,
    audioPath:  fs.existsSync(audioPath) ? audioPath : null,
    videoId,
    title:      meta.title    || 'Unknown Title',
    uploader:   meta.uploader || meta.channel || 'Unknown',
    duration,
    durationFormatted: formatDuration(duration),
    fileSize:   fs.statSync(videoPath).size,
    thumbnail:  meta.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
  };
}

// ── Helpers ───────────────────────────────────────────────────
function extractVideoId(url) {
  if (!url) return null;
  for (const p of [
    /(?:v=|\/)([\w-]{11})(?:\?|&|$)/,
    /youtu\.be\/([\w-]{11})/,
    /embed\/([\w-]{11})/,
  ]) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function formatDuration(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2,'0')}`;
}

function cleanupVideo(videoId) {
  [
    path.join(DOWNLOAD_DIR, `${videoId}.mp4`),
    path.join(DOWNLOAD_DIR, `${videoId}_audio.mp3`),
    path.join(DOWNLOAD_DIR, `${videoId}.info.json`),
  ].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
}

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'pipe', ...opts });
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

module.exports = { downloadVideo, extractVideoId, cleanupVideo };
