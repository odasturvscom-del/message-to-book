// Pulls the caption track for a public video via YouTube's InnerTube player
// API (Android client, the route that keeps working without login), with the
// watch page as fallback. No API key, no login. Videos without captions need
// audio transcription (Whisper) before they can be included.

const UA_ANDROID = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
const UA_WEB = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';

async function captionTracksFor(videoId) {
  // 1) InnerTube player API
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA_ANDROID },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) return tracks;
    }
  } catch { /* fall through to the web page */ }

  // 2) watch page scrape
  const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: { 'user-agent': UA_WEB, 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!page.ok) throw new Error(`YouTube returned ${page.status} for this video.`);
  const html = await page.text();
  const m = html.match(/"captionTracks":(\[.*?\])/s);
  if (!m) throw new Error('No captions found for this video.');
  return JSON.parse(m[1]);
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function parseTranscriptXml(xml, lang) {
  const out = [];
  // srv3 format: <p t="ms" d="ms"><s>word</s>...</p>
  for (const p of xml.matchAll(/<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    let text = '';
    for (const s of p[3].matchAll(/<s[^>]*>([^<]*)<\/s>/g)) text += s[1];
    if (!text) text = p[3].replace(/<[^>]+>/g, '');
    text = decodeEntities(text).trim();
    if (text) out.push(text);
  }
  if (out.length) return out;
  // classic format: <text start="s" dur="s">content</text>
  for (const t of xml.matchAll(/<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g)) {
    const text = decodeEntities(t[3]).trim();
    if (text) out.push(text);
  }
  return out;
}

export async function fetchTranscriptSafe(videoId) {
  try {
    const tracks = await captionTracksFor(videoId);
    const track = tracks.find((t) => (t.languageCode || '').startsWith('en')) || tracks[0];
    if (!track?.baseUrl) throw new Error('No usable caption track.');

    const res = await fetch(track.baseUrl, { headers: { 'user-agent': UA_WEB } });
    if (!res.ok) throw new Error(`Caption fetch returned ${res.status}.`);
    const xml = await res.text();
    const parts = parseTranscriptXml(xml, track.languageCode || 'en');
    if (!parts.length) throw new Error('Caption track was empty.');

    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return { videoId, ok: true, text, words: text.split(/\s+/).length };
  } catch (e) {
    return { videoId, ok: false, error: String(e.message || e).slice(0, 200) };
  }
}
