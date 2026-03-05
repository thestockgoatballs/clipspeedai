const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOWNLOAD_DIR = '/tmp/clipspeed/downloads';

// Auto-update yt-dlp once per process lifetime so Railway never runs stale version
let _ytdlpUpdated = false;
function ensureYtdlpFresh() {
  if (_ytdlpUpdated) return;
  try {
    console.log('🔄 Updating yt-dlp to latest...');
    execSync('pip3 install --break-system-packages --upgrade yt-dlp', {
      timeout: 60000, stdio: 'pipe'
    });
    console.log('✅ yt-dlp updated');
  } catch (e) {
    console.warn('⚠️ yt-dlp update failed (continuing anyway):', e.message?.slice(0, 100));
  }
  _ytdlpUpdated = true;
}

async function downloadVideo(videoUrl) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);
  const metaPath   = path.join(DOWNLOAD_DIR, `${videoId}.info.json`);

  // Cache hit
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100000) {
    console.log(`⚡ Cache hit: ${videoId}`);
  } else {
    // Clean any partial file
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    // Always run with latest yt-dlp
    ensureYtdlpFresh();

    const baseFlags = [
      '--merge-output-format mp4',
      '--write-info-json',
      '--no-playlist',
      '--max-filesize 500M',
      '--socket-timeout 30',
      '--retries 5',
      '--fragment-retries 5',
      `--output "${outputPath}"`,
    ].join(' ');

    // 4 methods, each trying a different client/format strategy
    const methods = [
      // Method 1 — iOS client (most reliable, bypasses bot check)
      {
        label: 'ios client',
        cmd: `yt-dlp --extractor-args "youtube:player_client=ios" -f "best[height<=720][ext=mp4]/best[height<=720]/best" ${baseFlags} "${videoUrl}"`,
      },
      // Method 2 — android client
      {
        label: 'android client',
        cmd: `yt-dlp --extractor-args "youtube:player_client=android" -f "best[height<=720][ext=mp4]/best[height<=720]/best" ${baseFlags} "${videoUrl}"`,
      },
      // Method 3 — mweb client with age-gate bypass
      {
        label: 'mweb client',
        cmd: `yt-dlp --extractor-args "youtube:player_client=mweb" -f "best[height<=480][ext=mp4]/best[height<=480]/worst" ${baseFlags} "${videoUrl}"`,
      },
      // Method 4 — tv_embedded client, lowest quality, last resort
      {
        label: 'tv_embedded fallback',
        cmd: `yt-dlp --extractor-args "youtube:player_client=tv_embedded" -f "worst[ext=mp4]/worst" --no-write-info-json --socket-timeout 60 --retries 10 --output "${outputPath}" "${videoUrl}"`,
      },
    ];

    let succeeded = false;
    for (const method of methods) {
      try {
        console.log(`📥 Trying ${method.label}...`);
        execSync(method.cmd, { timeout: 300000, stdio: 'pipe', shell: true });
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
          console.log(`✅ Downloaded via ${method.label}`);
          succeeded = true;
          break;
        }
      } catch (err) {
        console.warn(`⚠️ ${method.label} failed:`, err.message?.slice(0, 120));
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      }
    }

    if (!succeeded) {
      throw new Error('All download methods failed — YouTube may be blocking this IP. Try adding cookies.');
    }
  }

  // Read metadata
  let metadata = {};
  if (fs.existsSync(metaPath)) {
    try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch (e) {}
  }

  // Get duration via ffprobe
  let duration = 0;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    duration = parseFloat(probe) || 0;
  } catch (e) {}

  return {
    videoPath: outputPath,
    videoId,
    title:     metadata.title    || 'Unknown Title',
    uploader:  metadata.uploader || metadata.channel || 'Unknown',
    duration,
    durationFormatted: formatDuration(duration),
    fileSize:  fs.statSync(outputPath).size,
    thumbnail: metadata.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
  };
}

function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/)([\w-]{11})(?:\?|&|$)/,
    /youtu\.be\/([\w-]{11})/,
    /embed\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function formatDuration(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function cleanupVideo(videoId) {
  [
    path.join(DOWNLOAD_DIR, `${videoId}.mp4`),
    path.join(DOWNLOAD_DIR, `${videoId}.info.json`),
  ].forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
}

module.exports = { downloadVideo, extractVideoId, cleanupVideo };
