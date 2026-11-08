# Message to Book

Turns a YouTube channel's messages (sermons, teachings, talks) into a book.

Pick videos, pull their transcripts, restructure them through a template
(title, author, editing level, preface), and download the finished book
as a Word document. Runs as a Cloudflare Worker with no backend
dependencies; the Word file is built in the browser.

## Deploy

Cloudflare dashboard: Workers & Pages > Create > Import this repository
as a WORKER. Deploy command `npx wrangler deploy`, root directory `/`,
no build command. `wrangler.jsonc` supplies the worker name and serves
`public/` as static assets.

Then add the secret `ANTHROPIC_API_KEY` in the Worker's settings
(Variables and Secrets). Without it the app still works: it produces a
cleanly split transcript book so the pipeline can be tested.

Local development: `npm install && npm run dev`.

## How it works

1. **Find videos** - paste video links (one per line) or a channel URL /
   @handle. Channels resolve without any API key or login via the
   channel's public feed; that feed lists the 15 most recent uploads, so
   paste links directly for anything older. Transcripts come straight
   off the video's captions (InnerTube player API, watch-page fallback).
2. **Build book** - each selected video's transcript is fetched, then an
   AI editor restructures it into a book chapter following the template:
   filler removed, voice kept in first person, subheadings added,
   audience interaction turned into narrative. One pass names the book
   and writes the preface.
3. **Download** - the browser builds a .docx with a title page,
   contents, preface and the chapters, each tagged with its source
   video link.

## Template

Editing level "Tidy" stays close to the spoken wording; "Rewritten"
fully reworks the prose into polished book writing. Templates as saved
presets are the natural next step.

## Limits and next steps

- Videos without captions need audio transcription (Whisper) before
  they can be included; not wired up yet.
- The channel feed only exposes the latest 15 uploads. Full channel
  listing and pagination need the YouTube Data API with the owner's
  OAuth consent, worth adding when the client wants it.
- AI editing is one call per message; a 1-hour message is fine, but
  very long multi-hour messages should be split before processing.
- Output is Word. Print-ready / KDP formatting and PDF are next if the
  client wants print copies.

## Security

The Anthropic key lives only as a Worker secret on Cloudflare. It is
never sent to the browser and never committed.
