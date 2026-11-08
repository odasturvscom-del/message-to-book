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
const HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"theme-color\" content=\"#2f7cf6\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-status-bar-style\" content=\"default\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Message to Book\">\n<link rel=\"manifest\" href=\"/manifest.json\">\n<link rel=\"apple-touch-icon\" href=\"/icon-180.png\">\n<link rel=\"icon\" href=\"/icon-32.png\" sizes=\"32x32\">\n<title>Message to Book</title>\n<style>\n  :root { --ink:#111114; --muted:#8a8f98; --line:#eceef2; --accent:#2f7cf6; --soft:#f2f4f8; }\n  * { box-sizing:border-box; }\n  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); max-width:760px; margin:0 auto; padding:44px 20px 90px; background:#eef0f4; }\n  h1 { font-size:34px; font-weight:800; letter-spacing:-0.5px; margin:0 0 6px; }\n  .sub { color:var(--muted); margin:0 0 30px; font-size:15px; }\n  label { display:block; font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted); margin:18px 0 8px; }\n  textarea, input, select { width:100%; padding:13px 16px; border:1px solid transparent; border-radius:12px; font:inherit; background:var(--soft); color:var(--ink); }\n  textarea { min-height:96px; resize:vertical; }\n  textarea:focus, input:focus, select:focus { outline:none; border-color:var(--accent); background:#fff; }\n  button { background:var(--accent); color:#fff; border:0; border-radius:999px; padding:13px 28px; font:inherit; font-weight:700; cursor:pointer; margin-top:18px; }\n  button:disabled { opacity:.4; cursor:default; }\n  button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }\n  .videos { border:1px solid var(--line); border-radius:16px; background:#fff; margin-top:12px; max-height:340px; overflow:auto; box-shadow:0 10px 30px rgba(17,17,20,.05); }\n  .videos label.item { display:flex; gap:12px; padding:13px 16px; border-bottom:1px solid var(--line); font-weight:500; font-size:14px; margin:0; align-items:flex-start; cursor:pointer; }\n  .videos label.item:last-child { border-bottom:0; }\n  .videos .meta { color:var(--muted); font-size:12px; }\n  .status { margin-top:16px; font-size:14px; color:var(--muted); }\n  .status.err { color:#e5484d; }\n  .preview { border:1px solid var(--line); border-radius:16px; background:#fff; padding:20px 22px; margin-top:12px; box-shadow:0 10px 30px rgba(17,17,20,.05); }\n  .preview h3 { margin:16px 0 6px; font-size:14px; font-weight:700; }\n  .preview .wordcount { color:var(--muted); font-size:12px; font-weight:500; }\n  .preview .bad { color:#e5484d; font-size:13px; }\n  .hint { font-size:12px; color:var(--muted); margin-top:6px; }\n  fieldset { border:0; border-radius:16px; margin-top:26px; padding:6px 20px 16px; background:#fff; box-shadow:0 10px 30px rgba(17,17,20,.05); }\n  legend { font-weight:800; font-size:15px; padding:0 6px; }\n</style>\n</head>\n<body>\n  <h1>Message to Book</h1>\n  <p class=\"sub\">Pick YouTube messages, pull the transcripts, and turn them into a book.</p>\n\n  <label for=\"input\">Videos or channel</label>\n  <textarea id=\"input\" placeholder=\"Paste video links (one per line), a channel URL or @handle\"></textarea>\n  <div class=\"hint\">A channel gives you its 15 most recent uploads; paste links for anything older.</div>\n  <button id=\"fetchBtn\">Find videos</button>\n  <div id=\"videoList\"></div>\n\n  <fieldset>\n    <legend>Document template</legend>\n    <label for=\"tplFile\">Word template (.docx)</label>\n    <input type=\"file\" id=\"tplFile\" accept=\".docx\">\n    <div id=\"tplStatus\" class=\"hint\">Optional. The book follows the template: page size, margins and fonts, plus any {{title}}, {{author}}, {{preface}}, {{chapter_title}}, {{chapter_body}} placeholders in it.</div>\n  </fieldset>\n\n  <fieldset>\n    <legend>Book template</legend>\n    <label for=\"bookTitle\">Book title</label>\n    <input id=\"bookTitle\" placeholder=\"Leave blank and the AI names the book\">\n    <label for=\"author\">Author</label>\n    <input id=\"author\" placeholder=\"Author name for the title page\">\n    <label for=\"editing\">Editing level</label>\n    <select id=\"editing\">\n      <option value=\"tidy\">Tidy (light cleanup, keeps the spoken voice)</option>\n      <option value=\"rewritten\">Rewritten (full book prose)</option>\n    </select>\n    <label for=\"preface\">Preface</label>\n    <textarea id=\"preface\" placeholder=\"Leave blank and the AI writes one\"></textarea>\n    <label for=\"apiKey\">Anthropic API key</label>\n    <input id=\"apiKey\" placeholder=\"Paste an Anthropic API key: sk-ant-...\">\n    <div class=\"hint\">Used for AI book writing. Not stored; enter it again next time. Leave blank to build without AI cleanup.</div>\n  </fieldset>\n\n  <button id=\"buildBtn\" disabled>Build book</button>\n  <div id=\"status\"></div>\n  <div id=\"preview\"></div>\n  <button id=\"downloadBtn\" class=\"secondary\" disabled>Download .docx</button>\n\n<script src=\"/jszip.min.js\"></script>\n<script src=\"/docx.min.js\"></script>\n<script>\nconst $ = (id) => document.getElementById(id);\nlet videos = [];\nlet book = null;\n\n/*tpl-start*/\nfunction xmlAttr(tag, name) { const m = String(tag || '').match(new RegExp(name + '=\"([^\"]*)\"')); return m ? m[1] : null; }\nfunction firstTag(xml, name) { const m = String(xml || '').match(new RegExp('<' + name + '(\\\\s[^>]*)?/?>')); return m ? m[0] : null; }\n\nfunction decodeEntities(text) {\n  return String(text)\n    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')\n    .replace(/&quot;/g, '\"').replace(/&#39;/g, \"'\").replace(/&apos;/g, \"'\")\n    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))\n    .replace(/&#(\\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));\n}\n\nfunction runProps(xml) {\n  const out = {};\n  const rPr = xml.match(/<w:rPr[\\s\\S]*?<\\/w:rPr>/);\n  if (rPr) {\n    const fonts = firstTag(rPr[0], 'w:rFonts');\n    if (fonts) out.font = xmlAttr(fonts, 'w:ascii') || xmlAttr(fonts, 'w:hAnsi');\n    const sz = firstTag(rPr[0], 'w:sz');\n    if (sz) out.size = parseInt(xmlAttr(sz, 'w:val'), 10);\n    if (/<w:b\\s*\\/>/.test(rPr[0])) out.bold = true;\n    const color = firstTag(rPr[0], 'w:color');\n    if (color) { const v = xmlAttr(color, 'w:val'); if (v && v !== 'auto') out.color = v; }\n  }\n  return out;\n}\n\nasync function parseTemplate(file) {\n  const zip = await window.JSZip.loadAsync(file);\n  const read = async (p) => { const f = zip.file(p); return f ? await f.async('text') : null; };\n  const docXml = await read('word/document.xml');\n  if (!docXml) throw new Error('Not a Word document.');\n  const stylesXml = (await read('word/styles.xml')) || '';\n\n  const tpl = { paragraphs: [], page: null, defaults: {}, h1: {}, h2: {} };\n\n  const sect = docXml.match(/<w:sectPr[\\s\\S]*?<\\/w:sectPr>/);\n  if (sect) {\n    const pg = firstTag(sect[0], 'w:pgSz');\n    const mar = firstTag(sect[0], 'w:pgMar');\n    if (pg && mar) {\n      tpl.page = {\n        width: parseInt(xmlAttr(pg, 'w:w'), 10),\n        height: parseInt(xmlAttr(pg, 'w:h'), 10),\n        margin: {\n          top: parseInt(xmlAttr(mar, 'w:top'), 10),\n          bottom: parseInt(xmlAttr(mar, 'w:bottom'), 10),\n          left: parseInt(xmlAttr(mar, 'w:left'), 10),\n          right: parseInt(xmlAttr(mar, 'w:right'), 10),\n        },\n      };\n    }\n  }\n\n  const def = stylesXml.match(/<w:rPrDefault>[\\s\\S]*?<\\/w:rPrDefault>/);\n  if (def) tpl.defaults = runProps(def[0]);\n\n  for (const pair of [['h1', 'Heading1'], ['h2', 'Heading2']]) {\n    const st = stylesXml.match(new RegExp('<w:style [^>]*w:styleId=\"' + pair[1] + '\"[\\\\s\\\\S]*?</w:style>'));\n    if (st) tpl[pair[0]] = runProps(st[0]);\n  }\n\n  for (const p of docXml.matchAll(/<w:p\\b[\\s\\S]*?<\\/w:p>/g)) {\n    let text = '';\n    for (const t of p[0].matchAll(/<w:t[^>]*>([\\s\\S]*?)<\\/w:t>/g)) text += decodeEntities(t[1]);\n    const jc = firstTag(p[0], 'w:jc');\n    const props = runProps(p[0]);\n    tpl.paragraphs.push({ text: text.trim(), center: jc ? xmlAttr(jc, 'w:val') === 'center' : false, font: props.font, size: props.size, bold: props.bold, color: props.color });\n  }\n\n  const flat = tpl.paragraphs.map((p) => p.text).join('\\n');\n  tpl.placeholders = [...new Set((flat.match(/\\{\\{\\s*([\\w. ]+?)\\s*\\}\\}/g) || []).map((s) => s.toLowerCase()))];\n  tpl.chTitle = tpl.paragraphs.findIndex((p) => p.text.toLowerCase().indexOf('{{chapter_title}}') !== -1);\n  tpl.chBody = tpl.paragraphs.findIndex((p) => p.text.toLowerCase().indexOf('{{chapter_body}}') !== -1);\n  tpl.useStructure = tpl.chTitle !== -1 && tpl.chBody !== -1 && tpl.chTitle < tpl.chBody;\n  return tpl;\n}\n\nfunction mdPlain(md) {\n  return String(md || '').split(/\\n/).map((l) => l.replace(/^#{1,6}\\s+/, '')).join('\\n').split(/\\n\\n+/).map((s) => s.trim()).filter(Boolean);\n}\n\nfunction tplStyles(tpl) {\n  const styles = {};\n  if (tpl.defaults && (tpl.defaults.font || tpl.defaults.size)) {\n    styles.default = { document: { run: {} } };\n    if (tpl.defaults.font) styles.default.document.run.font = tpl.defaults.font;\n    if (tpl.defaults.size) styles.default.document.run.size = tpl.defaults.size;\n  }\n  for (const pair of [['h1', 'heading1'], ['h2', 'heading2']]) {\n    const s = tpl[pair[0]];\n    if (s && (s.font || s.size || s.color || s.bold)) {\n      styles[pair[1]] = { run: { bold: !!s.bold } };\n      if (s.font) styles[pair[1]].run.font = s.font;\n      if (s.size) styles[pair[1]].run.size = s.size;\n      if (s.color) styles[pair[1]].run.color = s.color;\n    }\n  }\n  return styles;\n}\n\nfunction tplPage(tpl) {\n  return tpl.page ? {\n    page: {\n      size: { width: tpl.page.width, height: tpl.page.height },\n      margin: { top: tpl.page.margin.top, bottom: tpl.page.margin.bottom, left: tpl.page.margin.left, right: tpl.page.margin.right },\n    },\n  } : {};\n}\n\nfunction tplPara(p, text, D) {\n  const run = new D.TextRun({ text, bold: !!p.bold, font: p.font, size: p.size, color: p.color });\n  return new D.Paragraph({ children: [run], alignment: p.center ? D.AlignmentType.CENTER : undefined });\n}\n\nfunction tplSub(text, map) {\n  return String(text).replace(/\\{\\{\\s*([\\w. ]+?)\\s*\\}\\}/gi, (_, k) => {\n    const v = map[String(k).toLowerCase().trim()];\n    return v === undefined ? '' : v;\n  });\n}\n\nfunction buildWithTemplate(book, tpl, D) {\n  const children = [];\n  const front = tpl.paragraphs.slice(0, tpl.chTitle);\n  const back = tpl.paragraphs.slice(tpl.chBody + 1);\n  const chTitleP = tpl.paragraphs[tpl.chTitle];\n  const chBodyP = tpl.paragraphs[tpl.chBody];\n  const preParts = book.preface ? String(book.preface).split(/\\n\\n+/) : [];\n  for (const p of front) {\n    if (p.text.toLowerCase().indexOf('{{preface}}') !== -1) {\n      for (const part of (preParts.length ? preParts : [''])) children.push(tplPara(p, part, D));\n    } else {\n      children.push(tplPara(p, tplSub(p.text, { title: book.title || 'Untitled Book', author: book.author || '' }), D));\n    }\n  }\n  for (const c of book.chapters) {\n    children.push(tplPara(chTitleP, tplSub(chTitleP.text, { chapter_title: c.title }), D));\n    for (const para of mdPlain(c.body)) children.push(tplPara(chBodyP, para, D));\n  }\n  for (const p of back) children.push(tplPara(p, tplSub(p.text, {}), D));\n  return children;\n}\n/*tpl-end*/\n\n$('tplFile').addEventListener('change', async () => {\n  const f = $('tplFile').files[0];\n  if (!f) { window.__tpl = null; $('tplStatus').textContent = 'Optional. The book follows the template: page size, margins and fonts, plus any {{title}}, {{author}}, {{preface}}, {{chapter_title}}, {{chapter_body}} placeholders in it.'; return; }\n  $('tplStatus').textContent = 'Reading template...';\n  try {\n    window.__tpl = await parseTemplate(f);\n    const bits = [];\n    if (window.__tpl.page) bits.push('page setup and margins');\n    if (window.__tpl.defaults.font) bits.push('base font ' + window.__tpl.defaults.font);\n    bits.push(window.__tpl.useStructure ? 'placeholders found: the book follows the template layout' : 'no placeholders: the book keeps the standard layout with the template styling');\n    $('tplStatus').textContent = 'Template loaded (' + f.name + '): ' + bits.join(', ') + '.';\n  } catch (e) {\n    window.__tpl = null;\n    $('tplStatus').textContent = 'Could not read that template: ' + e.message;\n  }\n});\n\n$('fetchBtn').onclick = async () => {\n  $('fetchBtn').disabled = true;\n  $('status').textContent = 'Looking up videos...'; $('status').className = 'status';\n  try {\n    const r = await fetch('/api/videos', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ input: $('input').value }) });\n    const j = await r.json();\n    if (!r.ok) throw new Error(j.error || 'Lookup failed');\n    videos = j.videos;\n    $('videoList').innerHTML = '<div class=\"videos\">' + videos.map((v, i) =>\n      '<label class=\"item\"><input type=\"checkbox\" checked data-i=\"' + i + '\"><span><div>' + (v.title || v.videoId) + '</div><div class=\"meta\">' + (v.published ? v.published.slice(0,10) + ' \\u00b7 ' : '') + v.videoId + '</div></div></span></label>'\n    ).join('') + '</div>';\n    $('buildBtn').disabled = false;\n    $('status').textContent = videos.length + ' videos found. Select the ones for the book.';\n  } catch (e) {\n    $('status').textContent = e.message; $('status').className = 'status err';\n  }\n  $('fetchBtn').disabled = false;\n};\n\n$('buildBtn').onclick = async () => {\n  const selected = [...document.querySelectorAll('#videoList input:checked')].map(el => videos[el.dataset.i]);\n  if (!selected.length) { $('status').textContent = 'Select at least one video.'; $('status').className = 'status err'; return; }\n  $('buildBtn').disabled = true; $('downloadBtn').disabled = true;\n  $('status').textContent = 'Fetching transcripts and building the book. This can take a few minutes for long messages...'; $('status').className = 'status';\n  try {\n    const payload = {\n      videos: selected,\n      template: { bookTitle: $('bookTitle').value, author: $('author').value, editing: $('editing').value, preface: $('preface').value, apiKey: $('apiKey').value },\n    };\n    const r = await fetch('/api/book', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });\n    const j = await r.json();\n    if (!r.ok) throw new Error(j.error || 'Build failed');\n    book = j.book;\n    const failed = j.sources.filter(s => !s.ok);\n    $('preview').innerHTML =\n      '<div class=\"preview\"><strong>' + book.title + '</strong>' + (book.author ? ' \\u00b7 ' + book.author : '') +\n      (book.aiUsed ? '' : '<div class=\"hint\">Built without AI cleanup: add an Anthropic API key in the form for full book writing.</div>') +\n      (book.preface ? '<h3>Preface</h3><p style=\"font-size:13px;color:#555\">' + book.preface.slice(0, 300) + (book.preface.length > 300 ? '...' : '') + '</p>' : '') +\n      '<h3>' + book.chapters.length + ' chapters</h3>' +\n      book.chapters.map(c => '<div style=\"font-size:13px;margin:6px 0\">' + c.title + ' <span class=\"wordcount\">' + (c.body.split(/\\s+/).length) + ' words</span></div>').join('') +\n      (failed.length ? '<h3 class=\"bad\">' + failed.length + ' video(s) had no transcript</h3>' + failed.map(s => '<div class=\"bad\">' + (s.title || s.videoId) + ': ' + s.error + '</div>').join('') : '') +\n      '</div>';\n    $('downloadBtn').disabled = false;\n    $('status').textContent = 'Book ready.';\n  } catch (e) {\n    $('status').textContent = e.message; $('status').className = 'status err';\n  }\n  $('buildBtn').disabled = false;\n};\n\nfunction mdParagraphs(md, D) {\n  const out = [];\n  for (const rawLine of String(md || '').split(/\\n/)) {\n    const line = rawLine.trimEnd();\n    if (!line.trim()) { out.push(new D.Paragraph({ text: '' })); continue; }\n    if (line.startsWith('### ')) out.push(new D.Paragraph({ text: line.slice(4), heading: D.HeadingLevel.HEADING_3 }));\n    else if (line.startsWith('## ') || line.startsWith('# ')) out.push(new D.Paragraph({ text: line.replace(/^#+ /, ''), heading: D.HeadingLevel.HEADING_2 }));\n    else {\n      const runs = line.split(/(\\*\\*[^*]+\\*\\*)/g).filter(Boolean).map(seg =>\n        seg.startsWith('**') ? new D.TextRun({ text: seg.slice(2, -2), bold: true }) : new D.TextRun(seg));\n      out.push(new D.Paragraph({ children: runs, spacing: { after: 160 } }));\n    }\n  }\n  return out;\n}\n\n$('downloadBtn').onclick = async () => {\n  if (!book) return;\n  $('status').textContent = 'Building the Word file...'; $('status').className = 'status';\n  try {\n    const D = window.docx;\n    let children;\n    if (window.__tpl && window.__tpl.useStructure) {\n      children = buildWithTemplate(book, window.__tpl, D);\n    } else {\n      children = [];\n      children.push(new D.Paragraph({ text: book.title || 'Untitled Book', heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, spacing: { before: 3200, after: 400 } }));\n      if (book.author) children.push(new D.Paragraph({ text: book.author, alignment: D.AlignmentType.CENTER }));\n      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n      children.push(new D.Paragraph({ text: 'Contents', heading: D.HeadingLevel.HEADING_1 }));\n      book.chapters.forEach((c, i) => children.push(new D.Paragraph({ text: (i + 1) + '. ' + c.title, spacing: { after: 80 } })));\n      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n      if (book.preface) {\n        children.push(new D.Paragraph({ text: 'Preface', heading: D.HeadingLevel.HEADING_1 }));\n        children.push(...mdParagraphs(book.preface, D));\n        children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n      }\n      book.chapters.forEach((c, i) => {\n        children.push(new D.Paragraph({ text: 'Chapter ' + (i + 1) + ': ' + c.title, heading: D.HeadingLevel.HEADING_1 }));\n        if (c.sourceVideo) children.push(new D.Paragraph({ children: [new D.TextRun({ text: 'Source message: https://www.youtube.com/watch?v=' + c.sourceVideo, italics: true, size: 18, color: '666666' })], spacing: { after: 240 } }));\n        children.push(...mdParagraphs(c.body, D));\n        children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n      });\n    }\n    const doc = new D.Document({\n      styles: window.__tpl ? tplStyles(window.__tpl) : undefined,\n      sections: [{ properties: window.__tpl ? tplPage(window.__tpl) : {}, children }],\n    });\n    const blob = await D.Packer.toBlob(doc);\n    const a = document.createElement('a');\n    a.href = URL.createObjectURL(blob);\n    a.download = book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.docx';\n    a.click();\n    $('status').textContent = 'Downloaded.' + (window.__tpl && window.__tpl.useStructure ? ' Built on your template.' : '');\n  } catch (e) {\n    $('status').textContent = 'Download failed: ' + e.message; $('status').className = 'status err';\n  }\n};\n</script>\n<script>if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); }</script>\n</body>\n</html>\n";

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


