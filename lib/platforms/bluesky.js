import { readMediaFile } from './shared.js';

const PDS = 'https://bsky.social';
const MAX_IMAGES = 4;

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function imageMimeType(url) {
  const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || 'image/jpeg';
}

// Bluesky has no third-party OAuth yet — the durable credential is an "app password" the
// user generates in their own settings. Access tokens (accessJwt) are short-lived (~2h), so
// rather than persist and refresh a session, we just log in fresh for every publish;
// scheduled posts go out at most a few times an hour per account, so the extra round trip is
// cheap and this sidesteps token-expiry bookkeeping entirely. `identifier` accepts a handle,
// email, or DID — we pass the DID stored at connect time.
async function createSession(did, appPassword) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: did, password: appPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.accessJwt) {
    throw new Error(`Bluesky login failed (${res.status}): ${data.message || 'check the stored app password'}`);
  }
  return data;
}

async function uploadImageBlob(accessJwt, media) {
  const buffer = await readMediaFile(media);
  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': imageMimeType(media.url) },
    body: buffer,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.blob) {
    throw new Error(`Bluesky media upload failed (${res.status}): ${data.message || 'unknown error'}`);
  }
  return data.blob;
}

// Bluesky doesn't linkify text server-side: a link or hashtag is only clickable if the post
// carries a "facet" marking it, by UTF-8 byte offsets into the text. This is a cut-down
// version of the official client's detectFacets — full http(s) URLs, bare domains on a short
// list of common TLDs (so "Node.js" or "v1.0" stay plain text), and #hashtags. @mentions
// aren't linked: that needs a handle -> DID lookup per mention.
const BARE_DOMAIN_TLDS = new Set(['com', 'co', 'org', 'net', 'io', 'dev', 'app', 'social', 'ai', 'me', 'xyz', 'sh', 'au', 'uk', 'de', 'eu']);
const TRAILING_PUNCTUATION = /[.,;:!?'")\]]+$/;

function byteOffset(text, index) {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

export function detectFacets(text) {
  const facets = [];
  const add = (start, end, feature) =>
    facets.push({ index: { byteStart: byteOffset(text, start), byteEnd: byteOffset(text, end) }, features: [feature] });

  for (const match of text.matchAll(/(^|[\s(])((https?:\/\/)?[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/\S*)?)/gi)) {
    const raw = match[2].replace(TRAILING_PUNCTUATION, '');
    const hasScheme = Boolean(match[3]);
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0];
    if (!hasScheme && !BARE_DOMAIN_TLDS.has(host.split('.').pop().toLowerCase())) continue;
    const start = match.index + match[1].length;
    add(start, start + raw.length, {
      $type: 'app.bsky.richtext.facet#link',
      uri: hasScheme ? raw : `https://${raw}`,
    });
  }

  // A tag needs at least one non-digit (so "#1" isn't one); trailing punctuation isn't part of it.
  for (const match of text.matchAll(/(^|\s)#([^\s#]+)/gu)) {
    const tag = match[2].replace(/\p{P}+$/u, '');
    if (!tag || /^\d+$/.test(tag) || tag.length > 64) continue;
    const start = match.index + match[1].length;
    add(start, start + 1 + tag.length, { $type: 'app.bsky.richtext.facet#tag', tag });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

export async function publish(post) {
  const media = post.media || [];
  if (media.some((m) => m.media_type === 'video')) {
    throw new Error('Bluesky video posting is not supported yet — attach images or remove the video.');
  }

  const { accessJwt, did } = await createSession(post.external_account_id, post.access_token);

  let embed;
  if (media.length > 0) {
    const images = [];
    for (const item of media.slice(0, MAX_IMAGES)) {
      const blob = await uploadImageBlob(accessJwt, item);
      images.push({ image: blob, alt: item.alt_text || '' });
    }
    embed = { $type: 'app.bsky.embed.images', images };
  }

  const facets = detectFacets(post.content);
  const record = {
    $type: 'app.bsky.feed.post',
    text: post.content,
    createdAt: new Date().toISOString(),
    ...(facets.length ? { facets } : {}),
    ...(embed ? { embed } : {}),
  };

  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.uri) {
    throw new Error(`Bluesky post failed (${res.status}): ${data.message || 'unknown error'}`);
  }
  return data.uri;
}

// Bluesky's public AppView serves post engagement counts unauthenticated — no need to spend
// an app-password login just to read stats. `platform_post_id` is the at:// URI returned by
// createRecord above. No "views" concept, same as most AT Proto apps.
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';

export async function fetchMetrics(post) {
  if (!post.platform_post_id) return null;

  const url = new URL(`${PUBLIC_APPVIEW}/xrpc/app.bsky.feed.getPosts`);
  url.searchParams.set('uris', post.platform_post_id);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Bluesky post lookup failed (${res.status})`);
  }
  const data = await res.json();
  const found = data.posts?.[0];
  if (!found) return null;
  return {
    views: null,
    likes: found.likeCount ?? null,
    comments: found.replyCount ?? null,
    shares: found.repostCount ?? null,
  };
}
