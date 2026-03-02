const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || 'clipspeedai';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

async function uploadFile(localPath, remotePath, contentType = 'video/mp4') {
  const fileBuffer = fs.readFileSync(localPath);
  
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: remotePath,
    Body: fileBuffer,
    ContentType: contentType,
  }));

  return `${PUBLIC_URL}/${remotePath}`;
}

async function uploadClip(localPath, projectId, clipNumber) {
  const remotePath = `clips/${projectId}/clip_${clipNumber}.mp4`;
  return uploadFile(localPath, remotePath, 'video/mp4');
}

async function uploadThumbnail(localPath, projectId, clipNumber) {
  const remotePath = `thumbs/${projectId}/clip_${clipNumber}.jpg`;
  return uploadFile(localPath, remotePath, 'image/jpeg');
}

async function deleteProject(projectId) {
  // Delete all files for a project (clips + thumbnails)
  // In production, list and delete all objects with prefix
  console.log(`Deleting files for project ${projectId}`);
}

module.exports = { uploadClip, uploadThumbnail, deleteProject };
