const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const STYLES = {
  bold: {
    fontName:'Arial', fontSize:60, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:4, shadow:1,
    inactive:{ color:'&H99FFFFFF', border:'&H99000000' },
    active:  { color:'&H00FFFFFF', border:'&H00000000' },
    activeScale:118, animMs:80,
  },
  highlight: {
    fontName:'Arial Black', fontSize:58, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:0, shadow:0,
    inactive:{ color:'&H00FFFFFF', border:'&H00000000' },
    active:  { color:'&H00000000', border:'&H00000000' },
    boxActive:true, boxColor:'&H000080FF', boxBorder:4,
    activeScale:100, animMs:0,
  },
  neon: {
    fontName:'Arial', fontSize:56, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:3, shadow:8,
    inactive:{ color:'&H5500FF88', border:'&H55006633' },
    active:  { color:'&H0000FF88', border:'&H0000FF44' },
    activeScale:112, animMs:60,
  },
  fire: {
    fontName:'Arial', fontSize:58, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:3, shadow:2,
    inactive:{ color:'&H9900AAFF', border:'&H99002255' },
    active:  { color:'&H000045FF', border:'&H000000CC' },
    activeScale:115, animMs:70,
  },
  minimal: {
    fontName:'Arial', fontSize:50, bold:false, uppercase:false, wordsPerLine:5,
    positionY:0.82, outline:1, shadow:0,
    inactive:{ color:'&H99FFFFFF', border:'&H66000000' },
    active:  { color:'&H00FFFFFF', border:'&H88000000' },
    activeScale:104, animMs:40,
  },
  shadow: {
    fontName:'Arial', fontSize:58, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:0, shadow:10,
    inactive:{ color:'&H88FFFFFF', border:'&H00000000' },
    active:  { color:'&H00FFFFFF', border:'&H00000000' },
    activeScale:120, animMs:80,
  },
  typewriter: {
    fontName:'Courier New', fontSize:52, bold:true, uppercase:false, wordsPerLine:4,
    positionY:0.80, outline:3, shadow:1,
    inactive:{ color:'&H00000000', border:'&H00000000' },
    active:  { color:'&H00FFFFFF', border:'&H00000000' },
    activeScale:100, animMs:0, typewriterMode:true,
  },
  hormone: {
    fontName:'Arial Black', fontSize:60, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:4, shadow:1,
    inactive:{ color:'&H00FFFFFF', border:'&H00000000' },
    active:  { color:'&H000080FF', border:'&H00000000' },
    alternateColor:'&H000045FF',
    activeScale:112, animMs:60,
  },
  cinematic: {
    fontName:'Georgia', fontSize:46, bold:false, uppercase:false, wordsPerLine:5,
    positionY:0.85, outline:0, shadow:3,
    inactive:{ color:'&H66FFFFFF', border:'&H00000000' },
    active:  { color:'&H00FFFFFF', border:'&H00000000' },
    spacing:3, activeScale:106, animMs:120,
  },
  gaming: {
    fontName:'Arial', fontSize:54, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.76, outline:3, shadow:0,
    inactive:{ color:'&H5500FF00', border:'&H55003300' },
    active:  { color:'&H0000FF00', border:'&H0000AA00' },
    activeScale:116, animMs:50,
  },
  wordpop: {
    fontName:'Arial', fontSize:60, bold:true, uppercase:true, wordsPerLine:3,
    positionY:0.78, outline:4, shadow:1,
    inactive:{ color:'&H99FFFFFF', border:'&H99000000' },
    active:  { color:'&H00FFFFFF', border:'&H00000000' },
    activeScale:118, animMs:80,
  },
};

const STYLE_ALIASES = {
  'Bold Word-by-Word':'bold', 'Neon Pop':'neon', 'Clean Minimal':'minimal',
  'Red Highlight':'highlight', 'Gold Luxury':'fire', 'Gaming HUD':'gaming',
  'MrBeast':'highlight', 'Typewriter':'typewriter', 'Hormone':'hormone',
  'Cinematic':'cinematic', 'Shadow Pop':'shadow', 'Fire':'fire', 'wordpop':'wordpop',
};

