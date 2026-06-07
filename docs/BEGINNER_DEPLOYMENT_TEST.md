# Beginner Deployment Test and Troubleshooting

This document records a clean-room setup test from the point of view of a user who is not comfortable with code. It lists what worked, what failed, how to fix each issue, and what still requires the user to configure manually.

## Test Summary

Test date: 2026-06-07

Environment used for the test:

- macOS with Node.js `v22.14.0`
- npm `10.9.2`
- Docker `29.4.0`
- A clean temporary project copy without `.git`, `node_modules`, `data`, `data.json`, or local cache files
- A clean temporary Obsidian vault at `/private/tmp/video-summary-newbie-20260607/vault`

Result:

- Clean `npm ci` passed after network access was available.
- `npm run build`, `npm run lint`, `npm run format`, and `npm audit --audit-level=moderate` passed.
- Manual Obsidian plugin installation passed when only release files were copied.
- The official `n8nio/n8n` Docker image did not contain `yt-dlp` or `ffmpeg`, so it cannot run the included workflow by itself.
- A custom Docker image with n8n, `yt-dlp`, and `ffmpeg` was built and verified.

## Beginner Quick Path

If you only want the shortest path:

1. Install Node.js, Docker Desktop or OrbStack, and Obsidian.
2. Build the plugin:

```bash
npm ci
npm run build
```

3. Copy these files into your vault:

```text
<your-vault>/.obsidian/plugins/video-summary/
  main.js
  manifest.json
  styles.css
```

4. Start the custom n8n Docker service:

```bash
cd docker
mkdir -p n8n-data files uploads cookies
docker compose -f docker-compose.video-summary.yml up --build
```

5. Open n8n:

```text
http://localhost:5678
```

6. Import `Obsidian Video Summary.json`.
7. Activate the workflow.
8. In Obsidian plugin settings, use:

```text
http://localhost:5678/webhook/obsidian-video-summary
```

9. Run the plugin setup check. The recommended workflow version is `2.1.4`, and the workflow path
   should be `obsidian-video-summary`.
10. Create a note with:

```yaml
---
link: 'https://www.youtube.com/watch?v=example'
status: pending
---
```

11. Run `Video Summary: summarize current note`.

## What Was Fixed During Testing

### 1. Webhook path mismatch

Problem:

- Plugin default URL was `http://localhost:5678/webhook/cyrus`.
- The exported n8n workflow used the path `vidsum`.
- A beginner would import the workflow, keep default settings, and get connection failures.

Fix:

- The plugin default URL and workflow Webhook path now use `obsidian-video-summary`.

If you already imported the old workflow:

1. Open n8n.
2. Open the workflow.
3. Click the `Webhook` node.
4. Change `Path` from `vidsum` or `cyrus` to `obsidian-video-summary`.
5. Save and activate the workflow again.

### 2. Default processing model mismatch

Problem:

- The plugin default model label was `Gemini`.
- The workflow switch expects exact values such as `Gemini 3.1` or `Gemini 3.0`.
- If the labels do not match, the workflow can stop before note generation.

Fix:

- The plugin defaults now use `Gemini 3.1` and `Gemini 3.0`.

If you customize labels:

1. Open Obsidian plugin settings.
2. Open `Custom processing model`.
3. Make sure the text exactly matches an n8n Switch branch.
4. Examples that exist in the workflow: `Gemini 3.1`, `Gemini 3.0`.

## Common Problems and Fixes

### Problem: `npm ci` fails with `ENOTFOUND registry.npmjs.org`

Meaning:

Your computer cannot reach npm's package registry.

Fix:

1. Check your internet connection.
2. Try again:

```bash
npm ci
```

3. If you are in a region or network that blocks npm, set a mirror:

```bash
npm config set registry https://registry.npmmirror.com
npm ci
```

4. To restore the default registry later:

```bash
npm config set registry https://registry.npmjs.org
```

### Problem: Docker says `permission denied while trying to connect to the docker API`

Meaning:

Docker Desktop or OrbStack is not available to your terminal.

Fix:

1. Start Docker Desktop or OrbStack.
2. Run:

```bash
docker ps
```

3. If it still fails on Linux, add your user to the Docker group:

```bash
sudo usermod -aG docker "$USER"
```

Then log out and log back in.

### Problem: Docker says container name `/n8n` is already in use

Meaning:

You already have an n8n container.

Check:

```bash
docker ps
```

Fix options:

- Reuse the existing n8n at `http://localhost:5678`.
- Or stop the existing container:

```bash
docker stop n8n
```

- Or use a different container name and port.

### Problem: Docker says `Bind for 0.0.0.0:5678 failed: port is already allocated`

Meaning:

Something is already using port `5678`.

Fix:

Use a different host port, for example `5679`.

In `docker/docker-compose.video-summary.yml`, change:

```yaml
ports:
  - '5678:5678'
```

to:

```yaml
ports:
  - '5679:5678'
```

Then set the Obsidian plugin URL to:

```text
http://localhost:5679/webhook/obsidian-video-summary
```

### Problem: n8n webhook returns 404

Possible causes:

- The workflow is not activated.
- You are using the test URL instead of the production URL.
- The Webhook path in n8n does not match the plugin URL.
- You used `GET` in a browser, while the workflow expects `POST`.

Fix:

1. In n8n, open the workflow.
2. Click `Active`.
3. Check the `Webhook` node path.
4. Use this URL in Obsidian:

