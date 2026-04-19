// Export adapters for YouTube / TikTok / Instagram / Twitter(X).
//
// Each adapter assumes the user has already authorized the app on the
// target platform and pasted the required tokens into Settings. That's
// intentional — this is a local-first tool and we don't ship a server,
// so user-level OAuth credentials are the simplest path.
//
// All adapters return { url, id } on success and throw on failure.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data') || null; // not required for all paths

// ---------------------------------------------------------------- YouTube
// Uses the YouTube Data API v3 resumable upload endpoint.
// Requires: clientId, clientSecret, refreshToken with `youtube.upload` scope.

async function refreshGoogleToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`YouTube token refresh failed: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function exportYouTube({ filePath, title, description, tags, credentials, onProgress }) {
  const accessToken = await refreshGoogleToken(credentials);
  const metadata = {
    snippet: {
      title: title || path.basename(filePath),
      description: description || '',
      tags: tags || [],
      categoryId: '22' // People & Blogs
    },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false }
  };

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/*'
      },
      body: JSON.stringify(metadata)
    }
  );
  if (!initRes.ok) throw new Error(`YouTube init failed: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('location');

  const total = fs.statSync(filePath).size;
  let uploaded = 0;
  const stream = fs.createReadStream(filePath);
  stream.on('data', (c) => {
    uploaded += c.length;
    onProgress?.({ uploaded, total, pct: uploaded / total });
  });

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Length': total, 'Content-Type': 'video/*' },
    body: stream
  });
  if (!uploadRes.ok) throw new Error(`YouTube upload failed: ${await uploadRes.text()}`);
  const out = await uploadRes.json();
  onProgress?.({ uploaded: total, total, pct: 1, done: true });
  return { id: out.id, url: `https://youtu.be/${out.id}` };
}

// ---------------------------------------------------------------- TikTok
// Uses Content Posting API. Requires an access token with video.upload scope.

async function exportTikTok({ filePath, title, credentials, onProgress }) {
  const { accessToken } = credentials;
  if (!accessToken) throw new Error('TikTok access token missing.');

  const size = fs.statSync(filePath).size;
  const init = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: size,
        total_chunk_count: 1
      }
    })
  });
  if (!init.ok) throw new Error(`TikTok init failed: ${await init.text()}`);
  const { data } = await init.json();
  const uploadUrl = data.upload_url;

  const body = fs.readFileSync(filePath);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': size,
      'Content-Range': `bytes 0-${size - 1}/${size}`
    },
    body
  });
  if (!putRes.ok) throw new Error(`TikTok upload failed: ${await putRes.text()}`);

  onProgress?.({ uploaded: size, total: size, pct: 1, done: true });
  return { id: data.publish_id, url: 'https://www.tiktok.com/' };
}

// ---------------------------------------------------------------- Instagram
// Graph API (Reels). Requires a hosted public URL for the video — most
// desktop users won't have one, so we warn. If you have one (e.g. a CDN
// or a presigned S3 URL) Parasite can finish the container + publish.

async function exportInstagram({ filePath, title, credentials, onProgress, hostedUrl }) {
  const { userId, accessToken } = credentials;
  if (!userId || !accessToken) throw new Error('Instagram userId/accessToken missing.');
  if (!hostedUrl) {
    throw new Error(
      "Instagram's Graph API requires a publicly reachable video URL. " +
      'Upload the file to a public bucket/CDN first and pass its URL as hostedUrl.'
    );
  }

  const create = await fetch(
    `https://graph.facebook.com/v21.0/${userId}/media?media_type=REELS&video_url=${encodeURIComponent(hostedUrl)}&caption=${encodeURIComponent(title || '')}&access_token=${accessToken}`,
    { method: 'POST' }
  );
  if (!create.ok) throw new Error(`Instagram container failed: ${await create.text()}`);
  const container = await create.json();

  const publish = await fetch(
    `https://graph.facebook.com/v21.0/${userId}/media_publish?creation_id=${container.id}&access_token=${accessToken}`,
    { method: 'POST' }
  );
  if (!publish.ok) throw new Error(`Instagram publish failed: ${await publish.text()}`);
  const out = await publish.json();
  onProgress?.({ uploaded: 1, total: 1, pct: 1, done: true });
  return { id: out.id, url: `https://www.instagram.com/reel/${out.id}/` };
}

// ---------------------------------------------------------------- Twitter/X
// Uses v1.1 chunked media upload (v2 tweets endpoint for the post).
// Requires: apiKey, apiSecret, accessToken, accessSecret (user context OAuth1).

async function exportTwitter({ filePath, title, credentials, onProgress }) {
  // Note: full OAuth1 signing is non-trivial; keeping this as a clear
  // integration point. Recommended: use the `twitter-api-v2` npm package
  // once you have the four keys. For now throw a descriptive error so
  // users know exactly what to add.
  throw new Error(
    'Twitter/X export needs twitter-api-v2 integration with your four OAuth1 keys. ' +
    'Add apiKey, apiSecret, accessToken, accessSecret under Settings > Exports > Twitter.'
  );
}

// ---------------------------------------------------------------- Dispatcher

async function run(platform, opts) {
  switch (platform) {
    case 'youtube':   return exportYouTube(opts);
    case 'tiktok':    return exportTikTok(opts);
    case 'instagram': return exportInstagram(opts);
    case 'twitter':   return exportTwitter(opts);
    default: throw new Error(`Unknown export platform: ${platform}`);
  }
}

module.exports = { run };