const ICON_192 = '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';
const ICON_512 = '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';
const ICON_180 = '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';
const ICON_32 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAC1ElEQVR42u2Wz0sVURTHv+feO/PGl79AfYqoWWkrTTD6abUrdyVREJFQtGgRRH9A22jZoqBVtAhaRKuif6GSVmYR9MMgpUzDfKavNzN3zmkx6us9J31GQlFnNcycO99zP+fcL5d6LuWwnqGwzvFf4O8RIIBo8ZlAv0WAAEXQClqBBfkQAgDIh4hk4b2igvAaBBRBESxj3sf0vMzkxGh0ZMgoENCRoZRBNifT8zLnw0YL+YlhEgonzPkAUFeJzQ2qu0X1tKmuFuUaHL6az0e4PphyDEbG+NkYj4zz20n+/BUi2OBBZDUBRcgFMtBrjvTqLRnVVFMobGq2sLy5lpprdX+3BjA5K6NT8nDY3ntqKxxiWVGACH6Ig126r1OXfFpaWVJmppoy1QToO09s2gVkNUQAAosvOTl3KzAKWmEmJxcOOX0dmhkRo9LD4zd85UFQnSYW+AGuDbo2IkjZPQCQdunEbqMVFJAPpbORAitEIEJg0VZHg33Gc0iA0KImTSxcbpMB2Agpg6PbiyhNZIUImuBbbGqg4zuL1oZR8rwmCIggZZD9JmdvBlpBE2ZycrHf2depmWEZVR4evebL94OaGFGIG6fdCoeYy0YUCTyHTu4pINraVIRoYz2d3l9AVOWRZS53B38YIsAPfgERw3Po1N4fESnfChEUIbBor6czB4znUFz72hEJUgYDvUWIPmUXexChvZ6O7ShGxMmIks1OBJYL9rnkIiIQlHp1PoTlBBdaqQcVLoyCUciHeDfFI+M8/J6fj3PcyfO3/a4W1dOqtrWqTQ0q7cYHM/EgLxMQgWPwYpwnszI0yq8m+OOMzPsCIOVQyoCA0Ul5+cHeHULapaZa6mykXZt1LhBHJeyDlt+LYr/Lh6IIKYccDa0WtGO/o0X3Z0YQwbcSD4VnEjbxkzF1UOFS7KAiiLg0IVr8k2sQz1KcWe4U/fiLlWPVzP/3on9A4DurQGpenVQFXwAAAABJRU5ErkJggg==';

