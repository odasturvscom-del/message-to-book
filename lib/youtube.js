// Video + channel resolution without any API key.
// Public upload lists come from the channel's RSS feed (latest 15);
// anything past that is pasted in directly as links.

const VIDEO_ID_RE = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/;

export function extractVideoId(text) {
  const t = String(text || '').trim();
  const m = t.match(VIDEO_ID_RE);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  return null;
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

async function resolveFeedUrl(input) {
  const t = String(input || '').trim();

  const direct = t.match(/(UC[A-Za-z0-9_-]{22})/);
  if (direct) return `https://www.youtube.com/feeds/videos.xml?channel_id=${direct[1]}`;

  let handle = null;
  let h = t.match(/@([A-Za-z0-9._-]+)/);
  if (h) handle = h[1];
  if (!handle) {
    const c = t.match(/\/(?:c|user)\/([A-Za-z0-9._-]+)/);
    if (c) handle = c[1];
  }
  if (handle) {
    const res = await fetch(`https://www.youtube.com/@${handle}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
    });
    const html = await res.text();
    const id = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)?.[1]
      || html.match(/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1];
    if (id) return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  }
  return null;
}

export async function listChannelUploads(input) {
  const feedUrl = await resolveFeedUrl(input);
  if (!feedUrl) throw new Error('Could not resolve that channel. Paste a channel URL, @handle or UC... channel id, or paste video links directly.');
  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`YouTube returned ${res.status} for the channel feed.`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((e) => {
    const videoId = e[1].match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/)?.[1];
    const title = e[1].match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = e[1].match(/<published>([\s\S]*?)<\/published>/)?.[1];
    return videoId ? { videoId, title: decodeXml(title), published } : null;
  }).filter(Boolean);
  return entries;
}

// One box, two modes: paste video links/ids, or paste a channel and get its
// latest uploads. Mixed input works too.
export async function parseVideoInput(input) {
  const t = String(input || '').trim();
  if (!t) throw new Error('Paste some video links or a channel first.');

  const videos = [];
  const seen = new Set();

  // Channel / handle detection (a bare word with @, or a youtube channel URL)
  const looksLikeChannel = /@[\w.-]+|\/channel\/|\/c\/|\/user\/|UC[A-Za-z0-9_-]{22}/.test(t);
  if (looksLikeChannel) {
    try {
      const uploads = await listChannelUploads(t);
      for (const v of uploads) {
        if (!seen.has(v.videoId)) { seen.add(v.videoId); videos.push(v); }
      }
    } catch (e) {
      // fall through: the input may still contain video links
      if (!extractVideoId(t)) throw e;
    }
  }

  for (const token of t.split(/[\s,]+/)) {
    const id = extractVideoId(token);
    if (id && !seen.has(id)) { seen.add(id); videos.push({ videoId: id, title: '', published: null }); }
  }

  if (!videos.length) throw new Error('No videos found in that input.');
  return videos;
}
