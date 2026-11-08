import { parseVideoInput } from './lib/youtube.js';
import { fetchTranscriptSafe } from './lib/transcript.js';
import { buildBook } from './lib/book.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) return fetch(request);

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
        return json(await buildBook(body.videos, body.template || {}, env));
      }

      return json({ error: 'Unknown endpoint.' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
  },
};
