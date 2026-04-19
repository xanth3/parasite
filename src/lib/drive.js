// Google Drive integration.
// Uses installed-app OAuth: user pastes a code from the consent page.
// Credentials live in Settings (electron-store) so nothing is hardcoded here.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// The redirect URI used by Google's "Desktop app" OAuth client.
// For an installed app you can safely use 'urn:ietf:wg:oauth:2.0:oob'
// (deprecated but still works for personal use) OR run a tiny local
// loopback listener on a free port. We use the loopback approach below.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

function buildClient(store) {
  const clientId = process.env.GDRIVE_CLIENT_ID || store.get('drive.clientId');
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET || store.get('drive.clientSecret');
  const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
  if (!clientId || !clientSecret) {
    throw new Error('Drive is not configured. Add GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET in Settings.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function status(store) {
  const hasTokens = !!store.get('drive.tokens');
  const configured = !!(store.get('drive.clientId') || process.env.GDRIVE_CLIENT_ID);
  return {
    configured,
    connected: hasTokens,
    defaultFolderId: store.get('drive.defaultFolderId'),
    defaultFolderName: store.get('drive.defaultFolderName')
  };
}

async function startAuth(store) {
  const client = buildClient(store);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
  return { url };
}

async function completeAuth(store, code) {
  const client = buildClient(store);
  const { tokens } = await client.getToken(code);
  store.set('drive.tokens', tokens);
  return { connected: true };
}

function disconnect(store) {
  store.delete('drive.tokens');
  return { connected: false };
}

function authedClient(store) {
  const tokens = store.get('drive.tokens');
  if (!tokens) throw new Error('Not connected to Google Drive.');
  const client = buildClient(store);
  client.setCredentials(tokens);
  // Persist refreshed tokens
  client.on('tokens', (t) => {
    const merged = { ...tokens, ...t };
    store.set('drive.tokens', merged);
  });
  return client;
}

async function ensureDefaultFolder(store, driveApi) {
  let id = store.get('drive.defaultFolderId');
  if (id) {
    try {
      await driveApi.files.get({ fileId: id, fields: 'id, name, trashed' });
      return id;
    } catch {
      store.delete('drive.defaultFolderId');
      id = null;
    }
  }
  const name = store.get('drive.defaultFolderName') || 'Parasite Uploads';
  const res = await driveApi.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  store.set('drive.defaultFolderId', res.data.id);
  return res.data.id;
}

async function uploadWithProgress(store, filePath, onProgress) {
  const auth = authedClient(store);
  const driveApi = google.drive({ version: 'v3', auth });
  const folderId = await ensureDefaultFolder(store, driveApi);
  const stat = fs.statSync(filePath);
  const total = stat.size;
  let uploaded = 0;

  const stream = fs.createReadStream(filePath);
  stream.on('data', (chunk) => {
    uploaded += chunk.length;
    onProgress?.({ uploaded, total, pct: uploaded / total });
  });

  const res = await driveApi.files.create({
    requestBody: {
      name: path.basename(filePath),
      parents: [folderId]
    },
    media: {
      mimeType: 'video/*',
      body: stream
    },
    fields: 'id, name, webViewLink'
  }, {
    onUploadProgress: (evt) => {
      onProgress?.({ uploaded: evt.bytesRead, total, pct: evt.bytesRead / total });
    }
  });

  onProgress?.({ uploaded: total, total, pct: 1, done: true });
  return res.data;
}

module.exports = { status, startAuth, completeAuth, disconnect, uploadWithProgress };
