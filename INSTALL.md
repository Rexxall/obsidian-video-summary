# Installation Guide

This guide covers local installation, n8n setup, and the checks needed before sharing the plugin publicly.

## Requirements

- Obsidian desktop app
- Node.js 20 or newer when building from source
- npm
- The repository's custom self-hosted Docker environment for the bundled n8n processing path
- A configured n8n workflow based on `Obsidian Video Summary.json`, or an already deployed
  compatible Worker endpoint

The included workflow uses Execute Command nodes, `/home/node/` mounts, `yt-dlp`, and ffmpeg. The
repository's custom Docker image is the supported default. n8n Cloud, a standard n8n image, and a
plain npm-only install are not drop-in replacements; an advanced self-hosted deployment must expose
equivalent commands, tools, paths, and mounts.

The optional Codex Worker service is not included in this repository or release. It is required
only for Worker-specific progress/cancellation and `deep-visual` processing.

The manifest minimum is Obsidian 1.4.0, and this release was exercised on Obsidian 1.12.7.
Generated `.base` library views require Obsidian 1.9.10 or newer with the Bases core plugin
enabled.

## 1. Install the plugin

### Release ZIP

Download `video-summary-2.4.2.zip` and its matching `SHA256SUMS` from the canonical
[GitHub 2.4.2 release](https://github.com/Rexxall/obsidian-video-summary-plugin/releases/tag/2.4.2).
On macOS or Linux, verify the ZIP with:

```bash
grep 'video-summary-2.4.2.zip' SHA256SUMS | shasum -a 256 -c -
```

Then extract it into:

```text
<your-vault>/.obsidian/plugins/video-summary/
```

The folder must directly contain `main.js`, `manifest.json`, and `styles.css`.

### Build from source

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

Copy these plugin files into that folder:

```text
main.js
manifest.json
styles.css
```

Restart Obsidian and enable `Video Summary` from `Settings -> Community plugins`.

`Obsidian Video Summary.json` is a separate n8n workflow import. Do not copy it into the Obsidian
plugin folder.

## 3. Start n8n

Recommended Docker path:

```bash
cd docker
mkdir -p n8n-data files uploads cookies
docker compose -f docker-compose.video-summary.yml up --build
```

This custom image includes n8n, `yt-dlp`, and `ffmpeg`. The official `n8nio/n8n` image does not
include the media tools required by the workflow.

If Bilibili returns `HTTP Error 412: Precondition Failed`, rebuild the image without Docker cache so
the container gets the latest `yt-dlp`:

```bash
docker compose -f docker-compose.video-summary.yml build --no-cache
docker compose -f docker-compose.video-summary.yml up -d
docker compose -f docker-compose.video-summary.yml exec n8n-video-summary yt-dlp --version
```

Open:

```text
http://localhost:5678
```

## 4. Import the workflow

1. In n8n, create a new workflow.
2. Choose `Import from File`.
3. Select `Obsidian Video Summary.json`.
4. Create an n8n **Header Auth** credential with a random value. Use
   `X-Video-Summary-Token` as the recommended header name, then select it on the `Webhook` node.
5. Configure the Google Gemini model nodes with your own n8n credentials. For the optional
   `Gemini Vision` OCR node, create a separate Header Auth credential whose name is
   `x-goog-api-key` and whose value is your Gemini API key; select it on that node. Do not put the
   key in a URL or ordinary node parameter.
6. Create or select an ASR subworkflow that follows
   [docs/ASR_SUBWORKFLOW_CONTRACT.md](docs/ASR_SUBWORKFLOW_CONTRACT.md).
7. In the main workflow, open `SubFlow: Transcript` and
   `SubFlow: Transcript from Local File`; replace `CONFIGURE_ASR_WORKFLOW_ID` by selecting your
   saved ASR workflow.
8. Save and activate the workflow.

You can defer steps 6–7 if you only use pasted transcripts or videos with usable native subtitles.
Without them, no-subtitle videos and local audio/video cannot use the ASR fallback.

Default production webhook:

```text
http://127.0.0.1:5678/webhook/obsidian-video-summary
```

If port `5678` is already in use, change the Docker host port and update the Obsidian plugin URL.
For a full list of beginner setup issues and fixes, see
[docs/BEGINNER_DEPLOYMENT_TEST.md](docs/BEGINNER_DEPLOYMENT_TEST.md).

The bundled workflow's internal contract version is `2.1.5` (independent of the plugin release
version), its webhook path is `obsidian-video-summary`, and its included model labels are
`Gemini 3.1` / `Gemini 3.0`.

