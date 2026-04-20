const fetch = require('node-fetch');

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

function extractTwitchVodId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a Twitch VOD URL or numeric VOD ID.');
  if (/^\d+$/.test(raw)) return raw;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Paste a Twitch VOD URL or numeric VOD ID.');
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  const videosIndex = parts.findIndex((part) => part === 'videos');
  if (videosIndex >= 0 && /^\d+$/.test(parts[videosIndex + 1] || '')) {
    return parts[videosIndex + 1];
  }

  throw new Error('Could not find a Twitch VOD ID in that input.');
}

async function fetchVideoCommentsPage({ vodId, cursor = null, offsetSec = 0 }) {
  const variables = {
    videoID: String(vodId),
    contentOffsetSeconds: cursor ? null : Number(offsetSec || 0),
    cursor
  };

  const response = await fetch(TWITCH_GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      operationName: 'VideoCommentsByOffsetOrCursor',
      variables,
      query: `
        query VideoCommentsByOffsetOrCursor($videoID: ID!, $contentOffsetSeconds: Float, $cursor: String) {
          video(id: $videoID) {
            comments(contentOffsetSeconds: $contentOffsetSeconds, after: $cursor) {
              edges {
                cursor
                node {
                  id
                  contentOffsetSeconds
                  createdAt
                  message {
                    fragments {
                      text
                      emote {
                        emoteID
                        emoteSetID
                      }
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      `
    })
  });

  if (!response.ok) {
    throw new Error(`Twitch chat replay request failed: ${response.status}`);
  }

  const payload = await response.json();
  const graph = Array.isArray(payload) ? payload[0] : payload;
  if (graph?.errors?.length) {
    throw new Error(graph.errors.map((error) => error.message).join('; '));
  }

  const comments = graph?.data?.video?.comments;
  return {
    edges: comments?.edges || [],
    hasNextPage: !!comments?.pageInfo?.hasNextPage
  };
}

async function *iterateTwitchVodComments({ vodId, cursor = null, offsetSec = 0, onPage, isCancelled }) {
  let nextCursor = cursor;
  let nextOffsetSec = offsetSec;
  let hasNextPage = true;

  while (hasNextPage) {
    if (isCancelled?.()) throw new Error('Heatmap build cancelled.');
    const page = await fetchVideoCommentsPage({ vodId, cursor: nextCursor, offsetSec: nextOffsetSec });
    if (!page.edges.length) break;

    let furthestOffsetSec = nextOffsetSec;
    for (const edge of page.edges) {
      const node = edge?.node;
      if (!node) continue;
      const messageOffsetSec = Number(node.contentOffsetSeconds || 0);
      furthestOffsetSec = Math.max(furthestOffsetSec, messageOffsetSec);
      nextCursor = edge.cursor || nextCursor;
      yield {
        offsetSec: messageOffsetSec,
        text: flattenMessageText(node.message)
      };
    }

    nextOffsetSec = furthestOffsetSec;
    hasNextPage = page.hasNextPage;
    onPage?.({
      cursor: nextCursor,
      lastOffsetSec: furthestOffsetSec,
      hasNextPage
    });
  }
}

function flattenMessageText(message) {
  const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
  const text = fragments.map((fragment) => {
    if (typeof fragment?.text === 'string') return fragment.text;
    if (fragment?.emote?.emoteID) return `[emote:${fragment.emote.emoteID}]`;
    return '';
  }).join('');
  return text.trim();
}

module.exports = {
  TWITCH_PUBLIC_CLIENT_ID,
  extractTwitchVodId,
  iterateTwitchVodComments
};
