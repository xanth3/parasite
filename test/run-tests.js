const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BUCKET_MS,
  HeatmapAccumulator,
  normalizeImportedPayload
} = require('../src/lib/heatmap-core');
const { extractTwitchVodId } = require('../src/lib/twitch-vod');
const db = require('../src/lib/db');

function run(name, fn) {
  try {
    const result = fn();
    if (result === 'skip') {
      console.log(`SKIP ${name}`);
      return;
    }
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

run('normalizeImportedPayload derives duration and sorts messages', () => {
  const payload = normalizeImportedPayload({
    title: 'Imported chat',
    source: { kind: 'manual', service: 'twitch', channel: 'lirik' },
    messages: [
      { offsetSec: 61, text: 'LUL' },
      { offsetSec: 5, text: 'hello' }
    ]
  });

  assert.equal(payload.durationSec, 90);
  assert.deepEqual(payload.messages.map((message) => message.offsetSec), [5, 61]);
  assert.equal(payload.source.channel, 'lirik');
});

run('normalizeImportedPayload rejects invalid offsets', () => {
  assert.throws(() => normalizeImportedPayload({
    messages: [{ offsetSec: -1, text: 'bad' }]
  }), /invalid offsetSec/i);
});

run('HeatmapAccumulator buckets intensity in 30 second slices', () => {
  const accumulator = new HeatmapAccumulator();
  accumulator.addMessage(2, 'LUL');
  accumulator.addMessage(35, 'POG');

  const snapshot = accumulator.snapshot({ durationSec: 120 });
  assert.equal(snapshot.bucketMs, BUCKET_MS);
  assert.equal(snapshot.buckets.length, 2);
  assert.equal(snapshot.buckets[0].t, 0);
  assert.equal(snapshot.buckets[1].t, BUCKET_MS);
});

run('extractTwitchVodId handles raw ids and URLs', () => {
  assert.equal(extractTwitchVodId('123456789'), '123456789');
  assert.equal(extractTwitchVodId('https://www.twitch.tv/videos/987654321'), '987654321');
});

run('legacy database migrates to item ids for items, flags, and queue rows', () => {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    console.log(`SKIP detail: ${error.code || error.message}`);
    return 'skip';
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parasite-db-'));
  const sqlitePath = path.join(tempDir, 'parasite.sqlite');
  let legacyDb;
  try {
    legacyDb = new Database(sqlitePath);
  } catch (error) {
    console.log(`SKIP detail: ${error.code || error.message}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return 'skip';
  }

  legacyDb.exec(`
    CREATE TABLE videos (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      duration REAL NOT NULL DEFAULT 0,
      category TEXT NOT NULL,
      probed_at INTEGER NOT NULL DEFAULT 0,
      heatmap_path TEXT
    );
    CREATE TABLE flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_path TEXT,
      channel TEXT,
      created_at INTEGER NOT NULL,
      offset_ms INTEGER,
      note TEXT
    );
    CREATE TABLE queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_path TEXT NOT NULL,
      action TEXT NOT NULL,
      params_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  legacyDb.prepare(`
    INSERT INTO videos (path, name, size, mtime, duration, category, probed_at, heatmap_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('C:\\video.mkv', 'video.mkv', 100, 1234, 3600, 'unedited', 99, 'C:\\video.parasite.heatmap.json');
  legacyDb.prepare(`
    INSERT INTO flags (video_path, channel, created_at, offset_ms, note)
    VALUES (?, ?, ?, ?, ?)
  `).run('C:\\video.mkv', 'lirik', 5000, 15000, 'Marked');
  legacyDb.prepare(`
    INSERT INTO queue (video_path, action, params_json, status, progress, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('C:\\video.mkv', 'drive', '{}', 'pending', 0, null, 1000, 1000);
  legacyDb.close();

  db.init(tempDir);
  const items = db.listItems();
  assert.equal(items.length, 1);
  assert.ok(items[0].item_id);
  assert.equal(items[0].path, 'C:\\video.mkv');

  const flags = db.flagsForItem(items[0].item_id);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].video_path, 'C:\\video.mkv');

  const queueRows = db.listQueue();
  assert.equal(queueRows.length, 1);
  assert.equal(queueRows[0].item_id, items[0].item_id);

  db.getDB().close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

if (process.exitCode) process.exit(process.exitCode);
