const { uploadClip, uploadThumbnail } = require('../lib/r2');
const fs = require('fs');

/**
 * Uploads all processed clips and thumbnails to R2 storage.
 * Returns array of { clipId, videoUrl, thumbnailUrl } for each clip.
 */
async function uploadClips(cutResults, projectId) {
  console.log(`☁️  Uploading ${cutResults.length} clips to R2...`);
  const uploaded = [];

  for (const result of cutResults) {
    if (!result.success || !result.clipPath) {
      uploaded.push({ clipId: result.clipId, videoUrl: null, thumbnailUrl: null });
      continue;
    }

    try {
      // Prefer: watermarked > captioned/enhanced > original
      let uploadPath = result.clipPath;
      if (result.watermarkedPath && fs.existsSync(result.watermarkedPath)) {
        uploadPath = result.watermarkedPath;
      } else if (result.captionedPath && fs.existsSync(result.captionedPath)) {
        uploadPath = result.captionedPath;
      }

      // Upload video
      const videoUrl = await uploadClip(uploadPath, projectId, result.clipId);

      // Upload thumbnail — worker sets result.thumbnailPath
      let thumbnailUrl = null;
      if (result.thumbnailPath && fs.existsSync(result.thumbnailPath)) {
        thumbnailUrl = await uploadThumbnail(result.thumbnailPath, projectId, result.clipId);
      }

      uploaded.push({
        clipId: result.clipId,
        videoUrl,
        thumbnailUrl,
        fileSize: fs.statSync(uploadPath).size,
      });

      console.log(`  ✓ Clip ${result.clipId} uploaded${thumbnailUrl ? ' + thumbnail' : ''}`);
    } catch (err) {
      console.error(`  ✗ Upload failed for clip ${result.clipId}: ${err.message}`);
      uploaded.push({ clipId: result.clipId, videoUrl: null, thumbnailUrl: null });
    }
  }

  const successCount = uploaded.filter(u => u.videoUrl).length;
  console.log(`✅ Uploaded ${successCount}/${cutResults.length} clips to R2`);
  return uploaded;
}

module.exports = { uploadClips };
