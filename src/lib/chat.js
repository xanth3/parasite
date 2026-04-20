// Live chat listeners for Twitch (IRC over WebSocket) and Kick (Pusher over WebSocket).
// Runs during recording and feeds the shared heatmap accumulator.

const WebSocket = require('ws');
const fs = require('fs');
const fetch = require('node-fetch');

const {
  SPAM_PATTERNS,
  BUCKET_MS,
  HeatmapAccumulator,
  classifyMessage
} = require('./heatmap-core');

function connectTwitch(channel, onMessage, onStatus) {
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send(`NICK justinfan${Math.floor(Math.random() * 100000)}`);
    ws.send(`JOIN #${channel.toLowerCase()}`);
    onStatus?.({ connected: true });
  });
  ws.on('message', (data) => {
    const raw = data.toString();
    if (raw.startsWith('PING')) {
      ws.send('PONG :tmi.twitch.tv');
      return;
    }
    for (const line of raw.split('\r\n')) {
      const match = line.match(/PRIVMSG #\S+ :(.*)$/);
      if (!match) continue;
      const text = match[1].trim();
      if (text) onMessage(text);
    }
  });
  ws.on('close', () => onStatus?.({ connected: false }));
  ws.on('error', (error) => onStatus?.({ error: error.message }));
  return ws;
}

async function kickChatroomId(slug) {
  const response = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
    headers: { 'User-Agent': 'Parasite/0.1 (+https://parasitebrands.com)' }
  });
  if (!response.ok) throw new Error(`Kick channel lookup failed: ${response.status}`);
  const json = await response.json();
  return json?.chatroom?.id;
}

async function connectKick(channel, onMessage, onStatus) {
  const chatroomId = await kickChatroomId(channel);
  if (!chatroomId) throw new Error(`Could not resolve Kick chatroom for ${channel}`);

  const ws = new WebSocket('wss://ws-us2.pusher.com/app/eb1d5f283081a78b932c?protocol=7&client=js&version=7.0.3&flash=false');
  ws.on('open', () => {
    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: { channel: `chatrooms.${chatroomId}.v2` }
    }));
    onStatus?.({ connected: true });
  });
  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.event !== 'App\\Events\\ChatMessageEvent') return;
      const payload = JSON.parse(frame.data || '{}');
      const text = String(payload?.content || '').trim();
      if (text) onMessage(text);
    } catch {
      // Ignore malformed frames from the socket.
    }
  });
  ws.on('close', () => onStatus?.({ connected: false }));
  ws.on('error', (error) => onStatus?.({ error: error.message }));
  return ws;
}

function createRecorder({ service, channel, onBucketUpdate }) {
  const startedAtMs = Date.now();
  const accumulator = new HeatmapAccumulator();
  let socket = null;

  const handleMessage = (text) => {
    const intensity = classifyMessage(text);
    if (intensity <= 0) return;
    accumulator.addIntensityAt(Date.now() - startedAtMs, intensity);
    onBucketUpdate?.(snapshot());
  };

  const snapshot = (meta = {}) => accumulator.snapshot({
    source: { kind: service, service, channel },
    ...meta
  });

  (async () => {
    try {
      if (service === 'twitch') socket = connectTwitch(channel, handleMessage);
      else if (service === 'kick') socket = await connectKick(channel, handleMessage);
    } catch (error) {
      console.error('[chat] connect failed:', error.message);
    }
  })();

  return {
    snapshot,
    stop({ heatmapPath = null, meta = {} } = {}) {
      try { socket?.close(); } catch {}
      const data = snapshot(meta);
      if (heatmapPath) {
        try { fs.writeFileSync(heatmapPath, JSON.stringify(data, null, 2)); } catch {}
      }
      return data;
    }
  };
}

module.exports = {
  BUCKET_MS,
  SPAM_PATTERNS,
  HeatmapAccumulator,
  classifyMessage,
  createRecorder
};
