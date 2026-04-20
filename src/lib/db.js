// SQLite metadata index.
// Tracks library items, flags, export queue jobs, and historical heatmap jobs.

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
  db.pragma('foreign_keys = ON');
  migrate();
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not initialized. Call db.init(appDataDir) first.');
  return db;
}

function migrate() {
  const database = getDB();
  const tx = database.transaction(() => {
    migrateLibraryItems();
    migrateFlags();
    migrateQueue();
    createHeatmapJobsTable();
  });
  tx();
}

function migrateLibraryItems() {
  if (tableExists('library_items')) {
    ensureLibraryItemColumns();
    createLibraryItemIndexes();
    return;
  }

  createLibraryItemsTable();
  if (!tableExists('videos')) {
    createLibraryItemIndexes();
    return;
  }

  getDB().prepare('ALTER TABLE videos RENAME TO videos_legacy').run();
  getDB().prepare(`
    INSERT INTO library_items (
      path, name, size, mtime, duration, category, probed_at, heatmap_path,
      playback_available, playback_error, source_kind, created_at, updated_at
    )
    SELECT
      path, name, size, mtime, duration, category, probed_at, heatmap_path,
      CASE WHEN path IS NULL THEN 0 ELSE 1 END,
      CASE WHEN path IS NULL THEN 'No media attached.' ELSE NULL END,
      'file',
      strftime('%s','now') * 1000,
      strftime('%s','now') * 1000
    FROM videos_legacy
  `).run();
  getDB().prepare('DROP TABLE videos_legacy').run();
  createLibraryItemIndexes();
}

function migrateFlags() {
  if (!tableExists('flags')) {
    createFlagsTable();
    return;
  }

  const columns = tableColumns('flags');
  if (columns.has('item_id')) {
    createFlagsTable();
    createFlagIndexes();
    return;
  }

  getDB().prepare('ALTER TABLE flags RENAME TO flags_legacy').run();
  createFlagsTable();
  getDB().prepare(`
    INSERT INTO flags (item_id, video_path, channel, created_at, offset_ms, note)
    SELECT
      li.item_id,
      fl.video_path,
      fl.channel,
      fl.created_at,
      fl.offset_ms,
      fl.note
    FROM flags_legacy fl
    LEFT JOIN library_items li ON li.path = fl.video_path
  `).run();
  getDB().prepare('DROP TABLE flags_legacy').run();
  createFlagIndexes();
}

function migrateQueue() {
  if (!tableExists('queue')) {
    createQueueTable();
    return;
  }

  const columns = tableColumns('queue');
  if (columns.has('item_id')) {
    createQueueTable();
    createQueueIndexes();
    return;
  }

  getDB().prepare('ALTER TABLE queue RENAME TO queue_legacy').run();
  createQueueTable();
  getDB().prepare(`
    INSERT INTO queue (
      item_id, video_path, action, params_json, status, progress, error, created_at, updated_at
    )
    SELECT
      li.item_id,
      q.video_path,
      q.action,
      q.params_json,
      q.status,
      q.progress,
      q.error,
      q.created_at,
      q.updated_at
    FROM queue_legacy q
    LEFT JOIN library_items li ON li.path = q.video_path
  `).run();
  getDB().prepare('DROP TABLE queue_legacy').run();
  createQueueIndexes();
}

