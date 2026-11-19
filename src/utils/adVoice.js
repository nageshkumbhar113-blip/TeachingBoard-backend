// 🗣️ Marathi voice-over for Ad Studio's script videos (owner 2026-11-19: "Edge चा मोफत मराठी आवाज चालेल").
// Admin only: one scene's line → an MP3 in Microsoft Edge's free Marathi voice (मनोहर / आरोही), at the
// speed the admin picks. Nothing about students goes out — only the ad's own words. Kept in memory a while,
// so trying the same line again is instant.
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICES = { manohar: 'mr-IN-ManoharNeural', aarohi: 'mr-IN-AarohiNeural' };
const MAX_LEN = 400;
const _cache = new Map();   // key → { at, buf }

function _key(text, voice, rate) { return `${voice}|${rate}|${text}`; }

async function speak(text, voice = 'manohar', rate = 0) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!t) { const e = new Error('बोलायला मजकूर नाही'); e.status = 400; throw e; }
  const v = VOICES[voice] ? voice : 'manohar';
  const r = Math.max(-40, Math.min(50, Math.round(Number(rate) || 0)));
  const key = _key(t, v, r);
  const hit = _cache.get(key);
  if (hit) return hit.buf;
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(VOICES[v], OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(t, { rate: `${r >= 0 ? '+' : ''}${r}%` });
    const buf = await new Promise((resolve, reject) => {
      const parts = [];
      const timer = setTimeout(() => reject(new Error('आवाज बनायला वेळ लागला — पुन्हा प्रयत्न करा')), 25000);
      audioStream.on('data', d => parts.push(d));
      audioStream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(parts)); });
      audioStream.on('error', err => { clearTimeout(timer); reject(err); });
    });
    if (!buf.length) throw new Error('आवाज आला नाही — पुन्हा प्रयत्न करा');
    _cache.set(key, { at: Date.now(), buf });
    if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
    return buf;
  } finally { try { tts.close(); } catch { /* already closed */ } }
}

module.exports = { speak, VOICES };
