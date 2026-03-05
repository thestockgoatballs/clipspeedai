const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIPS_DIR = '/tmp/clipspeed/clips';

/**
 * Detect which horizontal zone has the most motion (= who is talking)
 * Splits video into left/center/right thirds and measures motion in each
 */
function detectActiveSpeakerZone(videoPath, startSeconds, duration) {
  try {
    const sampleDur = Math.min(duration, 20);
    const tmpBase = `/tmp/clipspeed/motion_${Date.now()}`;

    // Extract a short sample at low res for speed
    const samplePath = `${tmpBase}_sample.mp4`;
    execSync(
      `ffmpeg -y -ss ${startSeconds} -t ${sampleDur} -i "${videoPath}" ` +
      `-vf "scale=360:-2,fps=5" -an -c:v libx264 -preset ultrafast -crf 35 "${samplePath}" 2>/dev/null`,
      { timeout: 30000, stdio: 'pipe', shell: true }
    );

    // Measure motion energy in left third
    const leftOut = execSync(
      `ffmpeg -y -i "${samplePath}" -vf "crop=iw/3:ih:0:0,mestimate,metadata=print:file=-" -f null - 2>&1 | grep "motion_est" | head -20 || echo "0"`,
      { encoding: 'utf-8', timeout: 15000, stdio: 'pipe', shell: true }
    ).trim();

    // Measure motion energy in right third  
    const rightOut = execSync(
      `ffmpeg -y -i "${samplePath}" -vf "crop=iw/3:ih:2*iw/3:0,mestimate,metadata=print:file=-" -f null - 2>&1 | grep "motion_est" | head -20 || echo "0"`,
      { encoding: 'utf-8', timeout: 15000, stdio: 'pipe', shell: true }
    ).trim();

    // Count motion frames in each zone
    const leftMotion  = (leftOut.match(/motion_est/g)  || []).length;
    const rightMotion = (rightOut.match(/motion_est/g) || []).length;

    // Clean up
    try { fs.unlinkSync(samplePath); } catch (e) {}

    console.log(`  📊 Motion scores — left: ${leftMotion}, right: ${rightMotion}`);

    // If one side has significantly more motion, crop there
    if (leftMotion > rightMotion * 1.3)  return 'left';
    if (rightMotion > leftMotion * 1.3)  return 'right';
    return 'center'; // similar motion = use center (solo speaker or equal activity)

  } catch (e) {
    console.warn('  ⚠️ Motion detection failed, using center:', e.message?.slice(0, 60));
    return 'center';
  }
}

/**
 * Convert zone to ffmpeg crop x expression
 */
function buildCropFilter(zone) {
  const cropW = 'ih*9/16'; // width of 9:16 crop
  let xExpr;
  switch (zone) {
    case 'left':   xExpr = `(iw-${cropW})*0.15`; break; // bias toward left person
    case 'right':  xExpr = `(iw-${cropW})*0.85`; break; // bias toward right person
    default:       xExpr = `(iw-${cropW})/2`;    break; // center
  }
  return `crop=${cropW}:ih:${xExpr}:0,scale=1080:1920:flags=lanczos`;
}

/**
 * Cuts video into clips with smart speaker-tracking crop
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
      // Detect active speaker zone for this clip
      console.log(`  🎯 Detecting speaker for clip ${clip.id}...`);
      const zone = detectActiveSpeakerZone(videoPath, clip.startSeconds, duration);
      console.log(`  👤 Active speaker zone: ${zone}`);

      const cropFilter = buildCropFilter(zone);

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

      // Thumbnail with same crop
      const thumbTime = (clip.startSeconds + duration / 2).toFixed(2);
      const thumbCrop = cropFilter.replace('scale=1080:1920', 'scale=540:960');
      execSync(
        `ffmpeg -y -ss ${thumbTime} -i "${videoPath}" -vf "${thumbCrop}" -frames:v 1 -q:v 3 "${thumbPath}"`,
        { timeout: 15000, stdio: 'pipe', shell: true }
      );

      const stats = fs.statSync(outputPath);
      results.push({
        clipId:    clip.id,
        clipPath:  outputPath,
        thumbPath: fs.existsSync(thumbPath) ? thumbPath : null,
        fileSize:  stats.size,
        success:   true,
      });
      console.log(`  ✓ Clip ${clip.id}: ${(stats.size / 1024 / 1024).toFixed(1)}MB (${duration.toFixed(1)}s) [${zone}]`);

    } catch (err) {
      console.error(`  ✗ Clip ${clip.id} failed: ${err.message?.slice(0, 120)}`);
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
