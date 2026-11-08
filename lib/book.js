import { fetchTranscriptSafe } from './transcript.js';

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

async function aiBook(usable, tpl, env = {}) {
  const apiKey = env?.ANTHROPIC_API_KEY || (typeof process !== 'undefined' ? process.env.ANTHROPIC_API_KEY : undefined);
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

export async function buildBook(videoList, template = {}, env = {}) {
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
  const hasKey = env?.ANTHROPIC_API_KEY || (typeof process !== 'undefined' && process.env.ANTHROPIC_API_KEY);
  const book = hasKey ? await aiBook(usable, tpl, env) : fallbackBook(usable, tpl);
  return { template: tpl, sources, book };
}
