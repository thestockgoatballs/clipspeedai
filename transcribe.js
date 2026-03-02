const OpenAI = require('openai');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribes video audio using OpenAI Whisper API
 * Returns transcript with word-level timestamps
 */
async function transcribeVideo(videoPath) {
  console.log('🎤 Transcribing audio...');

  // Step 1: Extract audio from video using ffmpeg
  const audioPath = videoPath.replace('.mp4', '.mp3');
  
  execSync(
    `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -ar 16000 -ac 1 -b:a 64k "${audioPath}"`,
    { timeout: 120000, stdio: 'pipe' }
  );

  const audioSize = fs.statSync(audioPath).size;
  console.log(`🎵 Audio extracted: ${(audioSize / 1024 / 1024).toFixed(1)}MB`);

  // Step 2: If audio > 25MB (Whisper limit), split into chunks
  if (audioSize > 24 * 1024 * 1024) {
    return transcribeLargeFile(audioPath);
  }

  // Step 3: Send to Whisper API with word timestamps
  const response = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    language: 'en',
  });

  // Clean up audio file
  try { fs.unlinkSync(audioPath); } catch (e) {}

  // Process response into our format
  const segments = (response.segments || []).map(seg => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
    words: (seg.words || []).map(w => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })),
  }));

  return {
    fullText: response.text,
    segments,
    language: response.language || 'en',
    duration: response.duration || 0,
  };
}

/**
 * Handles files > 25MB by splitting into chunks
 */
async function transcribeLargeFile(audioPath) {
  console.log('📏 Audio too large, splitting into chunks...');
  
  const chunkDir = audioPath.replace('.mp3', '_chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  // Split into 10-minute chunks with 5-second overlap
  execSync(
    `ffmpeg -y -i "${audioPath}" -f segment -segment_time 600 -c copy "${chunkDir}/chunk_%03d.mp3"`,
    { timeout: 60000, stdio: 'pipe' }
  );

  const chunks = fs.readdirSync(chunkDir).filter(f => f.endsWith('.mp3')).sort();
  let allSegments = [];
  let fullText = '';
  let timeOffset = 0;

  for (const chunk of chunks) {
    const chunkPath = path.join(chunkDir, chunk);
    
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
    });

    const segments = (response.segments || []).map(seg => ({
      start: seg.start + timeOffset,
      end: seg.end + timeOffset,
      text: seg.text.trim(),
      words: (seg.words || []).map(w => ({
        word: w.word,
        start: w.start + timeOffset,
        end: w.end + timeOffset,
      })),
    }));

    allSegments.push(...segments);
    fullText += ' ' + response.text;
    timeOffset += 600; // 10 minutes per chunk
  }

  // Clean up
  try { fs.rmSync(chunkDir, { recursive: true }); } catch (e) {}
  try { fs.unlinkSync(audioPath); } catch (e) {}

  return {
    fullText: fullText.trim(),
    segments: allSegments,
    language: 'en',
    duration: timeOffset,
  };
}

module.exports = { transcribeVideo };