function pngResponse(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}
async function iconResponse(size) {
  const map = { 192: ICON_192, 512: ICON_512, 180: ICON_180, 32: ICON_32 };
  const b64 = map[size];
  if (!b64) return new Response('Not found', { status: 404 });
  return pngResponse(b64);
}

const MANIFEST = JSON.stringify({
  name: 'Message to Book',
  short_name: 'M2B',
  description: 'Turn YouTube messages into books',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#eef0f4',
  theme_color: '#2f7cf6',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
function manifestResponse() {
  return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

const SW = `const CACHE = 'mtb-v5';
const ASSETS = ['/', '/jszip.min.js', '/docx.min.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-180.png', '/icon-32.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/') {
    e.respondWith(fetch(e.request).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; }).catch(() => caches.match('/')));
  } else {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })));
  }
});`;
function swResponse() {
  return new Response(SW, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/docx.min.js') return docxResponse();
    if (url.pathname === '/manifest.json') return manifestResponse();
    if (url.pathname === '/sw.js') return swResponse();
    if (url.pathname === '/icon-192.png') return iconResponse(192);
    if (url.pathname === '/icon-512.png') return iconResponse(512);
    if (url.pathname === '/icon-180.png') return iconResponse(180);
    if (url.pathname === '/icon-32.png') return iconResponse(32);
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

      if (url.pathname === '/api/book') {
        if (!Array.isArray(body.videos) || !body.videos.length) throw new Error('Select at least one video.');
        return json(await buildBook(body.videos, body.template || {}, env, body.apiKey));
      }

      return json({ error: 'Unknown endpoint.' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  },
};
