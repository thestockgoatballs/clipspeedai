const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const fs = require('fs');

// ── Validate env vars on startup ──────────────────────────────────────────
const REQUIRED = {
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY:  process.env.R2_ACCESS_KEY,
  R2_SECRET_KEY:  process.env.R2_SECRET_KEY,
  R2_BUCKET:      process.env.R2_BUCKET,
  R2_PUBLIC_URL:  process.env.R2_PUBLIC_URL,
};
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('❌ R2 MISSING ENV VARS:', missing.join(', '));
} else {
  console.log('✅ R2 credentials loaded OK');
}

// ── TLS agent that forces TLS 1.2+ and disables session reuse ────────────
const tlsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  rejectUnauthorized: true,
  keepAlive: false,
});

// ── S3 Client ─────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
  requestHandler: {
    httpsAgent: tlsAgent,
  },
  forcePathStyle: false,
});

const BUCKET     = process.env.R2_BUCKET      || 'clipspeedai';
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

// ── Core upload ───────────────────────────────────────────────────────────
async function uploadFile(localPath, remotePath, contentType = 'video/mp4') {
  if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);

  const fileBuffer = fs.readFileSync(localPath);
  console.log(`☁️  Uploading ${remotePath} (${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB)...`);

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         remotePath,
    Body:        fileBuffer,
    ContentType: contentType,
  }));

  const url = `${PUBLIC_URL}/${remotePath}`;
  console.log(`✅ Uploaded: ${url}`);
  return url;
}

// ── Public helpers ────────────────────────────────────────────────────────
async function uploadClip(localPath, projectId, clipNumber) {
  const remotePath = `clips/${projectId}/clip_${clipNumber}.mp4`;
  return uploadFile(localPath, remotePath, 'video/mp4');
}

async function uploadThumbnail(localPath, projectId, clipNumber) {
  const remotePath = `thumbs/${projectId}/clip_${clipNumber}.jpg`;
  return uploadFile(localPath, remotePath, 'image/jpeg');
}

async function deleteProject(projectId) {
  console.log(`🗑️  Deleting files for project ${projectId}`);
}

module.exports = { uploadClip, uploadThumbnail, deleteProject };