function createHeatmapJobsTable() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS heatmap_jobs (
      job_id           INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id          INTEGER NOT NULL,
      kind             TEXT NOT NULL,
      source_kind      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      progress         REAL NOT NULL DEFAULT 0,
      progress_label   TEXT,
      error            TEXT,
      checkpoint_json  TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      FOREIGN KEY(item_id) REFERENCES library_items(item_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_heatmap_jobs_status ON heatmap_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_heatmap_jobs_item ON heatmap_jobs(item_id, job_id DESC);
  `);
}

function createLibraryItemsTable() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS library_items (
      item_id              INTEGER PRIMARY KEY AUTOINCREMENT,
      path                 TEXT UNIQUE,
      name                 TEXT NOT NULL,
      size                 INTEGER NOT NULL DEFAULT 0,
      mtime                REAL NOT NULL DEFAULT 0,
      duration             REAL NOT NULL DEFAULT 0,
      category             TEXT NOT NULL,
      probed_at            INTEGER NOT NULL DEFAULT 0,
      heatmap_path         TEXT,
      playback_available   INTEGER NOT NULL DEFAULT 1,
      playback_error       TEXT,
      source_kind          TEXT,
      source_service       TEXT,
      source_vod_id        TEXT,
      source_channel       TEXT,
      recorded_started_at  INTEGER,
      recorded_finished_at INTEGER,
      import_payload_path  TEXT,
      created_at           INTEGER NOT NULL DEFAULT 0,
      updated_at           INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function ensureLibraryItemColumns() {
  const columns = tableColumns('library_items');
  const missing = [
    ['heatmap_path', 'TEXT'],
    ['playback_available', 'INTEGER NOT NULL DEFAULT 1'],
    ['playback_error', 'TEXT'],
    ['source_kind', 'TEXT'],
    ['source_service', 'TEXT'],
    ['source_vod_id', 'TEXT'],
    ['source_channel', 'TEXT'],
    ['recorded_started_at', 'INTEGER'],
    ['recorded_finished_at', 'INTEGER'],
    ['import_payload_path', 'TEXT'],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['updated_at', 'INTEGER NOT NULL DEFAULT 0']
  ];
  for (const [name, sql] of missing) {
    if (!columns.has(name)) getDB().prepare(`ALTER TABLE library_items ADD COLUMN ${name} ${sql}`).run();
  }
}

function createLibraryItemIndexes() {
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_library_items_category ON library_items(category);
    CREATE INDEX IF NOT EXISTS idx_library_items_mtime ON library_items(mtime DESC);
    CREATE INDEX IF NOT EXISTS idx_library_items_path ON library_items(path);
  `);
}

function createFlagsTable() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS flags (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER,
      video_path  TEXT,
      channel     TEXT,
      created_at  INTEGER NOT NULL,
      offset_ms   INTEGER,
      note        TEXT,
      FOREIGN KEY(item_id) REFERENCES library_items(item_id) ON DELETE SET NULL
    );
  `);
  createFlagIndexes();
}

function createFlagIndexes() {
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_flags_item ON flags(item_id);
    CREATE INDEX IF NOT EXISTS idx_flags_video_path ON flags(video_path);
  `);
}

function createQueueTable() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER,
      video_path  TEXT,
      action      TEXT NOT NULL,
      params_json TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      progress    REAL NOT NULL DEFAULT 0,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      FOREIGN KEY(item_id) REFERENCES library_items(item_id) ON DELETE SET NULL
    );
  `);
  createQueueIndexes();
}

function createQueueIndexes() {
  getDB().exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_item_id ON queue(item_id);
  `);
}

function tableExists(name) {
  const row = getDB().prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name);
  return !!row;
}

