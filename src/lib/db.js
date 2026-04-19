// SQLite metadata index.
// Keeps library state snappy even with 10TB of footage by avoiding a full
// rescan on every launch. Only newly added / modified files get re-probed.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

function init(appDataDir) {
  fs.mkdirSync(appDataDir, { recursive: true });
  const dbPath = path.join(appDataDir, 'parasite.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      path        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      mtime       REAL NOT NULL,
      duration    REAL NOT NULL DEFAULT 0,
      category    TEXT NOT NULL,
      probed_at   INTEGER NOT NULL DEFAULT 0,
      heatmap_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
    CREATE INDEX IF NOT EXISTS idx_videos_mtime    ON videos(mtime);

    CREATE TABLE IF NOT EXISTS flags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      video_path  TEXT,         -- nullable: hotkey flags before we know the file
      channel     TEXT,
      created_at  INTEGER NOT NULL,
      offset_ms   INTEGER,       -- ms into the recording when the flag was set
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_flags_video ON flags(video_path);

    CREATE TABLE IF NOT EXISTS queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      video_path  TEXT NOT NULL,
      action      TEXT NOT NULL,         -- 'drive' | 'youtube' | 'tiktok' | 'instagram' | 'twitter'
      params_json TEXT,
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
      progress    REAL NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
  `);
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call db.init(appDataDir) first.');
  return db;
}

// ---- Videos ---------------------------------------------------------------

const upsertVideo = () => getDB().prepare(`
  INSERT INTO videos (path, name, size, mtime, duration, category, probed_at, heatmap_path)
  VALUES (@path, @name, @size, @mtime, @duration, @category, @probed_at, @heatmap_path)
  ON CONFLICT(path) DO UPDATE SET
    name=excluded.name, size=excluded.size, mtime=excluded.mtime,
    duration=excluded.duration, category=excluded.category,
    probed_at=excluded.probed_at,
    heatmap_path=COALESCE(excluded.heatmap_path, videos.heatmap_path)
`);

function upsertVideoRow(row) { upsertVideo().run(row); }

function listVideos(category) {
  const sql = category
    ? 'SELECT * FROM videos WHERE category = ? ORDER BY mtime DESC'
    : 'SELECT * FROM videos ORDER BY mtime DESC';
  return getDB().prepare(sql).all(...(category ? [category] : []));
}

function getVideo(p)    { return getDB().prepare('SELECT * FROM videos WHERE path = ?').get(p); }
function renameVideo(oldP, newP, newName) {
  getDB().prepare('UPDATE videos SET path = ?, name = ? WHERE path = ?').run(newP, newName, oldP);
}
function deleteVideo(p) { getDB().prepare('DELETE FROM videos WHERE path = ?').run(p); }

// ---- Flags ----------------------------------------------------------------

function insertFlag(row) {
  const r = getDB().prepare(`
    INSERT INTO flags (video_path, channel, created_at, offset_ms, note)
    VALUES (@video_path, @channel, @created_at, @offset_ms, @note)
  `).run({ video_path: null, channel: null, offset_ms: null, note: null, ...row });
  return r.lastInsertRowid;
}
function flagsForVideo(p) { return getDB().prepare('SELECT * FROM flags WHERE video_path = ? ORDER BY created_at').all(p); }
function recentOrphanFlags(channel, sinceMs) {
  // Flags recorded via hotkey before any file exists yet — we attach them
  // to the newly created recording after it stops.
  return getDB().prepare('SELECT * FROM flags WHERE video_path IS NULL AND channel = ? AND created_at >= ?').all(channel, sinceMs);
}
function attachFlagsToVideo(ids, videoPath, recordingStartMs) {
  const upd = getDB().prepare('UPDATE flags SET video_path = ?, offset_ms = ? WHERE id = ?');
  const tx = getDB().transaction((rows) => {
    for (const row of rows) upd.run(videoPath, row.created_at - recordingStartMs, row.id);
  });
  tx(flagsById(ids));
}
function flagsById(ids) {
  if (!ids.length) return [];
  const q = `SELECT * FROM flags WHERE id IN (${ids.map(() => '?').join(',')})`;
  return getDB().prepare(q).all(...ids);
}

// ---- Queue ----------------------------------------------------------------

function enqueue(row) {
  const now = Date.now();
  const r = getDB().prepare(`
    INSERT INTO queue (video_path, action, params_json, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?)
  `).run(row.video_path, row.action, JSON.stringify(row.params || {}), now, now);
  return r.lastInsertRowid;
}
function nextPending() { return getDB().prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY id LIMIT 1").get(); }
function updateQueue(id, patch) {
  const fields = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
  getDB().prepare(`UPDATE queue SET ${fields}, updated_at = @updated_at WHERE id = @id`).run({ ...patch, updated_at: Date.now(), id });
}
function listQueue() { return getDB().prepare('SELECT * FROM queue ORDER BY id DESC LIMIT 500').all(); }
function clearDoneQueue() { getDB().prepare("DELETE FROM queue WHERE status IN ('done','error')").run(); }

module.exports = {
  init, getDB,
  upsertVideoRow, listVideos, getVideo, renameVideo, deleteVideo,
  insertFlag, flagsForVideo, recentOrphanFlags, attachFlagsToVideo,
  enqueue, nextPending, updateQueue, listQueue, clearDoneQueue
};
