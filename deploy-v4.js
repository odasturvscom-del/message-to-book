// Message to Book - single-file Cloudflare Worker (libs inlined, docx proxied)
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

export const DEFAULT_TEMPLATE = {
  bookTitle: '',      // blank = the AI names the book
  author: '',
  editing: 'tidy',    // tidy = light cleanup | rewritten = full book prose
  preface: '',        // blank = the AI writes one
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function claude(system, user, apiKey, model, maxTokens = 8000) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI call failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  return j.content.map((c) => c.text || '').join('');
}

const chapterSystem = (tpl) => `You are a non-fiction book editor. You convert spoken messages (sermons, teachings, talks) into clean, readable book chapters.
Rules:
- Preserve the speaker's voice and first person ("I", "we"). Never write about the speaker in third person.
- Remove filler, false starts, repeated phrases, stage directions and timestamps.
- Fix grammar and flow, keep the content faithful: never invent stories, quotes, statistics or scripture.
- Keep scripture references exactly as quoted; add the reference in brackets when it is clear, e.g. (John 3:16).
- Turn spoken audience interaction into smooth narrative ("a member of the congregation asked...").
- Use markdown: "## " subheadings wherever the message changes direction; paragraphs of 2-5 sentences.
${tpl.editing === 'rewritten'
    ? 'Editing level: rewritten. Fully rework the prose into polished book writing while keeping the voice and meaning.'
    : 'Editing level: tidy. Light cleanup only; stay close to the spoken wording.'}
Output ONLY the chapter text in markdown: no title line, no preamble, no commentary.`;

function chapterPrompt(source) {
  return `Video title: "${source.title || 'Untitled message'}"\n\nFull transcript:\n\n${source.text}`;
}

const metaSystem = `You are a book editor. Given the chapters of a book assembled from spoken messages, produce a short JSON object with the book's title and preface. Reply with ONLY valid JSON, no markdown fences: {"title": "...", "preface": "..."}. The title is at most 8 words, no subtitle. The preface is 120-180 words, warm and plain, introducing the book and how it came from spoken messages, written so the author could have said it.`;

