const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIPS_DIR = '/tmp/clipspeed/clips';

/**
 * Detect the best crop X position by sampling frames and finding
 * where faces/motion are concentrated — left, center, or right third.
 * Returns a crop x-offset as a fraction of video width (0.0 to ~0.55 for 9:16 crop)
 */
function detectSpeakerCropX(videoPath, startSeconds, duration) {
  try {
    // Sample 6 frames spread across the clip
    const tmpDir = '/tmp/clipspeed/facedetect';
    fs.mkdirSync(tmpDir, { recursive: true });
    const sampleBase = path.join(tmpDir, `sample_${Date.now()}`);

    // Extract 6 sample frames
    execSync(
      `ffmpeg -y -ss ${startSeconds} -t ${Math.min(duration, 30)} -i "${videoPath}" ` +
      `-vf "fps=0.2,scale=320:-1" -frames:v 6 "${sampleBase}_%02d.jpg" 2>/dev/null`,
      { timeout: 15000, stdio: 'pipe', shell: true }
    );

    // Use ffprobe to get video dimensions
    const probeOut = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const [vidW, vidH] = probeOut.split(',').map(Number);

    if (!vidW || !vidH) return 0.5; // fallback to center

    // Use ffmpeg's signalstats/edge detection on sample frames to find motion zones
    // We'll measure average brightness in left/center/right thirds of each frame
    const frames = fs.readdirSync(tmpDir).filter(f => f.startsWith(path.basename(sampleBase)));

    let leftScore = 0, centerScore = 0, rightScore = 0;

    for (const frame of frames) {
      const framePath = path.join(tmpDir, frame);
      try {
        // Measure mean brightness in left third
        const left = execSync(
          `ffprobe -v error -select_streams v -show_entries frame_tags=lavfi.signalstats.YAVG ` +
          `-f lavfi "movie=${framePath},crop=iw/3:ih:0:0,signalstats" 2>/dev/null || echo "0"`,
          { encoding: 'utf-8', timeout: 5000, shell: true }
        ).trim();
        const center = execSync(
          `ffprobe -v error -select_streams v -show_entries frame_tags=lavfi.signalstats.YAVG ` +
          `-f lavfi "movie=${framePath},crop=iw/3:ih:iw/3:0,signalstats" 2>/dev/null || echo "0"`,
          { encoding: 'utf-8', timeout: 5000, shell: true }
        ).trim();
        const right = execSync(
          `ffprobe -v error -select_streams v -show_entries frame_tags=lavfi.signalstats.YAVG ` +
          `-f lavfi "movie=${framePath},crop=iw/3:ih:2*iw/3:0,signalstats" 2>/dev/null || echo "0"`,
          { encoding: 'utf-8', timeout: 5000, shell: true }
        ).trim();

        leftScore   += parseFloat(left.split('\n').find(l => l.includes('YAVG'))?.split('=')[1] || 0);
        centerScore += parseFloat(center.split('\n').find(l => l.includes('YAVG'))?.split('=')[1] || 0);
        rightScore  += parseFloat(right.split('\n').find(l => l.includes('YAVG'))?.split('=')[1] || 0);
      } catch (e) {}
      try { fs.unlinkSync(framePath); } catch (e) {}
    }

    // Determine which third has the most "content" (brightest = most face/skin)
    // For podcast setups: pick the dominant zone
    const max = Math.max(leftScore, centerScore, rightScore);
    if (max === 0) return 0.5; // fallback center

    // Convert zone to crop x fraction
    // 9:16 crop width = ih * 9/16, so x offset = (vidW - cropW) * fraction
    if (leftScore === max)   return 0.05;  // crop toward left speaker
    if (rightScore === max)  return 0.95;  // crop toward right speaker
    return 0.5;                            // center

  } catch (e) {
    console.warn('⚠️ Speaker detection failed, using center crop:', e.message?.slice(0, 80));
    return 0.5; // safe fallback
  }
}

/**
 * Build the ffmpeg crop filter string for speaker-aware 9:16 framing
 * xFraction: 0.05=left, 0.5=center, 0.95=right
 */
function buildCropFilter(xFraction) {
  // cropW = ih * 9/16
  // x = (iw - cropW) * xFraction  →  expressed as ffmpeg math
  const xExpr = xFraction === 0.5
    ? '(iw-ih*9/16)/2'                          // center
    : xFraction < 0.5
      ? `(iw-ih*9/16)*${xFraction.toFixed(3)}`  // left-biased
      : `(iw-ih*9/16)*${xFraction.toFixed(3)}`; // right-biased
  return `crop=ih*9/16:ih:${xExpr}:0,scale=1080:1920:flags=lanczos`;
}

/**
 * Cuts a video into individual clips using FFmpeg with smart speaker tracking
 */
async function cutClips(videoPath, clips, projectId) {
  console.log(`✂️ Cutting ${clips.length} clips from video...`);
  const projectDir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const results = [];

  for (const clip of clips) {
    const outputPath = path.join(projectDir, `clip_${clip.id}.mp4`);
    const thumbPath  = path.join(projectDir, `thumb_${clip.id}.jpg`);
    const duration   = clip.endSeconds - clip.startSeconds;

    try {
      // Detect where the active speaker is in this clip
      console.log(`  🎯 Detecting speaker position for clip ${clip.id}...`);
      const xFraction = detectSpeakerCropX(videoPath, clip.startSeconds, duration);
      const position  = xFraction < 0.3 ? 'left' : xFraction > 0.7 ? 'right' : 'center';
      console.log(`  👤 Speaker detected: ${position} (x=${xFraction.toFixed(2)})`);

      const cropFilter = buildCropFilter(xFraction);

      const cmd = [
        'ffmpeg', '-y',
        '-ss', clip.startSeconds.toFixed(2),
        '-i', `"${videoPath}"`,
        '-t', duration.toFixed(2),
        '-vf', `"${cropFilter}"`,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
        `"${outputPath}"`
      ].join(' ');

      execSync(cmd, { timeout: 120000, stdio: 'pipe', shell: true });

      // Thumbnail using same crop
      const thumbTime = (clip.startSeconds + duration / 2).toFixed(2);
      const thumbCrop = cropFilter.replace('scale=1080:1920', 'scale=540:960');
      execSync(
        `ffmpeg -y -ss ${thumbTime} -i "${videoPath}" -vf "${thumbCrop}" -frames:v 1 -q:v 3 "${thumbPath}"`,
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
      console.log(`  ✓ Clip ${clip.id}: ${(stats.size / 1024 / 1024).toFixed(1)}MB (${duration.toFixed(1)}s) [${position}]`);

    } catch (err) {
      console.error(`  ✗ Clip ${clip.id} failed: ${err.message}`);
      results.push({ clipId: clip.id, clipPath: null, thumbPath: null, fileSize: 0, success: false, error: err.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`✅ Cut ${successCount}/${clips.length} clips successfully`);
  return results;
}

/**
 * Cuts a clip keeping original aspect ratio (widescreen)
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

function cleanupClips(projectId) {
  const dir = path.join(CLIPS_DIR, projectId);
  try { fs.rmSync(dir, { recursive: true }); } catch (e) {}
}

module.exports = { cutClips, cutClipWidescreen, cleanupClips };
