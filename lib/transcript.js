import { YoutubeTranscript } from 'youtube-transcript';

// Pulls the caption track for a public video. Videos without captions
// need Whisper (documented in the README as the next step).
export async function fetchTranscriptSafe(videoId) {
  try {
    const parts = await YoutubeTranscript.fetchTranscript(videoId);
    if (!parts?.length) return { videoId, ok: false, error: 'No captions found for this video.' };
    const text = parts.map((p) => p.text.replace(/\s+/g, ' ').trim()).join(' ')
      .replace(/\s+([,.!?;:])/g, '$1');
    return { videoId, ok: true, text, words: text.split(/\s+/).length };
  } catch (e) {
    return { videoId, ok: false, error: String(e.message || e).slice(0, 200) };
  }
}
