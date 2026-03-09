const { uploadClip, uploadThumbnail } = require('../lib/r2');
const fs = require('fs');

const MAX_UPLOAD_RETRIES = 2;

// ═══════════════════════════════════════════════════════════════
// Upload all processed clips + thumbnails to R2
// Uses the captioned path if available, falls back to raw clip
// Retries each upload independently — one failure won't kill others
// ═══════════════════════════════════════════════════════════════
async function uploadClips(cutResults, projectId) {
  const startTime = Date.now();
  const total = cutResults.filter(r => r.success).length;
  console.log(`☁️ Uploading ${total} clips to R2...`);

  const uploaded = [];

  for (const result of cutResults) {
    if (!result.success) {
      uploaded.push({ clipId: result.clipId, videoUrl: null, thumbnailUrl: null });
      continue;
    }

    // Find the best version: watermarked > captioned > raw
    const uploadPath = findBestClipPath(result);

    if (!uploadPath) {
      console.warn(`  ⚠️ Clip ${result.clipId}: no valid file to upload`);
      uploaded.push({ clipId: result.clipId, videoUrl: null, thumbnailUrl: null });
      continue;
    }

    // Upload video with retry
    let videoUrl = null;
    for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
      try {
        videoUrl = await uploadClip(uploadPath, projectId, result.clipId);
        break;
      } catch (err) {
        console.warn(`  ⚠️ Upload clip ${result.clipId} attempt ${attempt}: ${err.message.slice(0, 60)}`);
        if (attempt < MAX_UPLOAD_RETRIES) {
          await sleep(1000 * attempt);
        }
      }
    }

    // Upload thumbnail with retry (non-blocking)
    let thumbnailUrl = null;
    const thumbPath = result.thumbPath || result.thumbnailPath;
    if (thumbPath && fs.existsSync(thumbPath)) {
      try {
        thumbnailUrl = await uploadThumbnail(thumbPath, projectId, result.clipId);
      } catch (err) {
        console.warn(`  ⚠️ Thumb upload failed clip ${result.clipId}: ${err.message.slice(0, 40)}`);
        // Non-fatal — clip still works without thumbnail
      }
    }

    const fileSize = fs.existsSync(uploadPath) ? fs.statSync(uploadPath).size : 0;
    const sizeMB   = (fileSize / 1048576).toFixed(1);

    uploaded.push({
      clipId:       result.clipId,
      videoUrl,
      thumbnailUrl,
      fileSize,
    });

    if (videoUrl) {
      console.log(`  ✓ Clip ${result.clipId}: ${sizeMB}MB → ${videoUrl.split('/').pop()}`);
    } else {
      console.error(`  ✗ Clip ${result.clipId}: upload failed after ${MAX_UPLOAD_RETRIES} attempts`);
    }
  }

  const successCount = uploaded.filter(u => u.videoUrl).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`✅ Upload complete: ${successCount}/${total} clips in ${elapsed}s`);

  return uploaded;
}

// ── Find best available clip file ─────────────────────────────
function findBestClipPath(result) {
  // Priority: watermarked > captioned > raw
  const candidates = [
    result.watermarkedPath,
    result.captionedPath,
    result.clipPath,
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.statSync(p).size > 10000) {
      return p;
    }
  }

  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { uploadClips };
