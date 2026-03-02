const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CAPTIONS_DIR = '/tmp/clipspeed/captions';

/**
 * Generates ASS subtitle file from transcript words
 * and burns captions onto the clip using FFmpeg
 */
async function addCaptions(clipPath, transcriptWords, style = 'bold', clipId, projectId) {
  console.log(`💬 Adding captions to clip ${clipId} (${style} style)...`);

  const projectDir = path.join(CAPTIONS_DIR, projectId);
  fs.mkdirSync(projectDir, { recursive: true });

  const assPath = path.join(projectDir, `clip_${clipId}.ass`);
  const outputPath = clipPath.replace('.mp4', '_captioned.mp4');

  // Generate ASS subtitle file
  const assContent = generateASS(transcriptWords, style);
  fs.writeFileSync(assPath, assContent);

  // Burn subtitles onto video with FFmpeg
  try {
    // Escape path for FFmpeg filter
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    
    execSync([
      'ffmpeg', '-y',
      '-i', `"${clipPath}"`,
      '-vf', `"ass='${escapedAss}'"`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      `"${outputPath}"`
    ].join(' '), { timeout: 60000, stdio: 'pipe', shell: true });

    console.log(`  ✓ Captions burned onto clip ${clipId}`);
    return outputPath;

  } catch (err) {
    console.error(`  ✗ Caption burn failed for clip ${clipId}: ${err.message}`);
    return clipPath; // Return original if captioning fails
  }
}

/**
 * Generates ASS (Advanced SubStation Alpha) subtitle content
 * Supports multiple caption styles
 */
function generateASS(words, style = 'bold') {
  const styles = {
    bold: {
      fontName: 'Arial',
      fontSize: 18,
      primaryColor: '&H00FFFFFF', // white
      outlineColor: '&H00000000', // black outline
      outline: 3,
      shadow: 1,
      bold: -1,
      alignment: 2, // bottom center
      marginV: 60,
    },
    mrbeast: {
      fontName: 'Impact',
      fontSize: 22,
      primaryColor: '&H0000FFFF', // yellow
      outlineColor: '&H00000000',
      outline: 4,
      shadow: 2,
      bold: -1,
      alignment: 2,
      marginV: 50,
    },
    karaoke: {
      fontName: 'Arial',
      fontSize: 16,
      primaryColor: '&H00FFFFFF',
      secondaryColor: '&H000088FF', // highlight color (orange)
      outlineColor: '&H00000000',
      outline: 2,
      shadow: 1,
      bold: -1,
      alignment: 2,
      marginV: 70,
    },
    minimal: {
      fontName: 'Helvetica',
      fontSize: 14,
      primaryColor: '&H00FFFFFF',
      outlineColor: '&H80000000', // semi-transparent
      outline: 1,
      shadow: 0,
      bold: 0,
      alignment: 2,
      marginV: 80,
    },
    neon: {
      fontName: 'Arial',
      fontSize: 20,
      primaryColor: '&H0000FF88', // green neon
      outlineColor: '&H00004400',
      outline: 2,
      shadow: 3,
      bold: -1,
      alignment: 2,
      marginV: 55,
    },
  };

  const s = styles[style] || styles.bold;

  let ass = `[Script Info]
Title: ClipSpeedAI Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.secondaryColor || s.primaryColor},${s.outlineColor},&H80000000,${s.bold},0,0,0,100,100,0,0,1,${s.outline},${s.shadow},${s.alignment},40,40,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  if (!words || words.length === 0) return ass;

  // Group words into 3-4 word chunks for display
  const chunks = [];
  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3);
    if (chunk.length === 0) continue;
    chunks.push({
      text: chunk.map(w => w.word).join(' ').toUpperCase(),
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
  }

  // Generate dialogue lines
  for (const chunk of chunks) {
    const startTime = formatASSTime(chunk.start);
    const endTime = formatASSTime(chunk.end + 0.1); // slight overlap
    
    if (style === 'karaoke') {
      // Word-by-word highlight effect
      ass += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,{\\an2\\fad(100,100)}${chunk.text}\n`;
    } else {
      ass += `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,{\\an2\\fad(80,80)}${chunk.text}\n`;
    }
  }

  return ass;
}

function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

module.exports = { addCaptions };

/**
 * Adds ClipSpeedAI watermark overlay to a clip (for free tier users)
 * Semi-transparent text in bottom-right corner
 */
async function addWatermark(clipPath, clipId, projectId) {
  console.log(`💧 Adding watermark to clip ${clipId}...`);
  
  const outputPath = clipPath.replace('.mp4', '_watermarked.mp4');
  
  try {
    const cmd = [
      'ffmpeg', '-y',
      '-i', `"${clipPath}"`,
      '-vf', '"drawtext=text=ClipSpeedAI:fontsize=28:fontcolor=white@0.35:x=w-tw-30:y=h-th-30:font=Arial:borderw=1:bordercolor=black@0.2"',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      `"${outputPath}"`
    ].join(' ');

    require('child_process').execSync(cmd, { timeout: 60000, stdio: 'pipe', shell: true });
    console.log(`  ✓ Watermark added to clip ${clipId}`);
    return outputPath;
  } catch (err) {
    console.error(`  ✗ Watermark failed for clip ${clipId}: ${err.message}`);
    return clipPath; // Return original if watermark fails
  }
}

module.exports.addWatermark = addWatermark;
