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
const HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Message to Book</title>\n<style>\n  :root { --ink:#1c1c1e; --line:#e2e2e6; --accent:#1a73e8; }\n  * { box-sizing:border-box; }\n  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink); max-width:820px; margin:0 auto; padding:32px 20px 80px; background:#fafafa; }\n  h1 { font-size:28px; margin:0 0 4px; }\n  .sub { color:#666; margin:0 0 28px; }\n  label { display:block; font-size:13px; font-weight:600; margin:16px 0 6px; }\n  textarea, input, select { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font:inherit; background:#fff; }\n  textarea { min-height:90px; resize:vertical; }\n  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:11px 20px; font:inherit; font-weight:600; cursor:pointer; margin-top:16px; }\n  button:disabled { opacity:.45; cursor:default; }\n  button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }\n  .videos { border:1px solid var(--line); border-radius:8px; background:#fff; margin-top:10px; max-height:340px; overflow:auto; }\n  .videos label.item { display:flex; gap:10px; padding:10px 14px; border-bottom:1px solid var(--line); font-weight:400; font-size:14px; margin:0; align-items:flex-start; cursor:pointer; }\n  .videos label.item:last-child { border-bottom:0; }\n  .videos .meta { color:#888; font-size:12px; }\n  .status { margin-top:14px; font-size:14px; color:#555; }\n  .status.err { color:#c0392b; }\n  .preview { border:1px solid var(--line); border-radius:8px; background:#fff; padding:18px 20px; margin-top:10px; }\n  .preview h3 { margin:14px 0 4px; font-size:15px; }\n  .preview .wordcount { color:#888; font-size:12px; font-weight:400; }\n  .preview .bad { color:#c0392b; font-size:13px; }\n  .hint { font-size:12px; color:#888; margin-top:4px; }\n  fieldset { border:1px solid var(--line); border-radius:8px; margin-top:22px; padding:0 18px 6px; background:#fff; }\n  legend { font-weight:700; font-size:14px; padding:0 6px; }\n</style>\n</head>\n<body>\n  <h1>Message to Book</h1>\n  <p class=\"sub\">Pick YouTube messages, pull the transcripts, and turn them into a book.</p>\n\n  <label for=\"input\">Videos or channel</label>\n  <textarea id=\"input\" placeholder=\"Paste video links (one per line), a channel URL or @handle\"></textarea>\n  <div class=\"hint\">A channel gives you its 15 most recent uploads; paste links for anything older.</div>\n  <button id=\"fetchBtn\">Find videos</button>\n  <div id=\"videoList\"></div>\n\n  <fieldset>\n    <legend>Book template</legend>\n    <label for=\"bookTitle\">Book title</label>\n    <input id=\"bookTitle\" placeholder=\"Leave blank and the AI names the book\">\n    <label for=\"author\">Author</label>\n    <input id=\"author\" placeholder=\"Author name for the title page\">\n    <label for=\"editing\">Editing level</label>\n    <select id=\"editing\">\n      <option value=\"tidy\">Tidy (light cleanup, keeps the spoken voice)</option>\n      <option value=\"rewritten\">Rewritten (full book prose)</option>\n    </select>\n    <label for=\"preface\">Preface</label>\n    <textarea id=\"preface\" placeholder=\"Leave blank and the AI writes one\"></textarea>\n    <label for=\"apiKey\">Anthropic API key</label>\n    <input id=\"apiKey\" placeholder=\"Paste an Anthropic API key: sk-ant-...\">\n    <div class=\"hint\">Used for AI book writing. Not stored; enter it again next time. Leave blank to build without AI cleanup.</div>\n  </fieldset>\n\n  <button id=\"buildBtn\" disabled>Build book</button>\n  <div id=\"status\"></div>\n  <div id=\"preview\"></div>\n  <button id=\"downloadBtn\" class=\"secondary\" disabled>Download .docx</button>\n\n<script src=\"/docx.min.js\"></script>\n<script>\nconst $ = (id) => document.getElementById(id);\nlet videos = [];\nlet book = null;\n\n$('fetchBtn').onclick = async () => {\n  $('fetchBtn').disabled = true;\n  $('status').textContent = 'Looking up videos...'; $('status').className = 'status';\n  try {\n    const r = await fetch('/api/videos', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ input: $('input').value }) });\n    const j = await r.json();\n    if (!r.ok) throw new Error(j.error || 'Lookup failed');\n    videos = j.videos;\n    $('videoList').innerHTML = '<div class=\"videos\">' + videos.map((v, i) =>\n      `<label class=\"item\"><input type=\"checkbox\" checked data-i=\"${i}\"><span><div>${v.title || v.videoId}</div><div class=\"meta\">${v.published ? v.published.slice(0,10) + ' \u00b7 ' : ''}${v.videoId}</div></span></label>`\n    ).join('') + '</div>';\n    $('buildBtn').disabled = false;\n    $('status').textContent = videos.length + ' videos found. Select the ones for the book.';\n  } catch (e) {\n    $('status').textContent = e.message; $('status').className = 'status err';\n  }\n  $('fetchBtn').disabled = false;\n};\n\n$('buildBtn').onclick = async () => {\n  const selected = [...document.querySelectorAll('#videoList input:checked')].map(el => videos[el.dataset.i]);\n  if (!selected.length) { $('status').textContent = 'Select at least one video.'; $('status').className = 'status err'; return; }\n  $('buildBtn').disabled = true; $('downloadBtn').disabled = true;\n  $('status').textContent = 'Fetching transcripts and building the book. This can take a few minutes for long messages...'; $('status').className = 'status';\n  try {\n    const r = await fetch('/api/book', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ videos: selected, template: { bookTitle: $('bookTitle').value, author: $('author').value, editing: $('editing').value, preface: $('preface').value, apiKey: $('apiKey').value } }) });\n    const j = await r.json();\n    if (!r.ok) throw new Error(j.error || 'Build failed');\n    book = j.book;\n    const failed = j.sources.filter(s => !s.ok);\n    $('preview').innerHTML =\n      '<div class=\"preview\"><strong>' + book.title + '</strong>' + (book.author ? ' \u00b7 ' + book.author : '') +\n      (book.aiUsed ? '' : '<div class=\"hint\">Built without AI cleanup: add an Anthropic API key in the form for full book writing.</div>') +\n      (book.preface ? '<h3>Preface</h3><p style=\"font-size:13px;color:#555\">' + book.preface.slice(0, 300) + (book.preface.length > 300 ? '...' : '') + '</p>' : '') +\n      '<h3>' + book.chapters.length + ' chapters</h3>' +\n      book.chapters.map(c => '<div style=\"font-size:13px;margin:6px 0\">' + c.title + ' <span class=\"wordcount\">' + (c.body.split(/\\s+/).length) + ' words</span></div>').join('') +\n      (failed.length ? '<h3 class=\"bad\">' + failed.length + ' video(s) had no transcript</h3>' + failed.map(s => '<div class=\"bad\">' + (s.title || s.videoId) + ': ' + s.error + '</div>').join('') : '') +\n      '</div>';\n    $('downloadBtn').disabled = false;\n    $('status').textContent = 'Book ready.';\n  } catch (e) {\n    $('status').textContent = e.message; $('status').className = 'status err';\n  }\n  $('buildBtn').disabled = false;\n};\n\nfunction mdParagraphs(md, D) {\n  const out = [];\n  for (const rawLine of String(md || '').split(/\\n/)) {\n    const line = rawLine.trimEnd();\n    if (!line.trim()) { out.push(new D.Paragraph({ text: '' })); continue; }\n    if (line.startsWith('### ')) out.push(new D.Paragraph({ text: line.slice(4), heading: D.HeadingLevel.HEADING_3 }));\n    else if (line.startsWith('## ') || line.startsWith('# ')) out.push(new D.Paragraph({ text: line.replace(/^#+ /, ''), heading: D.HeadingLevel.HEADING_2 }));\n    else {\n      const runs = line.split(/(\\*\\*[^*]+\\*\\*)/g).filter(Boolean).map(seg =>\n        seg.startsWith('**') ? new D.TextRun({ text: seg.slice(2, -2), bold: true }) : new D.TextRun(seg));\n      out.push(new D.Paragraph({ children: runs, spacing: { after: 160 } }));\n    }\n  }\n  return out;\n}\n\n$('downloadBtn').onclick = async () => {\n  if (!book) return;\n  $('status').textContent = 'Building the Word file...'; $('status').className = 'status';\n  try {\n    const D = window.docx;\n    const children = [];\n    children.push(new D.Paragraph({ text: book.title || 'Untitled Book', heading: D.HeadingLevel.TITLE, alignment: D.AlignmentType.CENTER, spacing: { before: 3200, after: 400 } }));\n    if (book.author) children.push(new D.Paragraph({ text: book.author, alignment: D.AlignmentType.CENTER }));\n    children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n    children.push(new D.Paragraph({ text: 'Contents', heading: D.HeadingLevel.HEADING_1 }));\n    book.chapters.forEach((c, i) => children.push(new D.Paragraph({ text: (i + 1) + '. ' + c.title, spacing: { after: 80 } })));\n    children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n    if (book.preface) {\n      children.push(new D.Paragraph({ text: 'Preface', heading: D.HeadingLevel.HEADING_1 }));\n      children.push(...mdParagraphs(book.preface, D));\n      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n    }\n    book.chapters.forEach((c, i) => {\n      children.push(new D.Paragraph({ text: 'Chapter ' + (i + 1) + ': ' + c.title, heading: D.HeadingLevel.HEADING_1 }));\n      if (c.sourceVideo) children.push(new D.Paragraph({ children: [new D.TextRun({ text: 'Source message: https://www.youtube.com/watch?v=' + c.sourceVideo, italics: true, size: 18, color: '666666' })], spacing: { after: 240 } }));\n      children.push(...mdParagraphs(c.body, D));\n      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));\n    });\n    const doc = new D.Document({ sections: [{ properties: {}, children }] });\n    const blob = await D.Packer.toBlob(doc);\n    const a = document.createElement('a');\n    a.href = URL.createObjectURL(blob);\n    a.download = book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.docx';\n    a.click();\n    $('status').textContent = 'Downloaded.';\n  } catch (e) {\n    $('status').textContent = 'Download failed: ' + e.message; $('status').className = 'status err';\n  }\n};\n</script>\n</body>\n</html>\n";

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


const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/docx.min.js') return docxResponse();
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
