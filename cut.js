const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIPS_DIR = '/tmp/clipspeed/clips';

/**
 * Cuts a video into individual clips using FFmpeg
 * Each clip is a real .mp4 file at the exact timestamps
 */
async function cutClips(videoPath, clips, projectId) {
  console.log(`✂️ Cutting ${clips.length} clips from video...`);

  const projectDir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const results = [];

  for (const clip of clips) {
    const outputPath = path.join(projectDir, `clip_${clip.id}.mp4`);
    const thumbPath = path.join(projectDir, `thumb_${clip.id}.jpg`);
    
    try {
      // Cut clip with re-encoding for clean cuts and 9:16 vertical crop
      // -ss before -i for fast seeking
      // -t for duration
      // Video filter: crop to 9:16, scale to 1080x1920
      const duration = clip.endSeconds - clip.startSeconds;
      
      const cmd = [
        'ffmpeg', '-y',
        '-ss', clip.startSeconds.toFixed(2),
        '-i', `"${videoPath}"`,
        '-t', duration.toFixed(2),
        // Video: crop center to 9:16, scale to 1080x1920
        '-vf', '"crop=ih*9/16:ih,scale=1080:1920:flags=lanczos"',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart', // for web streaming
        '-avoid_negative_ts', 'make_zero',
        `"${outputPath}"`
      ].join(' ');

      execSync(cmd, { timeout: 60000, stdio: 'pipe', shell: true });

      // Generate thumbnail from middle of clip
      const thumbTime = (clip.startSeconds + duration / 2).toFixed(2);
      execSync(
        `ffmpeg -y -ss ${thumbTime} -i "${videoPath}" -vf "crop=ih*9/16:ih,scale=540:960" -frames:v 1 -q:v 3 "${thumbPath}"`,
        { timeout: 15000, stdio: 'pipe', shell: true }
      );

      const stats = fs.statSync(outputPath);
      
      results.push({
        clipId: clip.id,
        clipPath: outputPath,
        thumbPath: fs.existsSync(thumbPath) ? thumbPath : null,
        fileSize: stats.size,
        success: true,
      });

      console.log(`  ✓ Clip ${clip.id}: ${(stats.size / 1024 / 1024).toFixed(1)}MB (${duration.toFixed(1)}s)`);

    } catch (err) {
      console.error(`  ✗ Clip ${clip.id} failed: ${err.message}`);
      results.push({
        clipId: clip.id,
        clipPath: null,
        thumbPath: null,
        fileSize: 0,
        success: false,
        error: err.message,
      });
    }
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`✅ Cut ${successCount}/${clips.length} clips successfully`);

  return results;
}

/**
 * Cuts a clip keeping original aspect ratio (for preview/widescreen)
 */
async function cutClipWidescreen(videoPath, clip, projectId) {
  const projectDir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  
  const outputPath = path.join(projectDir, `clip_${clip.id}_wide.mp4`);
  const duration = clip.endSeconds - clip.startSeconds;

  execSync([
    'ffmpeg', '-y',
    '-ss', clip.startSeconds.toFixed(2),
    '-i', `"${videoPath}"`,
    '-t', duration.toFixed(2),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    `"${outputPath}"`
  ].join(' '), { timeout: 60000, stdio: 'pipe', shell: true });

  return outputPath;
}

/**
 * Clean up clips for a project
 */
function cleanupClips(projectId) {
  const dir = path.join(CLIPS_DIR, projectId);
  try { fs.rmSync(dir, { recursive: true }); } catch (e) {}
}

module.exports = { cutClips, cutClipWidescreen, cleanupClips };