function tableColumns(name) {
  if (!tableExists(name)) return new Set();
  return new Set(getDB().prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

// ---- Library items -------------------------------------------------------

const upsertFileItemStmt = () => getDB().prepare(`
  INSERT INTO library_items (
    path, name, size, mtime, duration, category, probed_at, heatmap_path,
    playback_available, playback_error, source_kind, source_service, source_vod_id, source_channel,
    recorded_started_at, recorded_finished_at, import_payload_path, created_at, updated_at
  )
  VALUES (
    @path, @name, @size, @mtime, @duration, @category, @probed_at, @heatmap_path,
    @playback_available, @playback_error, @source_kind, @source_service, @source_vod_id, @source_channel,
    @recorded_started_at, @recorded_finished_at, @import_payload_path, @created_at, @updated_at
  )
  ON CONFLICT(path) DO UPDATE SET
    name=excluded.name,
    size=excluded.size,
    mtime=excluded.mtime,
    duration=excluded.duration,
    category=excluded.category,
    probed_at=excluded.probed_at,
    heatmap_path=COALESCE(excluded.heatmap_path, library_items.heatmap_path),
    playback_available=excluded.playback_available,
    playback_error=excluded.playback_error,
    source_kind=COALESCE(excluded.source_kind, library_items.source_kind),
    source_service=COALESCE(excluded.source_service, library_items.source_service),
    source_vod_id=COALESCE(excluded.source_vod_id, library_items.source_vod_id),
    source_channel=COALESCE(excluded.source_channel, library_items.source_channel),
    recorded_started_at=COALESCE(excluded.recorded_started_at, library_items.recorded_started_at),
    recorded_finished_at=COALESCE(excluded.recorded_finished_at, library_items.recorded_finished_at),
    import_payload_path=COALESCE(excluded.import_payload_path, library_items.import_payload_path),
    updated_at=excluded.updated_at
`);

function upsertFileItem(row) {
  const now = Date.now();
  const payload = {
    heatmap_path: null,
    playback_available: 1,
    playback_error: null,
    source_kind: 'file',
    source_service: null,
    source_vod_id: null,
    source_channel: null,
    recorded_started_at: null,
    recorded_finished_at: null,
    import_payload_path: null,
    created_at: now,
    updated_at: now,
    ...row
  };
  upsertFileItemStmt().run(payload);
  return getItemByPath(payload.path);
}

function createImportItem(row) {
  const now = Date.now();
  const payload = {
    name: row.name,
    size: row.size || 0,
    mtime: row.mtime || now,
    duration: row.duration || 0,
    category: row.category,
    probed_at: now,
    heatmap_path: row.heatmap_path || null,
    playback_available: 0,
    playback_error: row.playback_error || 'No media attached.',
    source_kind: row.source_kind || 'manual',
    source_service: row.source_service || null,
    source_vod_id: row.source_vod_id || null,
    source_channel: row.source_channel || null,
    recorded_started_at: row.recorded_started_at || null,
    recorded_finished_at: row.recorded_finished_at || null,
    import_payload_path: row.import_payload_path || null,
    created_at: now,
    updated_at: now
  };
  const result = getDB().prepare(`
    INSERT INTO library_items (
      path, name, size, mtime, duration, category, probed_at, heatmap_path,
      playback_available, playback_error, source_kind, source_service, source_vod_id, source_channel,
      recorded_started_at, recorded_finished_at, import_payload_path, created_at, updated_at
    )
    VALUES (
      NULL, @name, @size, @mtime, @duration, @category, @probed_at, @heatmap_path,
      @playback_available, @playback_error, @source_kind, @source_service, @source_vod_id, @source_channel,
      @recorded_started_at, @recorded_finished_at, @import_payload_path, @created_at, @updated_at
    )
  `).run(payload);
  return getItemById(result.lastInsertRowid);
}

function updateItem(itemId, patch) {
  const entries = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return getItemById(itemId);
  const sets = entries.map(([key]) => `${key} = @${key}`).join(', ');
  getDB().prepare(`
    UPDATE library_items
    SET ${sets}, updated_at = @updated_at
    WHERE item_id = @item_id
  `).run({ ...patch, updated_at: Date.now(), item_id: itemId });
  return getItemById(itemId);
}

function listItems() {
  return getDB().prepare(`
    SELECT * FROM library_items
    ORDER BY COALESCE(mtime, created_at) DESC, item_id DESC
  `).all();
}

function listFileItems() {
  return getDB().prepare(`
    SELECT * FROM library_items
    WHERE path IS NOT NULL
    ORDER BY COALESCE(mtime, created_at) DESC, item_id DESC
  `).all();
}

function getItemById(itemId) {
  return getDB().prepare('SELECT * FROM library_items WHERE item_id = ?').get(itemId);
}

function getItemByPath(filePath) {
  return getDB().prepare('SELECT * FROM library_items WHERE path = ?').get(filePath);
}

function renameItem(itemId, newPath, newName) {
  updateItem(itemId, { path: newPath, name: newName, playback_available: 1, playback_error: null });
  getDB().prepare('UPDATE flags SET video_path = ? WHERE item_id = ?').run(newPath, itemId);
  getDB().prepare('UPDATE queue SET video_path = ? WHERE item_id = ?').run(newPath, itemId);
  return getItemById(itemId);
}

function markMissingItems(seenPaths) {
  const rows = listFileItems();
  const update = getDB().prepare(`
    UPDATE library_items
    SET playback_available = 0, playback_error = ?, updated_at = ?
    WHERE item_id = ?
  `);
  for (const row of rows) {
    if (seenPaths.has(row.path)) continue;
    update.run('Media file not found.', Date.now(), row.item_id);
  }
}

function deleteItem(itemId) {
  getDB().prepare('DELETE FROM library_items WHERE item_id = ?').run(itemId);
}

// ---- Flags ---------------------------------------------------------------

function insertFlag(row) {
  const item = row.item_id ? getItemById(row.item_id) : null;
  const result = getDB().prepare(`
    INSERT INTO flags (item_id, video_path, channel, created_at, offset_ms, note)
    VALUES (@item_id, @video_path, @channel, @created_at, @offset_ms, @note)
  `).run({
    item_id: null,
    video_path: item?.path || null,
    channel: null,
    created_at: Date.now(),
    offset_ms: null,
    note: null,
    ...row
  });
  return result.lastInsertRowid;
}

function flagsForItem(itemId) {
  return getDB().prepare('SELECT * FROM flags WHERE item_id = ? ORDER BY created_at').all(itemId);
}

function recentOrphanFlags(channel, sinceMs) {
  return getDB().prepare(`
    SELECT * FROM flags
    WHERE item_id IS NULL AND channel = ? AND created_at >= ?
    ORDER BY created_at
  `).all(channel, sinceMs);
}

function attachFlagsToItem(ids, itemId, recordingStartMs) {
  if (!ids.length) return;
  const item = getItemById(itemId);
  if (!item) return;
  const update = getDB().prepare(`
    UPDATE flags
    SET item_id = ?, video_path = ?, offset_ms = ?
    WHERE id = ?
  `);
  const rows = flagsById(ids);
  const tx = getDB().transaction(() => {
    for (const row of rows) {
      update.run(itemId, item.path, row.created_at - recordingStartMs, row.id);
    }
  });
  tx();
}

function flagsById(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return getDB().prepare(`SELECT * FROM flags WHERE id IN (${placeholders})`).all(...ids);
}

// ---- Export queue --------------------------------------------------------

function enqueue(row) {
  const now = Date.now();
  const item = row.item_id ? getItemById(row.item_id) : null;
  const result = getDB().prepare(`
    INSERT INTO queue (item_id, video_path, action, params_json, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(
    row.item_id || null,
    row.video_path || item?.path || null,
    row.action,
    JSON.stringify(row.params || {}),
    now,
    now
  );
  return result.lastInsertRowid;
}

function nextPendingQueueJob() {
  return getDB().prepare(`
    SELECT
      q.*,
      li.path AS item_path,
      li.name AS item_name
    FROM queue q
    LEFT JOIN library_items li ON li.item_id = q.item_id
    WHERE q.status = 'pending'
    ORDER BY q.id
    LIMIT 1
  `).get();
}

function updateQueue(id, patch) {
  const entries = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = @${key}`).join(', ');
  getDB().prepare(`
    UPDATE queue
    SET ${sets}, updated_at = @updated_at
    WHERE id = @id
  `).run({ ...patch, updated_at: Date.now(), id });
}

function listQueue() {
  return getDB().prepare(`
    SELECT
      q.*,
      li.name AS item_name,
      li.path AS item_path
    FROM queue q
    LEFT JOIN library_items li ON li.item_id = q.item_id
    ORDER BY q.id DESC
    LIMIT 500
  `).all();
}

function clearDoneQueue() {
  getDB().prepare("DELETE FROM queue WHERE status IN ('done','error')").run();
}

// ---- Heatmap jobs --------------------------------------------------------

function createHeatmapJob(row) {
  const now = Date.now();
  const result = getDB().prepare(`
    INSERT INTO heatmap_jobs (
      item_id, kind, source_kind, status, progress, progress_label, error, checkpoint_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.item_id,
    row.kind,
    row.source_kind,
    row.status || 'pending',
    row.progress || 0,
    row.progress_label || null,
    row.error || null,
    row.checkpoint_json || null,
    now,
    now
  );
  return getHeatmapJob(result.lastInsertRowid);
}

function getHeatmapJob(jobId) {
  return getDB().prepare('SELECT * FROM heatmap_jobs WHERE job_id = ?').get(jobId);
}

function nextPendingHeatmapJob() {
  return getDB().prepare(`
    SELECT hj.*, li.path AS item_path, li.name AS item_name, li.import_payload_path, li.heatmap_path
    FROM heatmap_jobs hj
    JOIN library_items li ON li.item_id = hj.item_id
    WHERE hj.status = 'pending'
    ORDER BY hj.job_id
    LIMIT 1
  `).get();
}

function updateHeatmapJob(jobId, patch) {
  const entries = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
  if (!entries.length) return getHeatmapJob(jobId);
  const sets = entries.map(([key]) => `${key} = @${key}`).join(', ');
  getDB().prepare(`
    UPDATE heatmap_jobs
    SET ${sets}, updated_at = @updated_at
    WHERE job_id = @job_id
  `).run({ ...patch, updated_at: Date.now(), job_id: jobId });
  return getHeatmapJob(jobId);
}

function listLatestHeatmapJobs() {
  return getDB().prepare(`
    SELECT hj.*
    FROM heatmap_jobs hj
    JOIN (
      SELECT item_id, MAX(job_id) AS latest_job_id
      FROM heatmap_jobs
      GROUP BY item_id
    ) latest ON latest.latest_job_id = hj.job_id
  `).all();
}

function latestHeatmapJobForItem(itemId) {
  return getDB().prepare(`
    SELECT * FROM heatmap_jobs
    WHERE item_id = ?
    ORDER BY job_id DESC
    LIMIT 1
  `).get(itemId);
}

function resetRunningHeatmapJobs() {
  getDB().prepare(`
    UPDATE heatmap_jobs
    SET status = 'pending', progress_label = COALESCE(progress_label, 'Resuming heatmap build…'), updated_at = ?
    WHERE status = 'running'
  `).run(Date.now());
}

function cancelPendingHeatmapJob(jobId) {
  updateHeatmapJob(jobId, { status: 'cancelled', progress_label: 'Cancelled.' });
}

function listHeatmapJobsForItem(itemId) {
  return getDB().prepare(`
    SELECT * FROM heatmap_jobs
    WHERE item_id = ?
    ORDER BY job_id DESC
  `).all(itemId);
}

module.exports = {
  init,
  getDB,

  listItems,
  listFileItems,
  getItemById,
  getItemByPath,
  upsertFileItem,
  createImportItem,
  updateItem,
  renameItem,
  markMissingItems,
  deleteItem,

  insertFlag,
  flagsForItem,
  recentOrphanFlags,
  attachFlagsToItem,

  enqueue,
  nextPendingQueueJob,
  updateQueue,
  listQueue,
  clearDoneQueue,

  createHeatmapJob,
  getHeatmapJob,
  nextPendingHeatmapJob,
  updateHeatmapJob,
  listLatestHeatmapJobs,
  latestHeatmapJobForItem,
  resetRunningHeatmapJobs,
  cancelPendingHeatmapJob,
  listHeatmapJobsForItem
};
