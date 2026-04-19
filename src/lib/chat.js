// Live chat listeners for Twitch (IRC over WebSocket) and Kick (Pusher over WebSocket).
// Runs during recording, feeds a "spam intensity" heatmap that the library
// tab overlays onto the video scrubber.

const WebSocket = require('ws');
const fs = require('fs');
const fetch = require('node-fetch');

// Words / emotes that correlate with "something clip-worthy just happened".
// Tweak freely — this is intentionally inclusive of caps and repeats.
const SPAM_PATTERNS = [
  /\bLUL\b/i, /\bLULW\b/i, /\bOMEGALUL\b/i, /\bKEKW\b/i,
  /\bPOG(GERS)?\b/i, /\bPOGU\b/i,
  /\bW\b/, /\b(W{2,}|L{2,})\b/,
  /\bLMAO+\b/i, /\bLOL+\b/i, /\bXD+\b/i,
  /\bOMG+\b/i, /\bHOLY\s*SHIT\b/i, /\bNOO+\b/i, /\bWHAT\??!?\b/i,
  /\bCLIP\s*(IT|THIS)\b/i
];

const BUCKET_MS = 30 * 1000; // 30s heatmap resolution

function classify(message) {
  let intensity = 0;
  for (const re of SPAM_PATTERNS) if (re.test(message)) intensity++;
  // Cap-heavy messages get a small boost — streamers usually react to those
  if (message.length >= 3 && message === message.toUpperCase()) intensity += 0.5;
  return intensity;
}

// ---------- Twitch ----------

function connectTwitch(channel, onIntensity, onStatus) {
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`);
    ws.send(`JOIN #${channel.toLowerCase()}`);
    onStatus?.({ connected: true });
  });
  ws.on('message', (data) => {
    const raw = data.toString();
    if (raw.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); return; }
    const lines = raw.split('\r\n');
    for (const line of lines) {
      const m = line.match(/PRIVMSG #\S+ :(.*)$/);
      if (!m) continue;
      const msg = m[1].trim();
      const intensity = classify(msg);
      if (intensity > 0) onIntensity(intensity, msg);
    }
  });
  ws.on('close', () => onStatus?.({ connected: false }));
  ws.on('error', (e) => onStatus?.({ error: e.message }));
  return ws;
}

// ---------- Kick ----------
// Kick chat rides on Pusher. We need the chatroom id for a given slug,
// which is available from their REST endpoint.

async function kickChatroomId(slug) {
  const res = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { 'User-Agent': 'Parasite/0.1 (+https://parasitebrands.com)' }
  });
  if (!res.ok) throw new Error(`Kick channel lookup failed: ${res.status}`);
  const json = await res.json();
  return json?.chatroom?.id;
}

async function connectKick(channel, onIntensity, onStatus) {
  const chatroomId = await kickChatroomId(channel);
  if (!chatroomId) throw new Error(`Could not resolve Kick chatroom for ${channel}`);
  const url = 'wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.0.3&flash=false';
  const ws = new WebSocket(url);
  ws.on('open', () => {
    ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: `chatrooms.${chatroomId}.v2` } }));
    onStatus?.({ connected: true });
  });
  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.event !== 'App\\Events\\ChatMessageEvent') return;
      const payload = JSON.parse(frame.data || '{}');
      const msg = (payload?.content || '').trim();
      const intensity = classify(msg);
      if (intensity > 0) onIntensity(intensity, msg);
    } catch { /* ignore malformed frames */ }
  });
  ws.on('close', () => onStatus?.({ connected: false }));
  ws.on('error', (e) => onStatus?.({ error: e.message }));
  return ws;
}

// ---------- Recorder ----------
// Aggregates intensity into 30s buckets, persists a JSON heatmap file.

function createRecorder({ service, channel, heatmapPath, onBucketUpdate }) {
  const startMs = Date.now();
  const buckets = new Map();
  let ws = null;

  const addIntensity = (intensity) => {
    const offset = Date.now() - startMs;
    const b = Math.floor(offset / BUCKET_MS);
    buckets.set(b, (buckets.get(b) || 0) + intensity);
    onBucketUpdate?.(serialize());
  };

  const serialize = () => ({
    service, channel, startMs, bucketMs: BUCKET_MS,
    buckets: Array.from(buckets.entries()).map(([b, v]) => ({ t: b * BUCKET_MS, v }))
  });

  (async () => {
    try {
      if (service === 'twitch')    ws = connectTwitch(channel, addIntensity);
      else if (service === 'kick') ws = await connectKick(channel, addIntensity);
    } catch (e) {
      console.error('[chat] connect failed:', e.message);
    }
  })();

  return {
    stop() {
      try { ws?.close(); } catch {}
      try { fs.writeFileSync(heatmapPath, JSON.stringify(serialize(), null, 2)); } catch {}
      return heatmapPath;
    },
    snapshot: serialize
  };
}

module.exports = { createRecorder, SPAM_PATTERNS, BUCKET_MS };
