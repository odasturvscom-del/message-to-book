import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseVideoInput } from './lib/youtube.js';
import { fetchTranscriptSafe } from './lib/transcript.js';
import { buildBook } from './lib/book.js';
import { generateDocx, slugify } from './lib/docx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/videos', async (req, res) => {
  try {
    const videos = await parseVideoInput(req.body.input);
    res.json({ videos });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/transcript', async (req, res) => {
  try {
    const t = await fetchTranscriptSafe(req.body.videoId);
    res.json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Build: fetch transcripts + structure the book. Returns JSON preview.
app.post('/api/book', async (req, res) => {
  try {
    const { videos, template } = req.body;
    if (!Array.isArray(videos) || !videos.length) throw new Error('Select at least one video.');
    const result = await buildBook(videos, template);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download the built book as docx.
app.post('/api/docx', async (req, res) => {
  try {
    const { book } = req.body;
    if (!book?.chapters?.length) throw new Error('Build the book first.');
    const buf = await generateDocx(book);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(book.title)}.docx"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Message to Book running on http://localhost:${port}`));