## 5. Configure the plugin

In Obsidian settings, open `Video Summary`.

Required:

- Webhook URL: `http://127.0.0.1:5678/webhook/obsidian-video-summary`
- Webhook Header: the same header name selected in n8n (recommended
  `X-Video-Summary-Token`).
- Webhook Secret: the same random Header Auth value. It is stored locally in the plugin settings;
  do not reuse a model API key or account password.

Recommended:

- Request timeout: 10 minutes
- Batch concurrency: 2 or 3
- Cache: enabled
- Debug mode: disabled unless you are troubleshooting
- Run the setup check in the plugin settings before sending a real video.
- Native subtitle language: leave it automatic. The bundled n8n workflow chooses the video's original
  audio language and does not use the note output language for subtitle selection.
- Processing depth: use `quick` or `evidence` with n8n. n8n does not perform real frame analysis and
  will downgrade `deep-visual` to `evidence`.

Optional:

- Put browser-exported cookies in the mounted `cookies` folder when a platform requires login.
- Expected cookie filenames: `youtube_cookies.txt`, `bilibili_cookies.txt`,
  `douyin_cookies.txt`, `tiktok_cookies.txt`, and `xiaohongshu_cookies.txt`.

- Add more profiles for local or staging endpoints. The bundled n8n 2.4.2 setup supports only the
  same-machine endpoint; use a remote profile only with a separately hardened compatible service
  protected by TLS, authentication, rate limiting, and its own security review.
- Change payload key names if your n8n workflow uses different field names.
- Add more processing model labels if your n8n switch node supports them.

For platform-specific expectations, see
[docs/PLATFORM_CAPABILITY_MATRIX.md](docs/PLATFORM_CAPABILITY_MATRIX.md).
For the exact n8n / Worker / capture boundary, see
[docs/BACKEND_CAPABILITY_MATRIX.md](docs/BACKEND_CAPABILITY_MATRIX.md).

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

For the bundled n8n workflow, first copy the file directly into `docker/uploads/`, then use only its
basename. Subdirectories and macOS/Windows absolute paths are rejected. An absolute path can be
processed only by a separately configured Worker or compatible endpoint that confines access to an
explicit media root.

Multiple local files:

```yaml
---
local_file: 'part-1.mp3, part-2.mp3, part-3.mp3'
status: pending
---
```

## 7. Run a command

Open the command palette and run one of:

- `快速总结当前笔记`
- `快速提取文稿`
- `更新视频信息（不改正文）`
- `批量处理视频`
- `搜索跨模态视频记忆`
- `生成多视频论点实验室`
- `复习当前视频的学习卡`
- `复习所有到期的视频学习卡`
- `用本地可复现工件重新处理`
- `生成或安全更新视频库 Base`

If you upgrade from a manually installed 2.4.1 build, reassign any custom Video Summary shortcuts
in Obsidian's Hotkeys settings. Version 2.4.2 changes the internal command IDs to comply with the
community-directory requirements; command labels and behavior are unchanged.

## Local knowledge data

Since version 2.4.1, structured state is stored below the installed plugin folder:

```text
data/knowledge-artifacts/
data/learning-progress/
data/reproducibility/
data/course-manifests/
```

This can include transcripts, evidence, claims, learning attempts, and course progress. Keep it in
private backups if you need it, and do not publish it with a source checkout or release.

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
- Both transcript subflow nodes point to an existing ASR workflow when no native subtitle is
  available.

### Output quality is poor

Tune the generation prompt and model selection inside n8n. The plugin validates and organizes the
returned evidence, but generation quality still depends on the configured workflow and model.

### Deep visual is unavailable

The bundled n8n path supports `evidence`, not real frame analysis. Deep visual requires a separately
deployed compatible Worker with ffmpeg and a configured visual model. The Worker is not included in
this repository.

## Public release checklist

Before posting the project publicly:

- Run `npm run build`.
- Confirm `manifest.json` version matches the Git tag.
- Confirm `main.js`, `manifest.json`, and `styles.css` are attached to the release.
- Confirm the install ZIP contains only those three files at its root.
- Confirm the optional n8n asset is attached as `Obsidian.Video.Summary.json`.
- Confirm `SHA256SUMS` matches every uploaded custom asset.
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