function resolveStyle(name) {
  const key = STYLE_ALIASES[name] || name || 'bold';
  return STYLES[key] || STYLES.bold;
}

/**
 * HARDWIRED WATERMARKS — DIAMOND EDITION
 * 1. Bottom: Kick-identical dark bar with KICK logo + KICK.COM/USERNAME
 * 2. Top right: ClipSpeedAI logo (big, professional)
 * Logos auto-downloaded from R2 on first use.
 * Applied to EVERY clip. ALL plans. No exceptions.
 */
const BRAND_LOGO_URL = 'https://pub-6640e445140f466bb23f48844b80c17d.r2.dev/ClipSpeed%20(1).png';
const KICK_LOGO_URL = 'https://pub-6640e445140f466bb23f48844b80c17d.r2.dev/Screenshot_2026-03-11_at_7.15.50_PM-removebg-preview.png';
const LOGO_DIR = '/tmp/clipspeed/watermarks';
let logosDownloaded = false;

function downloadLogos() {
  try {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const brandPath = path.join(LOGO_DIR, 'clipspeed-logo.png');
    const brandRaw = path.join(LOGO_DIR, 'clipspeed-logo-raw.png');
    const kickPath = path.join(LOGO_DIR, 'kick-logo.png');
    // Always re-download brand logo to pick up updates
    try {
      execSync(`curl -s -o "${brandRaw}" "${BRAND_LOGO_URL}"`, { timeout: 15000 });
      // Strip white/light background — make it transparent using ffmpeg colorkey
      try {
        execSync(`ffmpeg -y -i "${brandRaw}" -vf "colorkey=0xFFFFFF:0.2:0.1" "${brandPath}" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' });
      } catch(e2) {
        // If colorkey fails, try with different similarity
        try {
          execSync(`ffmpeg -y -i "${brandRaw}" -vf "colorkey=0xE5E5E5:0.25:0.15" "${brandPath}" 2>/dev/null`, { timeout: 10000, stdio: 'pipe' });
        } catch(e3) {
          // Fall back to raw file
          if (fs.existsSync(brandRaw)) fs.copyFileSync(brandRaw, brandPath);
        }
      }
      if(!logosDownloaded) console.log('  ✅ ClipSpeedAI logo downloaded + bg removed');
    } catch(e) {}
    if (!fs.existsSync(kickPath) || fs.statSync(kickPath).size < 1000) {
      try { execSync(`curl -s -o "${kickPath}" "${KICK_LOGO_URL}"`, { timeout: 15000 }); if(!logosDownloaded) console.log('  ✅ Kick logo downloaded'); } catch(e) {}
    }
    logosDownloaded = true;
  } catch(e) {}
}

async function addWatermark(inputPath, outputPath, streamerName) {
  if (!inputPath || !fs.existsSync(inputPath)) { console.warn('  ⚠️ addWatermark: input not found'); return inputPath; }
  
  // Auto-download logos from R2 on first use
  downloadLogos();
  
  const fontPath = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';
  const fontFallback = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const font = fs.existsSync(fontPath) ? fontPath : fontFallback;
  const creator = (streamerName || 'Unknown').replace(/'/g, '').toUpperCase();

  const brandLogo = path.join(LOGO_DIR, 'clipspeed-logo.png');
  const kickLogo = path.join(LOGO_DIR, 'kick-logo.png');
  const hasBrandLogo = fs.existsSync(brandLogo) && fs.statSync(brandLogo).size > 1000;
  const hasKickLogo = fs.existsSync(kickLogo) && fs.statSync(kickLogo).size > 1000;

  let cmd;

  if (hasBrandLogo && hasKickLogo) {
    // BOTH LOGOS — FINAL LAYOUT: Brand 540px top-right, Kick breaking bar, username 72pt centered
    cmd = `ffmpeg -y -i "${inputPath}" -i "${brandLogo}" -i "${kickLogo}" -filter_complex "` +
      // ClipSpeedAI logo — 540px wide (TRIPLED), top-right
      `[1:v]scale=540:-1[brand];` +
      // Kick logo — 480px wide, breaks above bar
      `[2:v]scale=480:-1[kick];` +
      // THICK dark bar — 192px (DOUBLED)
      `[0:v]drawbox=x=0:y=ih-192:w=iw:h=192:color=black@0.92:t=fill[base];` +
      // ClipSpeedAI logo top-right
      `[base][brand]overlay=main_w-overlay_w-10:4[wb];` +
      // Kick logo — pushed left, partially off-screen, breaks above bar
      `[wb][kick]overlay=-60:main_h-300[wk];` +
      // KICK.COM/USERNAME — right of kick logo, not centered
      `[wk]drawtext=fontfile='${font}':text='KICK.COM/${creator}':fontsize=48:fontcolor=white@0.98:x=320:y=h-130:shadowcolor=black@0.6:shadowx=3:shadowy=3` +
      `" -c:v libx264 -preset fast -crf 22 -c:a copy -movflags +faststart "${outputPath}"`;
  } else if (hasKickLogo) {
    // Kick logo + text ClipSpeedAI — same sizes
    cmd = `ffmpeg -y -i "${inputPath}" -i "${kickLogo}" -filter_complex "` +
      `[1:v]scale=480:-1[kick];` +
      `[0:v]drawbox=x=0:y=ih-192:w=iw:h=192:color=black@0.92:t=fill[base];` +
      `[base][kick]overlay=-60:main_h-300[wk];` +
      `[wk]drawtext=fontfile='${font}':text='KICK.COM/${creator}':fontsize=48:fontcolor=white@0.98:x=320:y=h-130:shadowcolor=black@0.6:shadowx=3:shadowy=3,` +
      `drawtext=fontfile='${font}':text='ClipSpeedAI':fontsize=44:fontcolor=white@0.9:x=w-tw-14:y=14:shadowcolor=black@0.8:shadowx=2:shadowy=2` +
      `" -c:v libx264 -preset fast -crf 22 -c:a copy -movflags +faststart "${outputPath}"`;
  } else {
    // TEXT-ONLY fallback — same sizes
    const vf = [
      `drawbox=x=0:y=ih-192:w=iw:h=192:color=black@0.92:t=fill`,
      `drawtext=fontfile='${font}':text='KICK.COM/${creator}':fontsize=72:fontcolor=0x53FC18@1.0:x=(w-tw)/2:y=h-130:shadowcolor=black@0.6:shadowx=3:shadowy=3`,
      `drawtext=fontfile='${font}':text='ClipSpeedAI':fontsize=44:fontcolor=white@0.9:x=w-tw-14:y=14:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
    ].join(',');
    cmd = `ffmpeg -y -i "${inputPath}" -vf "${vf}" -c:v libx264 -preset fast -crf 22 -c:a copy -movflags +faststart "${outputPath}"`;
  }

  try {
    execSync(cmd, { timeout: 180000, stdio: 'pipe', shell: true });
    console.log(`  🏷️ Watermarks: KICK.COM/${creator} (bottom) + ClipSpeedAI (top-right)${hasBrandLogo ? ' [LOGOS]' : hasKickLogo ? ' [KICK LOGO]' : ''}`);
    if (inputPath !== outputPath) safeDelete(inputPath);
    return outputPath;
  } catch (err) {
    console.warn(`  ⚠️ Watermark failed: ${(err.message || '').slice(0, 120)}`);
    return inputPath;
  }
}

async function addCaptions(arg1, arg2, arg3, arg4) {
  let clipPath, clipWords, styleName, clipId, clipResult;
  if (typeof arg1 === 'string') { clipPath = arg1; clipWords = arg2 || []; styleName = arg3 || 'bold'; clipId = arg4 || 0; clipResult = null; }
  else if (arg1 && typeof arg1 === 'object') {
    clipResult = arg1; const clip = arg2, transcript = arg3, opts = arg4 || {};
    if (!clipResult.success || !clipResult.clipPath) return clipResult;
    clipPath = clipResult.clipPath; clipId = clipResult.clipId || (clip && clip.id) || 0;
    styleName = opts.captionStyle || (clip && clip.captionStyle) || 'bold'; clipWords = [];
    if (transcript && transcript.words && clip) { for (const w of transcript.words) { if (w.start >= clip.startSeconds && w.end <= clip.endSeconds) { var clean = (w.word || '').replace(/^[,\.;:!?\-\—\–\"\']+/, '').replace(/[,\.;:!?\-\—\–\"\']+$/, '').replace(/[,\.;:!?\—\–\"\']/g, '').trim(); if (clean.length > 0) clipWords.push({ word: clean, start: w.start - clip.startSeconds, end: w.end - clip.startSeconds }); } } }
  } else { return arg1; }

  const style = resolveStyle(styleName);
  console.log(`  💬 Captioning clip ${clipId} [${styleName}] — ${clipWords.length} words`);
  if (!clipPath || !fs.existsSync(clipPath)) { console.log(`  ⚠️ Clip not found`); return clipResult || clipPath; }
  if (!clipWords.length) { console.log(`  ⚠️ No words for clip ${clipId}`); return clipResult || clipPath; }

  const dir = path.dirname(clipPath);
  const outputPath = path.join(dir, `captioned_clip_${clipId}.mp4`);
  const assPath = path.join(dir, `subs_${clipId}_${Date.now()}.ass`);

  let vw = 1080, vh = 1920;
  try { const dimOut = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${clipPath}"`, { timeout: 8000, stdio: 'pipe', shell: true }).toString().trim().split(','); vw = parseInt(dimOut[0]) || 1080; vh = parseInt(dimOut[1]) || 1920; } catch (_) {}

  fs.writeFileSync(assPath, buildASS(clipWords, style, vw, vh));

  try {
    const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    execSync(`ffmpeg -y -i "${clipPath}" -vf "ass=${assEsc}" -c:v libx264 -preset fast -crf 22 -c:a copy -movflags +faststart "${outputPath}"`, { timeout: 180000, stdio: 'pipe', shell: true });
    console.log(`  ✓ Captions done — clip ${clipId}`);
  } catch (err) { console.warn(`  ⚠️ Caption burn failed clip ${clipId}: ${(err.message || '').slice(0, 120)}`); safeDelete(assPath); return clipResult || clipPath; }

  safeDelete(assPath);
  if (clipPath !== outputPath) safeDelete(clipPath);
  if (clipResult) return { ...clipResult, clipPath: outputPath, fileSize: fs.statSync(outputPath).size, hasCaptions: true, captionStyle: styleName };
  return outputPath;
}

function buildASS(words, style, vw, vh) {
  const lines = groupIntoLines(words, style.wordsPerLine || 3);
  const posY = Math.round((style.positionY || 0.78) * vh);
  const fontSize = style.fontSize;
  const spacing = style.spacing || 0;
  const bold = style.bold ? -1 : 0;

  let ass = `[Script Info]\nTitle: ClipSpeedAI\nScriptType: v4.00+\nPlayResX: ${vw}\nPlayResY: ${vh}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
  ass += `Style: Inactive,${style.fontName},${fontSize},${style.inactive.color},&H000000FF,${style.inactive.border},&H80000000,${bold},0,0,0,100,100,${spacing},0,1,${style.outline},${style.shadow},2,30,30,${posY},1\n`;
  const activeFontSize = style.boxActive ? fontSize : Math.round(fontSize * (style.activeScale / 100));
  const activeBorderStyle = style.boxActive ? style.boxBorder : 1;
  const activeBackColor = style.boxActive ? style.boxColor : '&H00000000';
  ass += `Style: Active,${style.fontName},${activeFontSize},${style.active.color},&H000000FF,${style.active.border},${activeBackColor},${bold},0,0,0,100,100,${spacing},0,${activeBorderStyle},${style.outline},${style.shadow},2,30,30,${posY},1\n`;
  ass += `\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, Effect, Text\n`;

  for (const line of lines) {
    const lineStart = line.start; const lineEnd = line.end;
    if (style.typewriterMode) {
      for (let wi = 0; wi < line.words.length; wi++) {
        const visible = line.words.slice(0, wi + 1); const hidden = line.words.slice(wi + 1);
        const start = line.words[wi].start; const end = wi < line.words.length - 1 ? line.words[wi + 1].start : lineEnd;
        const text = [...visible.map(w => tag(style.active.color, style.active.border) + esc(fmt(w.word, style))), ...hidden.map(_ => '{\\alpha&HFF&}X{\\alpha&H00&}')].join(' ');
        ass += dlg(1, start, end, 'Active', `{\\an2\\pos(${Math.round(vw / 2)},${posY})}` + text);
      }
      continue;
    }
    // NO inactive background layer — only the Active layer with inline dimming
    // This prevents the double/ghost text billboard effect
    for (let wi = 0; wi < line.words.length; wi++) {
      const w = line.words[wi]; const wEnd = wi < line.words.length - 1 ? line.words[wi + 1].start : lineEnd;
      let tagged = line.words.map((x, xi) => {
        const t = esc(fmt(x.word, style));
        if (xi !== wi) return tag(style.inactive.color, style.inactive.border) + t;
        let activeCol = style.active.color;
        if (style.alternateColor && wi % 2 === 1) activeCol = style.alternateColor;
        if (style.boxActive) return `{\\c${activeCol}\\3c${style.active.border}\\bord3\\4c${style.boxColor}}` + t + `{\\c${style.inactive.color}\\3c${style.inactive.border}\\bord${style.outline}}`;
        const scalePeak = style.activeScale || 100; const ms = style.animMs || 80;
        if (scalePeak > 100 && ms > 0) { const half = Math.round(ms / 2); return `{\\c${activeCol}\\3c${style.active.border}\\fscx100\\fscy100\\t(0,${half},\\fscx${scalePeak}\\fscy${scalePeak})\\t(${half},${ms},\\fscx100\\fscy100)}` + t + `{\\c${style.inactive.color}\\3c${style.inactive.border}\\fscx100\\fscy100}`; }
        return `{\\c${activeCol}\\3c${style.active.border}}` + t + `{\\c${style.inactive.color}\\3c${style.inactive.border}}`;
      }).join(' ');
      ass += dlg(1, w.start, wEnd, 'Active', `{\\an2\\pos(${Math.round(vw / 2)},${posY})}` + tagged);
    }
  }
  return ass;
}

function groupIntoLines(words, n) { const lines = []; for (let i = 0; i < words.length; i += n) { const chunk = words.slice(i, i + n); lines.push({ words: chunk, start: chunk[0].start, end: chunk[chunk.length - 1].end }); } return lines; }
function fmt(word, style) { return style.uppercase ? word.toUpperCase() : word; }
function tag(color, border) { return `{\\c${color}\\3c${border}}`; }
function dlg(layer, start, end, styleName, text) { return `Dialogue: ${layer},${fmtT(start)},${fmtT(end)},${styleName},,0,0,0,,${text}\n`; }
function fmtT(s) { s = Math.max(0, s); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sc = Math.floor(s % 60); const cs = Math.floor((s % 1) * 100); return `${h}:${p(m)}:${p(sc)}.${p(cs)}`; }
function p(n) { return String(n).padStart(2, '0'); }
function esc(t) { return String(t).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N'); }
function safeDelete(f) { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} }

module.exports = { addCaptions, addWatermark, STYLES, STYLE_ALIASES };
