// Google Drive integration.
// Uses installed-app OAuth with a local loopback server for a seamless
// one-click auth flow — no code-pasting required.
// Credentials live in Settings (electron-store) so nothing is hardcoded here.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

function buildClient(store) {
  const clientId = process.env.GDRIVE_CLIENT_ID || store.get('drive.clientId');
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET || store.get('drive.clientSecret');
  if (!clientId || !clientSecret) {
    throw new Error('Drive is not configured. Add Client ID / Client Secret in Settings → Google Drive.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
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

// Opens a local HTTP server, generates the OAuth URL, calls openUrl(url) so
// the main process can open the browser, then waits for Google to redirect
// back with the auth code. Completes auth automatically — no code-pasting.
// Resolves { connected: true } or rejects on timeout / user denial.
async function startAuth(store, openUrl) {
  const client = buildClient(store);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
        if (parsed.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }

        const code  = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');

        const page = (msg) =>
          `<html><body style="font-family:sans-serif;background:#202225;color:#dcddde;padding:40px">${msg}<p>You can close this tab and return to Parasite.</p></body></html>`;

        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(page('<h2>Authorization cancelled.</h2>'));
          server.close();
          clearTimeout(timer);
          reject(new Error(`Authorization denied: ${error || 'no code'}`));
          return;
        }

        const { tokens } = await client.getToken(code);
        store.set('drive.tokens', tokens);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page('<h2>✓ Parasite is connected to Google Drive!</h2>'));
        server.close();
        clearTimeout(timer);
        resolve({ connected: true });
      } catch (e) {
        server.close();
        clearTimeout(timer);
        reject(e);
      }
    });

    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start auth server on port ${REDIRECT_PORT}: ${e.message}`));
    });

    // 5-minute timeout — user took too long or closed the browser.
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Authorization timed out after 5 minutes. Please try again.'));
    }, 5 * 60 * 1000);

    server.listen(REDIRECT_PORT, '127.0.0.1', () => openUrl(url));
  });
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
  // Persist refreshed tokens automatically.
  client.on('tokens', (t) => store.set('drive.tokens', { ...tokens, ...t }));
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
  const total = fs.statSync(filePath).size;

  const res = await driveApi.files.create({
    requestBody: { name: path.basename(filePath), parents: [folderId] },
    media: { mimeType: 'video/*', body: fs.createReadStream(filePath) },
    fields: 'id, name, webViewLink'
  }, {
    onUploadProgress: (evt) => {
      onProgress?.({ uploaded: evt.bytesRead, total, pct: evt.bytesRead / total });
    }
  });

  onProgress?.({ uploaded: total, total, pct: 1, done: true });
  return res.data;
}

module.exports = { status, startAuth, disconnect, uploadWithProgress };
