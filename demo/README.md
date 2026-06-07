# Demo Package

This folder is a small publishing kit for showing Video Summary to new users.

Use it for:

- A first-run smoke test.
- Screenshots or a short screen recording.
- Social posts explaining the plugin.
- A demo vault or sample notes.

## Suggested Demo Flow

1. Start the custom n8n Docker service.
2. Import `Obsidian Video Summary.json`.
3. Activate the workflow.
4. In Obsidian settings, run the setup check.
5. Open `sample-input-url.md`.
6. Run `Video Summary: summarize current note`.
7. Compare the result with `sample-output-note.md`.

For local files, put your test file in `docker/uploads` and use `sample-input-local-file.md`.

## Files

- `sample-input-url.md`: URL-based smoke test note.
- `sample-input-transcript.md`: No-downloader transcript test note.
- `sample-input-local-file.md`: Local file test note.
- `sample-output-note.md`: Example output shape.
- `demo-script-3min.md`: Short recording script.
- `xiaohongshu-post-draft.md`: Social post draft.
