const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOWNLOAD_DIR = '/tmp/clipspeed/downloads';

/**
 * Downloads a YouTube video using yt-dlp
 * Returns path to downloaded .mp4 file and video metadata
 */
async function downloadVideo(videoUrl) {
  // Ensure download directory exists
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  
  // Extract video ID for filename
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const outputPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);
  const metaPath = path.join(DOWNLOAD_DIR, `${videoId}.info.json`);

  // Skip download if file already exists (cache)
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    console.log(`⚡ Video already cached: ${videoId}`);
  } else {
    console.log(`📥 Downloading video: ${videoUrl}`);
    
    // yt-dlp command:
    // -f "bv*[height<=1080]+ba/b[height<=1080]" = best video up to 1080p + best audio
    // --merge-output-format mp4 = output as .mp4
    // --write-info-json = save metadata
    // --no-playlist = don't download playlists
    // --max-filesize 500M = safety limit
    const cmd = [
      'yt-dlp',
      '--extractor-args', '"youtube:player_client=web,mediaconnect"',
      '-f', '"bv*[height<=1080]+ba/b[height<=1080]"',      '--merge-output-format', 'mp4',
      '--write-info-json',
      '--no-playlist',
      '--max-filesize', '500M',
      '--socket-timeout', '30',
      '--retries', '3',
      '-o', outputPath,
      `"${videoUrl}"`
    ].join(' ');

    try {
      execSync(cmd, { 
        timeout: 300000, // 5 min timeout
        stdio: 'pipe',
        shell: true 
      });
    } catch (err) {
      // Clean up partial download
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      throw new Error(`Download failed: ${err.message}`);
    }
  }

  // Read metadata
  let metadata = {};
  if (fs.existsSync(metaPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (e) { /* ignore parse errors */ }
  }

  // Get video duration using ffprobe
  let duration = 0;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    duration = parseFloat(probe) || 0;
  } catch (e) { /* ignore */ }

  const fileSize = fs.statSync(outputPath).size;

  return {
    videoPath: outputPath,
    videoId,
    title: metadata.title || 'Unknown Title',
    uploader: metadata.uploader || metadata.channel || 'Unknown',
    duration, // in seconds
    durationFormatted: formatDuration(duration),
    fileSize,
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

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Clean up downloaded video file
 */
function cleanupVideo(videoId) {
  const files = [
    path.join(DOWNLOAD_DIR, `${videoId}.mp4`),
    path.join(DOWNLOAD_DIR, `${videoId}.info.json`),
  ];
  files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
}

module.exports = { downloadVideo, extractVideoId, cleanupVideo };
