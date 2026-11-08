# Message to Book

Turns a YouTube channel's messages (sermons, teachings, talks) into a book.

Open the site, paste video links or a channel URL/@handle, optionally upload a
Word template, and download the finished book as a .docx. Optionally add an
Anthropic API key for AI editing; it is used per request and never stored.
No sign-in and no accounts.

Hosted instance: https://message-to-book.odianageorge.workers.dev/

## Deploy your own

Cloudflare dashboard: Workers & Pages > Create > Import this repository as a
WORKER. Deploy command `npx wrangler deploy`, root directory `/`, no build
command. Or with the CLI:

```
npm install
npx wrangler deploy
```

Optional: add the secret `ANTHROPIC_API_KEY` in the Worker's settings
(Variables and Secrets) so books get AI editing without pasting a key.
Without it the app still works: it produces a cleanly split transcript book
so the pipeline can be tested.

Local development: `npm install && npx wrangler dev`.

## How it works

1. **Find videos** - paste video links (one per line) or a channel URL /
   @handle. Channels resolve without any API key or login via the channel's
   public feed; that feed lists the 15 most recent uploads, so paste links
   directly for anything older. Transcripts come straight off the video's
   captions (InnerTube player API, no YouTube API key needed).
2. **Shape the book** - title, author, editing level (light cleanup that
   keeps the spoken voice, or a full rewrite into book prose), preface, and
   an optional .docx template. The book follows the template: page size,
   margins and fonts, plus any {{title}}, {{author}}, {{preface}},
   {{chapter_title}}, {{chapter_body}} placeholders in it.
3. **Download the .docx** - generated in the browser.

## License

MIT
