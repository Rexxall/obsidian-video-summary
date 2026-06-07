# Installation Guide

This guide covers local installation, n8n setup, and the checks needed before sharing the plugin publicly.

## Requirements

- Obsidian desktop app
- Node.js 16 or newer
- npm
- n8n, either local, Docker, or hosted
- A configured n8n workflow based on `Obsidian Video Summary.json`

## 1. Build the plugin

```bash
git clone https://github.com/Rexxall/obsidian-video-summary-plugin.git
cd obsidian-video-summary-plugin
npm install
npm run build
```

## 2. Install into a vault

Create the plugin folder:

```text
<your-vault>/.obsidian/plugins/video-summary/
```

Copy these release files into that folder:

```text
main.js
manifest.json
styles.css
Obsidian Video Summary.json
```

Restart Obsidian and enable `Video Summary` from `Settings -> Community plugins`.

## 3. Start n8n

Recommended Docker path:

```bash
cd docker
mkdir -p n8n-data files uploads cookies
docker compose -f docker-compose.video-summary.yml up --build
```

This custom image includes n8n, `yt-dlp`, and `ffmpeg`. The official `n8nio/n8n` image does not
include the media tools required by the workflow.

npm-only n8n example:

```bash
npm install n8n -g
n8n start
```

Open:

```text
http://localhost:5678
```

## 4. Import the workflow

1. In n8n, create a new workflow.
2. Choose `Import from File`.
3. Select `Obsidian Video Summary.json`.
4. Review every credential field and replace placeholders with your own credentials.
5. Save and activate the workflow.

Default production webhook:

```text
http://localhost:5678/webhook/obsidian-video-summary
```

If port `5678` is already in use, change the Docker host port and update the Obsidian plugin URL.
For a full list of beginner setup issues and fixes, see
[docs/BEGINNER_DEPLOYMENT_TEST.md](docs/BEGINNER_DEPLOYMENT_TEST.md).

The plugin and bundled workflow expect workflow version `2.1.3`, webhook path
`obsidian-video-summary`, and model labels `Gemini 3.1` / `Gemini 3.0`.

## 5. Configure the plugin

In Obsidian settings, open `Video Summary`.

Required:

- Webhook URL: `http://localhost:5678/webhook/obsidian-video-summary`

Recommended:

- Request timeout: 10 minutes
- Batch concurrency: 2 or 3
- Cache: enabled
- Debug mode: disabled unless you are troubleshooting
- Run the setup check in the plugin settings before sending a real video.
- Native subtitle language: leave it automatic. The bundled n8n workflow chooses the video's original
  audio language and does not use the note output language for subtitle selection.

Optional:

- Put browser-exported cookies in the mounted `cookies` folder when a platform requires login.
- Expected cookie filenames: `youtube_cookies.txt`, `douyin_cookies.txt`, `tiktok_cookies.txt`,
  and `xiaohongshu_cookies.txt`.

- Add more webhook profiles for local, remote, and staging workflows.
- Change payload key names if your n8n workflow uses different field names.
- Add more processing model labels if your n8n switch node supports them.

For platform-specific expectations, see
[docs/PLATFORM_CAPABILITY_MATRIX.md](docs/PLATFORM_CAPABILITY_MATRIX.md).

## 6. Create a note

URL input:

```yaml
---
link: 'https://www.youtube.com/watch?v=example'
status: pending
---
```

Local file input:

```yaml
---
local_file: 'lecture-01.mp4'
status: pending
---
```

Multiple local files:

```yaml
---
local_file: 'part-1.mp3, part-2.mp3, part-3.mp3'
status: pending
---
```

## 7. Run a command

Open the command palette and run one of:

- `Video Summary: summarize current note`
- `Video Summary: extract transcript`
- `Video Summary: update video information`
- `Video Summary: batch process notes`
- `Video Summary: open dashboard`

## Troubleshooting

### Cannot connect to n8n

Check:

- n8n is running.
- The webhook URL is correct.
- The workflow is active.
- The endpoint is reachable from the machine running Obsidian.

### Processing times out

Try:

- Increase timeout in plugin settings.
- Reduce batch concurrency.
- Test the same URL directly in n8n.
- Check whether the video platform blocks download or transcript extraction.

### Video cannot be processed

Check:

- The URL is publicly accessible or your workflow has the required cookies.
- The platform is supported by your download step.
- The note has `link`, `local_file`, or pasted transcript content.

### Output quality is poor

Tune the generation prompt and model selection inside n8n. The plugin only passes the request and writes the response; content quality is controlled by the workflow.

## Public release checklist

Before posting the project publicly:

- Run `npm run build`.
- Confirm `manifest.json` version matches the Git tag.
- Confirm `main.js`, `manifest.json`, and `styles.css` are attached to the release.
- Confirm `README.md`, `LICENSE`, `CHANGELOG.md`, `SECURITY.md`, and `CONTRIBUTING.md` are committed.
- Confirm ignored local files are not tracked by Git.
- Confirm workflow exports contain no private credentials, cookies, local absolute vault paths, or personal transcripts.

## Development

```bash
npm install
npm run dev
```

In another terminal, run n8n and keep Obsidian open with the plugin enabled.

For a production build:

```bash
npm run build
```