```text
http://localhost:5678/webhook/obsidian-video-summary
```

Do not use `/webhook-test/...` unless you are manually testing inside n8n.

### Problem: `yt-dlp: not found`

Meaning:

The n8n container does not have `yt-dlp`.

Cause found during testing:

The official `n8nio/n8n:latest` image had:

```text
yt_dlp=missing
ffmpeg=missing
```

Fix:

Use the provided custom Docker image:

```bash
cd docker
mkdir -p n8n-data files uploads cookies
docker compose -f docker-compose.video-summary.yml up --build
```

### Problem: `ffmpeg: not found`

Meaning:

The workflow downloaded media but cannot convert audio.

Fix:

Use the provided custom Docker image. It was verified with:

```text
n8n=2.23.4
yt_dlp=2026.03.17
ffmpeg=ffmpeg version 8.0.1
```

### Problem: local file processing cannot find the file

Meaning:

The n8n container cannot see arbitrary files from your Mac or PC. It only sees mounted Docker folders.

Fix:

1. Put the file into:

```text
docker/uploads/
```

2. In the Obsidian note, use only the file name:

```yaml
---
local_file: 'lecture-01.mp4'
status: pending
---
```

Do not use:

```yaml
local_file: '/Users/you/Desktop/lecture-01.mp4'
```

The workflow expects container paths under:

```text
/home/node/uploads/
```

### Problem: Bilibili returns `HTTP Error 412: Precondition Failed`

Meaning:

Bilibili rejected the automated `yt-dlp` request. This usually happens when `yt-dlp` is old, the
request lacks browser-like headers, or the video requires browser cookies.

Fix:

1. Rebuild the provided Docker image without cache:

```bash
cd docker
docker compose -f docker-compose.video-summary.yml build --no-cache
docker compose -f docker-compose.video-summary.yml up -d
docker compose -f docker-compose.video-summary.yml exec n8n-video-summary yt-dlp --version
```

2. If the same URL still fails, export Bilibili browser cookies in Netscape format.
3. Save the cookie file here:

```text
docker/cookies/bilibili_cookies.txt
```

4. Restart n8n and run the plugin setup check again.

### Problem: YouTube, Bilibili, TikTok, Douyin, or Xiaohongshu download fails

Possible causes:

- The video requires login.
- The platform blocks automated downloads.
- Cookies are missing or expired.
- The URL is private or region locked.

Fix:

1. Export browser cookies in Netscape format.
2. Put cookie files into:

```text
docker/cookies/
```

3. Use these file names if you keep the default workflow:

```text
youtube_cookies.txt
bilibili_cookies.txt
douyin_cookies.txt
tiktok_cookies.txt
xiaohongshu_cookies.txt
```

4. Restart n8n after changing mounted files if needed.

### Problem: workflow asks for credentials or model setup

Meaning:

The workflow template does not include private service credentials.

Fix:

1. Open n8n.
2. Open the imported workflow.
3. Find the model/provider nodes.
4. Create your own credentials in n8n.
5. Replace the placeholder value `YOUR_GEMINI_API_KEY_HERE` where it appears.
6. Save and activate the workflow.

This part cannot be solved by the plugin because each user must use their own service account and key.

### Problem: n8n import works, but summarize mode returns nothing

Likely cause:

The selected processing model label does not match the workflow Switch node.

Fix:

Use `Gemini 3.1` first. It is the default after this test pass.

If you use a custom branch, the label in Obsidian must match the n8n branch exactly.

### Problem: the first Docker build takes a long time

Meaning:

The custom image installs n8n, `yt-dlp`, `ffmpeg`, and supporting packages.

Fix:

Wait for it to finish. The build can take several minutes on the first run. Later runs should use Docker cache.

Warnings from npm during n8n install are expected unless the build exits with an error.

## Manual Verification Checklist

Use this checklist before reporting an issue:

```bash
node --version
npm --version
npm ci
npm run build
docker ps
```

Inside the n8n container:

```bash
docker exec -it n8n-video-summary sh
yt-dlp --version
ffmpeg -version
n8n --version
```

Expected:

- `yt-dlp` prints a version.
- `ffmpeg` prints a version.
- `n8n` prints a version.

## What Still Requires User Action

The project can provide the plugin, workflow template, Docker image, and troubleshooting guide. The user must still provide:

- Their own model/provider credentials.
- Valid cookies for restricted platforms.
- Public or accessible video URLs.
- Local files placed in the Docker `uploads` folder.
- Enough disk space for downloaded audio/video and converted files.
- A running Obsidian desktop app with Community plugins enabled.

## Evidence From This Test

Clean Node path:

```text
npm ci: passed after network access
npm run build: passed
npm run lint: passed
npm run format: passed
npm audit --audit-level=moderate: found 0 vulnerabilities
```

Manual Obsidian install path:

```text
main.js: present
manifest.json: present
styles.css: present
manifest id: video-summary
```

Official n8n image check:

```text
n8nio/n8n:latest
n8n version: 2.23.4
yt-dlp: missing
ffmpeg: missing
```

Custom image check:

```text
n8n=2.23.4
node=v24.16.0
yt_dlp=2026.03.17
ffmpeg=ffmpeg version 8.0.1
/home/node/files: present
/home/node/uploads: present
/home/node/cookies: present
```
