// Dev utility: injects a fake heatmap JSON for the first video in your library
// so you can test the scrubber overlay without doing a real recording.
//
// Usage:
//   node scripts/inject-fake-heatmap.js
//   node scripts/inject-fake-heatmap.js "C:\path\to\specific-video.mp4"

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'parasite');
const DB_PATH  = path.join(APP_DATA, 'parasite.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error('No DB found at', DB_PATH);
  console.error('Launch Parasite at least once first so it creates the database.');
  process.exit(1);
}

const db = new Database(DB_PATH);

// Pick a specific video or just grab the first one in the DB.
let targetPath = process.argv[2];
if (targetPath) {
  const row = db.prepare('SELECT * FROM videos WHERE path = ?').get(targetPath);
  if (!row) { console.error('Video not found in library:', targetPath); process.exit(1); }
} else {
  const row = db.prepare('SELECT * FROM videos ORDER BY mtime DESC LIMIT 1').get();
  if (!row) { console.error('Library is empty. Drop a video into your Parasite folder first.'); process.exit(1); }
  targetPath = row.path;
}

const videoRow = db.prepare('SELECT * FROM videos WHERE path = ?').get(targetPath);
const duration = videoRow.duration || 3600; // fallback 1h if not probed

const BUCKET_MS = 30_000;
const totalBuckets = Math.ceil((duration * 1000) / BUCKET_MS);

// Generate a spiky heatmap with random hot moments.
const buckets = [];
for (let i = 0; i < totalBuckets; i++) {
  // Base low noise
  let v = Math.random() * 0.5;
  // Random spikes at ~15% of buckets
  if (Math.random() < 0.15) v += 3 + Math.random() * 10;
  if (v > 0.2) buckets.push({ t: i * BUCKET_MS, v: parseFloat(v.toFixed(2)) });
}

const heatmapData = {
  service: 'twitch',
  channel: 'fake-heatmap-test',
  startMs: Date.now() - duration * 1000,
  bucketMs: BUCKET_MS,
  buckets
};

const heatmapPath = targetPath.replace(/\.[^.]+$/, '') + '-heatmap-test.json';
fs.writeFileSync(heatmapPath, JSON.stringify(heatmapData, null, 2));

db.prepare('UPDATE videos SET heatmap_path = ? WHERE path = ?').run(heatmapPath, targetPath);

console.log('✓ Injected fake heatmap');
console.log('  Video   :', targetPath);
console.log('  Heatmap :', heatmapPath);
console.log('  Buckets :', buckets.length, '×', BUCKET_MS / 1000 + 's');
console.log('');
console.log('Reload the Library tab in Parasite (or restart) to see the heatmap.');
