const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUCKET_MS,
  HeatmapAccumulator,
  normalizeImportedPayload
} = require('../src/lib/heatmap-core');
const { extractTwitchVodId } = require('../src/lib/twitch-vod');

test('normalizeImportedPayload derives duration and sorts messages', () => {
  const payload = normalizeImportedPayload({
    title: 'Imported chat',
    source: { kind: 'manual', service: 'twitch', channel: 'lirik' },
    messages: [
      { offsetSec: 61, text: 'LUL' },
      { offsetSec: 5, text: 'hello' }
    ]
  });

  assert.equal(payload.title, 'Imported chat');
  assert.equal(payload.durationSec, 90);
  assert.deepEqual(payload.messages.map((message) => message.offsetSec), [5, 61]);
  assert.equal(payload.source.channel, 'lirik');
});

test('normalizeImportedPayload rejects invalid offsets', () => {
  assert.throws(() => normalizeImportedPayload({
    messages: [{ offsetSec: -1, text: 'bad' }]
  }), /invalid offsetSec/i);
});

test('HeatmapAccumulator buckets message intensity', () => {
  const accumulator = new HeatmapAccumulator();
  accumulator.addMessage(2, 'LUL');
  accumulator.addMessage(35, 'POG');

  const snapshot = accumulator.snapshot({ durationSec: 120 });
  assert.equal(snapshot.bucketMs, BUCKET_MS);
  assert.equal(snapshot.buckets.length, 2);
  assert.equal(snapshot.buckets[0].t, 0);
  assert.equal(snapshot.buckets[1].t, BUCKET_MS);
});

test('extractTwitchVodId handles raw ids and URLs', () => {
  assert.equal(extractTwitchVodId('123456789'), '123456789');
  assert.equal(extractTwitchVodId('https://www.twitch.tv/videos/987654321'), '987654321');
});