async function aiBook(usable, tpl, env = {}, apiKey) {
  apiKey = apiKey || env?.ANTHROPIC_API_KEY || (typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined);
  const model = env?.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  const chapters = [];
  for (const s of usable) {
    let md = await claude(chapterSystem(tpl), chapterPrompt(s), apiKey, model, 8000);
    // drop a leading markdown title if the model added one anyway
    md = md.replace(/^#\s+.*\n+/, '').trim();
    chapters.push({ title: s.title || `Chapter ${chapters.length + 1}`, body: md, sourceVideo: s.videoId });
  }

  let metaObj = null;
  try {
    const outline = chapters.map((c, i) => `${i + 1}. "${c.title}" - opens with: ${c.body.slice(0, 200)}`).join('\n');
    const meta = await claude(metaSystem, `Template hints: ${JSON.stringify({ bookTitle: tpl.bookTitle, author: tpl.author, preface: tpl.preface })}\n\nChapters:\n${outline}`, apiKey, model, 2000);
    metaObj = JSON.parse(meta.match(/\{[\s\S]*\}/)[0]);
  } catch { /* meta is best-effort */ }

  return {
    title: tpl.bookTitle || metaObj?.title || 'Untitled Book',
    author: tpl.author || '',
    preface: tpl.preface || metaObj?.preface || '',
    chapters,
    aiUsed: true,
  };
}

// No API key: still a usable book, cleanly split, without AI rewriting.
function fallbackBook(usable, tpl) {
  const chapters = [];
  for (const s of usable) {
    const words = s.text.split(/\s+/);
    const chunk = 3500;
    const parts = Math.max(1, Math.ceil(words.length / chunk));
    for (let i = 0; i < parts; i++) {
      const body = words.slice(i * chunk, (i + 1) * chunk).join(' ');
      const para = body.replace(/(?<=[.!?])\s+(?=[A-Z"'(])/g, '\n\n');
      chapters.push({
        title: parts === 1 ? (s.title || `Chapter ${chapters.length + 1}`) : `${s.title || 'Message'} (Part ${i + 1})`,
        body: para,
        sourceVideo: s.videoId,
      });
    }
  }
  return {
    title: tpl.bookTitle || 'Untitled Book',
    author: tpl.author || '',
    preface: tpl.preface || '',
    chapters,
    aiUsed: false,
  };
}

export async function buildBook(videoList, template = {}, env = {}, apiKey) {
  const tpl = { ...DEFAULT_TEMPLATE, ...template };
  const sources = [];
  for (const v of videoList) {
    const t = await fetchTranscriptSafe(v.videoId);
    sources.push({ title: v.title || '', videoId: v.videoId, ok: t.ok, text: t.text || '', words: t.words || 0, error: t.error || null });
  }
  const usable = sources.filter((s) => s.ok && s.text.trim());
  if (!usable.length) {
    const errs = sources.map((s) => s.error).filter(Boolean).slice(0, 3).join('; ');
    throw new Error(`No transcripts available for the selected videos.${errs ? ' Details: ' + errs : ''}`);
  }
  const hasKey = apiKey || env?.ANTHROPIC_API_KEY || (typeof process !== 'undefined' && process.env.ANTHROPIC_API_KEY);
  const book = hasKey ? await aiBook(usable, tpl, env, apiKey) : fallbackBook(usable, tpl);
  return { template: tpl, sources, book };
}
const HTML = String.raw`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Message to Book</title>
<style>
  :root { --ink:#111114; --muted:#8a8f98; --line:#eceef2; --accent:#2f7cf6; --soft:#f2f4f8; }
  * { box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); max-width:760px; margin:0 auto; padding:44px 20px 90px; background:#eef0f4; }
  h1 { font-size:34px; font-weight:800; letter-spacing:-0.5px; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 30px; font-size:15px; }
  label { display:block; font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted); margin:18px 0 8px; }
  textarea, input, select { width:100%; padding:13px 16px; border:1px solid transparent; border-radius:12px; font:inherit; background:var(--soft); color:var(--ink); }
  textarea { min-height:96px; resize:vertical; }
  textarea:focus, input:focus, select:focus { outline:none; border-color:var(--accent); background:#fff; }
  button { background:var(--accent); color:#fff; border:0; border-radius:999px; padding:13px 28px; font:inherit; font-weight:700; cursor:pointer; margin-top:18px; }
  button:disabled { opacity:.4; cursor:default; }
  button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .videos { border:1px solid var(--line); border-radius:16px; background:#fff; margin-top:12px; max-height:340px; overflow:auto; box-shadow:0 10px 30px rgba(17,17,20,.05); }
  .videos label.item { display:flex; gap:12px; padding:13px 16px; border-bottom:1px solid var(--line); font-weight:500; font-size:14px; margin:0; align-items:flex-start; cursor:pointer; }
  .videos label.item:last-child { border-bottom:0; }
  .videos .meta { color:var(--muted); font-size:12px; }
  .status { margin-top:16px; font-size:14px; color:var(--muted); }
  .status.err { color:#e5484d; }
  .preview { border:1px solid var(--line); border-radius:16px; background:#fff; padding:20px 22px; margin-top:12px; box-shadow:0 10px 30px rgba(17,17,20,.05); }
  .preview h3 { margin:16px 0 6px; font-size:14px; font-weight:700; }
  .preview .wordcount { color:var(--muted); font-size:12px; font-weight:500; }
  .preview .bad { color:#e5484d; font-size:13px; }
  .hint { font-size:12px; color:var(--muted); margin-top:6px; }
  fieldset { border:0; border-radius:16px; margin-top:26px; padding:6px 20px 16px; background:#fff; box-shadow:0 10px 30px rgba(17,17,20,.05); }
  legend { font-weight:800; font-size:15px; padding:0 6px; }
  #gButton { margin-top:12px; }
</style>
</head>
<body>
  <h1>Message to Book</h1>
  <p class="sub">Pick YouTube messages, pull the transcripts, and turn them into a book.</p>

  <fieldset>
    <legend>Sign in</legend>
    <label for="gClientId">Google OAuth client ID</label>
    <input id="gClientId" placeholder="Paste a Google OAuth client ID: ...apps.googleusercontent.com">
    <div class="hint">One-time setup: in Google Cloud Console create an OAuth client ID (Web application), add this site's address as an Authorized JavaScript origin, then paste the ID here. Saved in this browser only.</div>
    <div id="gButton"></div>
    <div id="user" class="hint"></div>
  </fieldset>

  <label for="input">Videos or channel</label>
  <textarea id="input" placeholder="Paste video links (one per line), a channel URL or @handle"></textarea>
  <div class="hint">A channel gives you its 15 most recent uploads; paste links for anything older.</div>
  <button id="fetchBtn">Find videos</button>
  <div id="videoList"></div>

  <fieldset>
    <legend>Document template</legend>
    <label for="tplFile">Word template (.docx)</label>
    <input type="file" id="tplFile" accept=".docx">
    <div id="tplStatus" class="hint">Optional. The book follows the template: page size, margins and fonts, plus any {{title}}, {{author}}, {{preface}}, {{chapter_title}}, {{chapter_body}} placeholders in it.</div>
  </fieldset>

  <fieldset>
    <legend>Book template</legend>
    <label for="bookTitle">Book title</label>
    <input id="bookTitle" placeholder="Leave blank and the AI names the book">
    <label for="author">Author</label>
    <input id="author" placeholder="Author name for the title page">
    <label for="editing">Editing level</label>
    <select id="editing">
      <option value="tidy">Tidy (light cleanup, keeps the spoken voice)</option>
      <option value="rewritten">Rewritten (full book prose)</option>
    </select>
    <label for="preface">Preface</label>
    <textarea id="preface" placeholder="Leave blank and the AI writes one"></textarea>
    <label for="apiKey">Anthropic API key</label>
    <input id="apiKey" placeholder="Paste an Anthropic API key: sk-ant-...">
    <div class="hint">Used for AI book writing. Not stored; enter it again next time. Leave blank to build without AI cleanup.</div>
  </fieldset>

  <button id="buildBtn" disabled>Build book</button>
  <div id="status"></div>
  <div id="preview"></div>
  <button id="downloadBtn" class="secondary" disabled>Download .docx</button>

<script src="/jszip.min.js"></script>
<script src="/docx.min.js"></script>
<script>
const $ = (id) => document.getElementById(id);
let videos = [];
let book = null;
let session = null;

// ---- sign in with Google ----
async function loadGsi() {
  if (window.google && window.google.accounts && window.google.accounts.id) return;
  await new Promise((res) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  });
}

function showUser() {
  if (!session) { $('user').textContent = 'Not signed in. You can still build books; signing in records who built each one.'; return; }
  $('user').textContent = 'Signed in: ' + (session.name || session.email) + (session.email ? ' (' + session.email + ')' : '') + (session.role ? ' \u00b7 ' + session.role : '') + (session.handle ? ' \u00b7 ' + session.handle : '');
}

function askRole() {
  const role = prompt('Your role (e.g. Editor, Pastor, Admin):', session.role || '') || '';
  const handle = prompt('Your handle (e.g. @pastorjohn):', session.handle || '') || '';
  session.role = role.trim(); session.handle = handle.trim();
  localStorage.setItem('mtb_role', session.role);
  localStorage.setItem('mtb_handle', session.handle);
  showUser();
}

async function verifyToken(idToken) {
  const clientId = ($('gClientId').value || '').trim();
  const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken, clientId }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Sign-in failed');
  return j;
}

function initGoogle() {
  const clientId = ($('gClientId').value || '').trim();
  localStorage.setItem('mtb_client_id', clientId);
  $('gButton').innerHTML = '';
  if (!clientId || !window.google || !window.google.accounts) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: async (resp) => {
      try {
        const j = await verifyToken(resp.credential);
        session = { idToken: resp.credential, email: j.email, name: j.name || '', role: localStorage.getItem('mtb_role') || '', handle: localStorage.getItem('mtb_handle') || '' };
        localStorage.setItem('mtb_id_token', resp.credential);
        showUser(); askRole();
      } catch (e) { $('user').textContent = e.message; }
    },
  });
  google.accounts.id.renderButton($('gButton'), { theme: 'outline', size: 'large', width: 260 });
}

$('gClientId').addEventListener('change', () => { localStorage.removeItem('mtb_id_token'); session = null; initGoogle(); showUser(); });

(async () => {
  $('gClientId').value = localStorage.getItem('mtb_client_id') || '';
  showUser();
  await loadGsi();
  initGoogle();
  const saved = localStorage.getItem('mtb_id_token');
  if (saved && ($('gClientId').value || '').trim()) {
    try {
      const j = await verifyToken(saved);
      session = { idToken: saved, email: j.email, name: j.name || '', role: localStorage.getItem('mtb_role') || '', handle: localStorage.getItem('mtb_handle') || '' };
      showUser();
    } catch (e) { localStorage.removeItem('mtb_id_token'); }
  }
})();

/*tpl-start*/
function xmlAttr(tag, name) { const m = String(tag || '').match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : null; }
function firstTag(xml, name) { const m = String(xml || '').match(new RegExp('<' + name + '(\\s[^>]*)?/?>')); return m ? m[0] : null; }

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function runProps(xml) {
  const out = {};
  const rPr = xml.match(/<w:rPr[\s\S]*?<\/w:rPr>/);
  if (rPr) {
    const fonts = firstTag(rPr[0], 'w:rFonts');
    if (fonts) out.font = xmlAttr(fonts, 'w:ascii') || xmlAttr(fonts, 'w:hAnsi');
    const sz = firstTag(rPr[0], 'w:sz');
    if (sz) out.size = parseInt(xmlAttr(sz, 'w:val'), 10);
    if (/<w:b\s*\/>/.test(rPr[0])) out.bold = true;
    const color = firstTag(rPr[0], 'w:color');
    if (color) { const v = xmlAttr(color, 'w:val'); if (v && v !== 'auto') out.color = v; }
  }
  return out;
}

async function parseTemplate(file) {
  const zip = await window.JSZip.loadAsync(file);
  const read = async (p) => { const f = zip.file(p); return f ? await f.async('text') : null; };
  const docXml = await read('word/document.xml');
  if (!docXml) throw new Error('Not a Word document.');
  const stylesXml = (await read('word/styles.xml')) || '';

  const tpl = { paragraphs: [], page: null, defaults: {}, h1: {}, h2: {} };

  const sect = docXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  if (sect) {
    const pg = firstTag(sect[0], 'w:pgSz');
    const mar = firstTag(sect[0], 'w:pgMar');
    if (pg && mar) {
      tpl.page = {
        width: parseInt(xmlAttr(pg, 'w:w'), 10),
        height: parseInt(xmlAttr(pg, 'w:h'), 10),
        margin: {
          top: parseInt(xmlAttr(mar, 'w:top'), 10),
          bottom: parseInt(xmlAttr(mar, 'w:bottom'), 10),
          left: parseInt(xmlAttr(mar, 'w:left'), 10),
          right: parseInt(xmlAttr(mar, 'w:right'), 10),
        },
      };
    }
  }

  const def = stylesXml.match(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/);
  if (def) tpl.defaults = runProps(def[0]);

  for (const pair of [['h1', 'Heading1'], ['h2', 'Heading2']]) {
    const st = stylesXml.match(new RegExp('<w:style [^>]*w:styleId="' + pair[1] + '"[\\s\\S]*?</w:style>'));
    if (st) tpl[pair[0]] = runProps(st[0]);
  }

  for (const p of docXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    let text = '';
    for (const t of p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)) text += decodeEntities(t[1]);
    const jc = firstTag(p[0], 'w:jc');
    const props = runProps(p[0]);
    tpl.paragraphs.push({ text: text.trim(), center: jc ? xmlAttr(jc, 'w:val') === 'center' : false, font: props.font, size: props.size, bold: props.bold, color: props.color });
  }

  const flat = tpl.paragraphs.map((p) => p.text).join('\n');
  tpl.placeholders = [...new Set((flat.match(/\{\{\s*([\w. ]+?)\s*\}\}/g) || []).map((s) => s.toLowerCase()))];
  tpl.chTitle = tpl.paragraphs.findIndex((p) => p.text.toLowerCase().indexOf('{{chapter_title}}') !== -1);
  tpl.chBody = tpl.paragraphs.findIndex((p) => p.text.toLowerCase().indexOf('{{chapter_body}}') !== -1);
  tpl.useStructure = tpl.chTitle !== -1 && tpl.chBody !== -1 && tpl.chTitle < tpl.chBody;
  return tpl;
}

function mdPlain(md) {
  return String(md || '').split(/\n/).map((l) => l.replace(/^#{1,6}\s+/, '')).join('\n').split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
}

function tplStyles(tpl) {
  const styles = {};
  if (tpl.defaults && (tpl.defaults.font || tpl.defaults.size)) {
    styles.default = { document: { run: {} } };
    if (tpl.defaults.font) styles.default.document.run.font = tpl.defaults.font;
    if (tpl.defaults.size) styles.default.document.run.size = tpl.defaults.size;
  }
  for (const pair of [['h1', 'heading1'], ['h2', 'heading2']]) {
    const s = tpl[pair[0]];
    if (s && (s.font || s.size || s.color || s.bold)) {
      styles[pair[1]] = { run: { bold: !!s.bold } };
      if (s.font) styles[pair[1]].run.font = s.font;
      if (s.size) styles[pair[1]].run.size = s.size;
      if (s.color) styles[pair[1]].run.color = s.color;
    }
  }
  return styles;
}

function tplPage(tpl) {
  return tpl.page ? {
    page: {
      size: { width: tpl.page.width, height: tpl.page.height },
      margin: { top: tpl.page.margin.top, bottom: tpl.page.margin.bottom, left: tpl.page.margin.left, right: tpl.page.margin.right },
    },
  } : {};
}

function tplPara(p, text, D) {
  const run = new D.TextRun({ text, bold: !!p.bold, font: p.font, size: p.size, color: p.color });
  return new D.Paragraph({ children: [run], alignment: p.center ? D.AlignmentType.CENTER : undefined });
}

function tplSub(text, map) {
  return String(text).replace(/\{\{\s*([\w. ]+?)\s*\}\}/gi, (_, k) => {
    const v = map[String(k).toLowerCase().trim()];
    return v === undefined ? '' : v;
  });
}

function buildWithTemplate(book, tpl, D) {
  const children = [];
  const front = tpl.paragraphs.slice(0, tpl.chTitle);
  const back = tpl.paragraphs.slice(tpl.chBody + 1);
  const chTitleP = tpl.paragraphs[tpl.chTitle];
  const chBodyP = tpl.paragraphs[tpl.chBody];
  const preParts = book.preface ? String(book.preface).split(/\n\n+/) : [];
  for (const p of front) {
    if (p.text.toLowerCase().indexOf('{{preface}}') !== -1) {
      for (const part of (preParts.length ? preParts : [''])) children.push(tplPara(p, part, D));
    } else {
      children.push(tplPara(p, tplSub(p.text, { title: book.title || 'Untitled Book', author: book.author || '' }), D));
    }
  }
  for (const c of book.chapters) {
    children.push(tplPara(chTitleP, tplSub(chTitleP.text, { chapter_title: c.title }), D));
    for (const para of mdPlain(c.body)) children.push(tplPara(chBodyP, para, D));
  }
  for (const p of back) children.push(tplPara(p, tplSub(p.text, {}), D));
  return children;
}
/*tpl-end*/

$('tplFile').addEventListener('change', async () => {
  const f = $('tplFile').files[0];
  if (!f) { window.__tpl = null; $('tplStatus').textContent = 'Optional. The book follows the template: page size, margins and fonts, plus any {{title}}, {{author}}, {{preface}}, {{chapter_title}}, {{chapter_body}} placeholders in it.'; return; }
  $('tplStatus').textContent = 'Reading template...';
  try {
    window.__tpl = await parseTemplate(f);
    const bits = [];
    if (window.__tpl.page) bits.push('page setup and margins');
    if (window.__tpl.defaults.font) bits.push('base font ' + window.__tpl.defaults.font);
    bits.push(window.__tpl.useStructure ? 'placeholders found: the book follows the template layout' : 'no placeholders: the book keeps the standard layout with the template styling');
    $('tplStatus').textContent = 'Template loaded (' + f.name + '): ' + bits.join(', ') + '.';
  } catch (e) {
    window.__tpl = null;
    $('tplStatus').textContent = 'Could not read that template: ' + e.message;
  }
});

$('fetchBtn').onclick = async () => {
  $('fetchBtn').disabled = true;
  $('status').textContent = 'Looking up videos...'; $('status').className = 'status';
  try {
    const r = await fetch('/api/videos', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ input: $('input').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Lookup failed');
    videos = j.videos;
    $('videoList').innerHTML = '<div class="videos">' + videos.map((v, i) =>
      '<label class="item"><input type="checkbox" checked data-i="' + i + '"><span><div>' + (v.title || v.videoId) + '</div><div class="meta">' + (v.published ? v.published.slice(0,10) + ' \u00b7 ' : '') + v.videoId + '</div></div></span></label>'
    ).join('') + '</div>';
    $('buildBtn').disabled = false;
    $('status').textContent = videos.length + ' videos found. Select the ones for the book.';
  } catch (e) {
    $('status').textContent = e.message; $('status').className = 'status err';
  }
  $('fetchBtn').disabled = false;
};

$('buildBtn').onclick = async () => {
  const selected = [...document.querySelectorAll('#videoList input:checked')].map(el => videos[el.dataset.i]);
  if (!selected.length) { $('status').textContent = 'Select at least one video.'; $('status').className = 'status err'; return; }
  $('buildBtn').disabled = true; $('downloadBtn').disabled = true;
  $('status').textContent = 'Fetching transcripts and building the book. This can take a few minutes for long messages...'; $('status').className = 'status';
  try {
    const payload = {
      videos: selected,
      template: { bookTitle: $('bookTitle').value, author: $('author').value, editing: $('editing').value, preface: $('preface').value, apiKey: $('apiKey').value },
      session: session ? { idToken: session.idToken, clientId: ($('gClientId').value || '').trim(), role: session.role, handle: session.handle } : null,
    };
    const r = await fetch('/api/book', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Build failed');
    book = j.book;
    const failed = j.sources.filter(s => !s.ok);
    $('preview').innerHTML =
      '<div class="preview"><strong>' + book.title + '</strong>' + (book.author ? ' \u00b7 ' + book.author : '') +
      (book.aiUsed ? '' : '<div class="hint">Built without AI cleanup: add an Anthropic API key in the form for full book writing.</div>') +
      (book.preface ? '<h3>Preface</h3><p style="font-size:13px;color:#555">' + book.preface.slice(0, 300) + (book.preface.length > 300 ? '...' : '') + '</p>' : '') +
      '<h3>' + book.chapters.length + ' chapters</h3>' +
      book.chapters.map(c => '<div style="font-size:13px;margin:6px 0">' + c.title + ' <span class="wordcount">' + (c.body.split(/\s+/).length) + ' words</span></div>').join('') +
      (failed.length ? '<h3 class="bad">' + failed.length + ' video(s) had no transcript</h3>' + failed.map(s => '<div class="bad">' + (s.title || s.videoId) + ': ' + s.error + '</div>').join('') : '') +
      '</div>';
    $('downloadBtn').disabled = false;
    $('status').textContent = 'Book ready.';
  } catch (e) {
    $('status').textContent = e.message; $('status').className = 'status err';
  }
  $('buildBtn').disabled = false;
};

function mdParagraphs(md, D) {
  const out = [];
  for (const rawLine of String(md || '').split(/\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { out.push(new D.Paragraph({ text: '' })); continue; }
    if (line.startsWith('### ')) out.push(new D.Paragraph({ text: line.slice(4), heading: D.HeadingLevel.HEADING_3 }));
    else if (line.startsWith('## ') || line.startsWith('# ')) out.push(new D.Paragraph({ text: line.replace(/^#+ /, ''), heading: D.HeadingLevel.HEADING_2 }));
    else {
      const runs = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map(seg =>
        seg.startsWith('**') ? new D.TextRun({ text: seg.slice(2, -2), bold: true }) : new D.TextRun(seg));
      out.push(new D.Paragraph({ children: runs, spacing: { after: 160 } }));
    }
  }
  return out;
}

$('downloadBtn').onclick = async () => {
  if (!book) return;
  $('status').textContent = 'Building the Word file...'; $('status').className = 'status';
  try {
    const D = window.docx;
    let children;
    if (window.__tpl && window.__tpl.useStructure) {
      children = buildWithTemplate(book, window.__tpl, D);
    } else {
      children = [];
      children.push(new D.Paragraph({ text: book.title || 'Untitled Book', heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, spacing: { before: 3200, after: 400 } }));
      if (book.author) children.push(new D.Paragraph({ text: book.author, alignment: D.AlignmentType.CENTER }));
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      children.push(new D.Paragraph({ text: 'Contents', heading: D.HeadingLevel.HEADING_1 }));
      book.chapters.forEach((c, i) => children.push(new D.Paragraph({ text: (i + 1) + '. ' + c.title, spacing: { after: 80 } })));
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      if (book.preface) {
        children.push(new D.Paragraph({ text: 'Preface', heading: D.HeadingLevel.HEADING_1 }));
        children.push(...mdParagraphs(book.preface, D));
        children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      }
      book.chapters.forEach((c, i) => {
        children.push(new D.Paragraph({ text: 'Chapter ' + (i + 1) + ': ' + c.title, heading: D.HeadingLevel.HEADING_1 }));
        if (c.sourceVideo) children.push(new D.Paragraph({ children: [new D.TextRun({ text: 'Source message: https://www.youtube.com/watch?v=' + c.sourceVideo, italics: true, size: 18, color: '666666' })], spacing: { after: 240 } }));
        children.push(...mdParagraphs(c.body, D));
        children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
      });
    }
    const doc = new D.Document({
      styles: window.__tpl ? tplStyles(window.__tpl) : undefined,
      sections: [{ properties: window.__tpl ? tplPage(window.__tpl) : {}, children }],
    });
    const blob = await D.Packer.toBlob(doc);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.docx';
    a.click();
    $('status').textContent = 'Downloaded.' + (window.__tpl && window.__tpl.useStructure ? ' Built on your template.' : '');
  } catch (e) {
    $('status').textContent = 'Download failed: ' + e.message; $('status').className = 'status err';
  }
};
</script>
</body>
</html>
`;

const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@9.15.3/dist/index.umd.cjs';
let docxCache = null;
async function docxResponse() {
  if (docxCache) return new Response(docxCache, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
  const r = await fetch(DOCX_URL);
  const body = await r.text();
  if (!r.ok || body.length < 1000) return new Response('docx library unavailable', { status: 502 });
  docxCache = body;
  return new Response(body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}


const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
let jszipCache = null;
async function jszipResponse() {
  if (jszipCache) return new Response(jszipCache, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
  const r = await fetch(JSZIP_URL);
  const body = await r.text();
  if (!r.ok || body.length < 1000) return new Response('jszip library unavailable', { status: 502 });
  jszipCache = body;
  return new Response(body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

const tokenCache = new Map();
async function verifyGoogleToken(idToken, clientId) {
  const now = Date.now();
  const hit = tokenCache.get(idToken);
  if (hit && hit.until > now) return hit.info;
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) throw new Error('Google rejected the sign-in.');
  const info = await res.json();
  if (!info.email) throw new Error('Sign-in token had no email.');
  if (clientId && info.aud && info.aud !== clientId) throw new Error('That Google client ID does not match the sign-in.');
  tokenCache.set(idToken, { until: now + 30 * 60 * 1000, info });
  if (tokenCache.size > 500) tokenCache.clear();
  return info;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/docx.min.js') return docxResponse();
    if (url.pathname === '/jszip.min.js') return jszipResponse();
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    try {
      const body = await request.json().catch(() => ({}));

      if (url.pathname === '/api/videos') {
        return json({ videos: await parseVideoInput(body.input) });
      }

      if (url.pathname === '/api/transcript') {
        return json(await fetchTranscriptSafe(body.videoId));
      }

      if (url.pathname === '/api/session') {
        if (!body.idToken) throw new Error('Missing sign-in token.');
        const info = await verifyGoogleToken(body.idToken, body.clientId);
        return json({ email: info.email || '', name: info.name || '' });
      }

      if (url.pathname === '/api/book') {
        if (body.session && body.session.idToken) {
          try {
            const who = await verifyGoogleToken(body.session.idToken, body.session.clientId);
            console.info({ user: who.email, role: body.session.role || '', handle: body.session.handle || '', videos: body.videos.length });
          } catch (e) {
            return json({ error: 'Your sign-in has expired. Sign in again and rebuild. (' + String(e.message || e) + ')' }, 401);
          }
        }
        if (!Array.isArray(body.videos) || !body.videos.length) throw new Error('Select at least one video.');
        return json(await buildBook(body.videos, body.template || {}, env, body.apiKey));
      }

      return json({ error: 'Unknown endpoint.' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  },
};
