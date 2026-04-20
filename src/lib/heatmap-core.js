const path = require('path');

const BUCKET_MS = 30_000;

const SPAM_PATTERNS = [
  /\bLUL\b/i, /\bLULW\b/i, /\bOMEGALUL\b/i, /\bKEKW\b/i,
  /\bPOG(GERS)?\b/i, /\bPOGU\b/i,
  /\bW\b/, /\b(W{2,}|L{2,})\b/,
  /\bLMAO+\b/i, /\bLOL+\b/i, /\bXD+\b/i,
  /\bOMG+\b/i, /\bHOLY\s*SHIT\b/i, /\bNOO+\b/i, /\bWHAT\??!?\b/i,
  /\bCLIP\s*(IT|THIS)\b/i
];

function classifyMessage(message) {
  const text = String(message || '').trim();
  if (!text) return 0;

  let intensity = 0;
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(text)) intensity++;
  }
  if (text.length >= 3 && text === text.toUpperCase()) intensity += 0.5;
  return intensity;
}

class HeatmapAccumulator {
  constructor({ bucketMs = BUCKET_MS, buckets } = {}) {
    this.bucketMs = bucketMs;
    this.buckets = new Map();
    if (Array.isArray(buckets)) {
      for (const entry of buckets) {
        if (!entry) continue;
        const bucketIndex = Number.isFinite(entry.b) ? entry.b : Math.floor((entry.t || 0) / bucketMs);
        const value = Number(entry.v || 0);
        if (Number.isFinite(bucketIndex) && Number.isFinite(value) && value > 0) {
          this.buckets.set(bucketIndex, value);
        }
      }
    }
  }

  addIntensityAt(offsetMs, intensity) {
    const value = Number(intensity || 0);
    const safeOffsetMs = Number(offsetMs || 0);
    if (!Number.isFinite(value) || value <= 0) return;
    if (!Number.isFinite(safeOffsetMs) || safeOffsetMs < 0) return;
    const bucketIndex = Math.floor(safeOffsetMs / this.bucketMs);
    this.buckets.set(bucketIndex, (this.buckets.get(bucketIndex) || 0) + value);
  }

  addMessage(offsetSec, text) {
    const intensity = classifyMessage(text);
    if (intensity <= 0) return intensity;
    this.addIntensityAt(offsetSec * 1000, intensity);
    return intensity;
  }

  toBuckets() {
    return Array.from(this.buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([bucketIndex, value]) => ({ t: bucketIndex * this.bucketMs, v: Number(value.toFixed(3)) }));
  }

  serializeCheckpoint() {
    return {
      bucketMs: this.bucketMs,
      buckets: Array.from(this.buckets.entries()).map(([bucketIndex, value]) => ({ b: bucketIndex, v: value }))
    };
  }

  snapshot(meta = {}) {
    return {
      bucketMs: this.bucketMs,
      durationSec: meta.durationSec || null,
      source: meta.source || null,
      title: meta.title || null,
      buckets: this.toBuckets()
    };
  }

  static fromCheckpoint(checkpoint) {
    return new HeatmapAccumulator(checkpoint || {});
  }
}

function deriveDurationSec(maxOffsetSec) {
  const safeMax = Number(maxOffsetSec || 0);
  const bucketSec = BUCKET_MS / 1000;
  if (!Number.isFinite(safeMax) || safeMax <= 0) return bucketSec;
  return Math.max(bucketSec, Math.ceil(safeMax / bucketSec) * bucketSec);
}

function normalizeImportedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Imported chat JSON must be an object.');
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error('Imported chat JSON must include a non-empty messages array.');
  }

  const normalizedMessages = payload.messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error(`Message ${index + 1} must be an object.`);
    }
    const offsetSec = Number(message.offsetSec);
    if (!Number.isFinite(offsetSec) || offsetSec < 0) {
      throw new Error(`Message ${index + 1} has an invalid offsetSec.`);
    }
    if (typeof message.text !== 'string') {
      throw new Error(`Message ${index + 1} must include a text string.`);
    }
    return { offsetSec, text: message.text };
  }).sort((a, b) => a.offsetSec - b.offsetSec);

  const source = normalizeSource(payload.source);
  const explicitDuration = Number(payload.durationSec);
  const durationSec = Number.isFinite(explicitDuration) && explicitDuration > 0
    ? explicitDuration
    : deriveDurationSec(normalizedMessages[normalizedMessages.length - 1]?.offsetSec || 0);

  return {
    version: 1,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null,
    durationSec,
    source,
    messages: normalizedMessages
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { kind: 'manual' };
  }
  return {
    kind: typeof source.kind === 'string' && source.kind.trim() ? source.kind.trim() : 'manual',
    service: typeof source.service === 'string' && source.service.trim() ? source.service.trim() : null,
    vodId: typeof source.vodId === 'string' && source.vodId.trim() ? source.vodId.trim() : null,
    channel: typeof source.channel === 'string' && source.channel.trim() ? source.channel.trim() : null
  };
}

function heatmapPathForMedia(filePath) {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}.parasite.heatmap.json`;
}

function formatShortDuration(sec) {
  const safe = Math.max(0, Math.floor(Number(sec || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

module.exports = {
  BUCKET_MS,
  SPAM_PATTERNS,
  HeatmapAccumulator,
  classifyMessage,
  deriveDurationSec,
  normalizeImportedPayload,
  heatmapPathForMedia,
  formatShortDuration
};
