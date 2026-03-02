const { uploadClip, uploadThumbnail } = require('../lib/r2');
const fs = require('fs');

/**
 * Uploads all processed clips and thumbnails to R2 storage
 * Returns array of public URLs for each clip
 */
async function uploadClips(cutResults, projectId) {
  console.log(`☁️ Uploading ${cutResults.length} clips to R2 storage...`);

  const uploaded = [];

  for (const result of cutResults) {
    if (!result.success || !result.clipPath) {
      uploaded.push({ clipId: result.clipId, videoUrl: null, thumbnailUrl: null });
      continue;
    }

    try {
      // Prefer: watermarked > captioned > original
      const watermarkedPath = result.watermarkedPath;
      const captionedPath = result.captionedPath || result.clipPath.replace('.mp4', '_captioned.mp4');
      let uploadPath = result.clipPath;
      if (watermarkedPath && fs.existsSync(watermarkedPath)) uploadPath = watermarkedPath;
      else if (fs.existsSync(captionedPath)) uploadPath = captionedPath;

      // Upload video clip
      const videoUrl = await uploadClip(uploadPath, projectId, result.clipId);

      // Upload thumbnail if it exists
      let thumbnailUrl = null;
      if (result.thumbPath && fs.existsSync(result.thumbPath)) {
        thumbnailUrl = await uploadThumbnail(result.thumbPath, projectId, result.clipId);
      }

      uploaded.push({
        clipId: result.clipId,
        videoUrl,
        thumbnailUrl,
        fileSize: fs.statSync(uploadPath).size,
      });

      console.log(`  ✓ Clip ${result.clipId} uploaded: ${videoUrl}`);

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
