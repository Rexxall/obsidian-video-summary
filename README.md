# Video Summary

Turn videos, local recordings, and rough transcripts into structured Obsidian notes.

Video Summary connects an Obsidian command surface with your own n8n workflow. The plugin stays focused on note operations inside the vault: it finds video metadata, sends the selected input to your webhook, receives a Markdown result, updates frontmatter, keeps processing history, and supports batch work.

## What it does

- Process a note that contains a video URL, a local media path, or a pasted transcript.
- Save the result as a clean Markdown note with headings, callouts, tables, links, and frontmatter.
- Extract transcript only, update video metadata only, or generate a full note.
- Process many notes from a batch panel with status isolation, retry handling, and progress logs.
- Keep multiple webhook profiles so you can switch between local, remote, and test workflows.
- Cache repeated URL and mode combinations to avoid unnecessary repeated processing.
- Rename processed notes from returned video metadata while handling filename conflicts.

## Typical workflow

1. Create a note with a `link` property or paste a video URL in the note body.
2. Run `Video Summary: summarize current note` from the command palette.
3. The plugin sends the request to your configured n8n webhook.
4. The n8n workflow handles download, transcript extraction, and note generation.
5. The plugin inserts the returned Markdown and writes processing metadata back to the note.

```yaml
---
link: 'https://www.youtube.com/watch?v=example'
status: pending
---
```

## Install

### Manual install

```bash
git clone https://github.com/Rexxall/obsidian-video-summary-plugin.git
cd obsidian-video-summary-plugin
npm install
npm run build
```

Copy these files into your vault plugin folder:

```text
main.js
manifest.json
styles.css
Obsidian Video Summary.json
```

Recommended folder:

```text
<your-vault>/.obsidian/plugins/video-summary/
```

Restart Obsidian, then enable `Video Summary` from `Settings -> Community plugins`.

### n8n workflow

Import `Obsidian Video Summary.json` into n8n and configure your own service credentials inside n8n. The repository never includes private credentials, cookies, personal cache files, or vault data.

Default webhook:

```text
http://localhost:5678/webhook/obsidian-video-summary
```

For a full setup guide, see [INSTALL.md](INSTALL.md).

If you are setting this up for the first time, also read
[Beginner Deployment Test and Troubleshooting](docs/BEGINNER_DEPLOYMENT_TEST.md). It records
real clean-environment install issues and fixes, including Docker, n8n, webhook paths, local
files, cookies, and credentials.

For a publishing-ready walkthrough, see the sample notes and scripts in [demo/](demo/).

## Commands

- `Video Summary: summarize current note`
- `Video Summary: extract transcript`
- `Video Summary: update video information`
- `Video Summary: batch process notes`
- `Video Summary: open dashboard`
- `Video Summary: mark as non-video note`

## Settings

- Backend: n8n webhook or compatible worker endpoint.
- Webhook profiles: save and switch multiple endpoints.
- Setup check: run a connection diagnostic from Obsidian settings before processing a real video.
- Processing mode: full note, transcript only, or metadata only.
- Language: Chinese, English, or Japanese.
- Processing model: a label passed through to your n8n switch node.
- Cache: enable URL and mode based result reuse.
- Batch concurrency: limit simultaneous files.
- Payload keys: customize request field names to match your workflow.

## Platform and transcript strategy

The bundled n8n workflow uses this transcript ladder:

1. Use a transcript pasted in Obsidian when present.
2. Try native subtitles first for YouTube and Bilibili, selecting the video's original audio
   language rather than the Obsidian note output language.
3. Fall back to audio download and ASR when no usable subtitle is found.
4. Treat Douyin, TikTok, and Xiaohongshu/Rednote as cookie-sensitive best-effort sources.

Supported URL families include YouTube, Bilibili, Bilibili short links, Douyin short links,
TikTok short links, and Xiaohongshu/Rednote links.

For platform-specific expectations, see
[Platform Capability Matrix](docs/PLATFORM_CAPABILITY_MATRIX.md).

## Privacy and data boundary

The plugin only sends the data required for the selected operation to the endpoint you configure. Depending on mode, that can include the note name, video URL, pasted transcript, local file path, language, processing mode, and model label.

Do not commit these local files:

- `data.json`
- `data/`
- `.DS_Store`
- cookie files
- credential exports
- personal transcripts or processed vault notes

The included `.gitignore` already excludes local cache and runtime data. Review ignored files before publishing a release.

## Development

```bash
npm install
npm run dev
npm run build
```

Useful checks before release:

```bash
npm run build
git status --short
```

## Release

Obsidian installs community plugin files from GitHub Releases. The release tag must match `manifest.json` exactly and include:

- `main.js`
- `manifest.json`
- `styles.css` if present

The included GitHub Actions workflow builds the plugin and publishes those assets when you push a semantic version tag such as `2.1.4`.

## Community submission

Before submitting to the Obsidian community directory, confirm:

- `manifest.json` has an accurate `id`, `name`, `version`, `description`, `author`, and `minAppVersion`.
- `README.md` explains purpose and usage.
- `LICENSE` is present.
- The release tag equals the manifest version.
- The release assets include the required plugin files.

## Support

- Issues: https://github.com/Rexxall/obsidian-video-summary-plugin/issues
- Discussions: https://github.com/Rexxall/obsidian-video-summary-plugin/discussions

## License

MIT. See [LICENSE](LICENSE).
