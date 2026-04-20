const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const db = require('../src/lib/db');

test('legacy database migrates to item ids for items, flags, and queue rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parasite-db-'));
  const sqlitePath = path.join(tempDir, 'parasite.sqlite');
  const legacyDb = new Database(sqlitePath);

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
