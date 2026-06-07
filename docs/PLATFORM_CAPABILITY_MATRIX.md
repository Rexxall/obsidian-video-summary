# Platform Capability Matrix

Use this page to set expectations before processing a video. A failed run is often caused by
platform access, cookies, or local Docker paths rather than the Obsidian note itself.

## Quick Read

| Input               | Reliability | Best for                               | Main requirement                       |
| ------------------- | ----------- | -------------------------------------- | -------------------------------------- |
| Pasted transcript   | Highest     | Any blocked platform                   | Paste text into the note               |
| Local audio/video   | Highest     | Meetings, lectures, recordings         | Put files in `docker/uploads`          |
| YouTube public URL  | Good        | Public videos and lectures             | Cookies for restricted videos          |
| Bilibili public URL | Good        | Public videos, some multi-part content | Update `yt-dlp`; cookies may be needed |
| Douyin/TikTok       | Limited     | Best-effort short video processing     | Usually needs cookies                  |
| Xiaohongshu/Rednote | Limited     | Best-effort shared links               | Usually needs cookies and stable links |

## Platform Notes

### Local Audio Or Video

Recommended path for beginners.

1. Put the file in `docker/uploads`.
2. Use frontmatter like:

```yaml
---
local_file: 'lecture-01.mp4'
status: pending
---
```

Do not use a macOS absolute path such as `/Users/you/Desktop/lecture-01.mp4` when n8n is running in
Docker. Inside the container, files are read from `/home/node/uploads`.

### YouTube

Public videos usually work. The workflow tries native subtitles first, then falls back to audio
extraction when no usable subtitle is available.

Restricted, age-gated, private, or region-limited videos may require `youtube_cookies.txt`.

### Bilibili

Public videos usually work. Multi-part videos may require the exact part URL. If only one part is
needed, open that part in the browser and copy the URL with its current `p=` value.

Bilibili may return `HTTP Error 412: Precondition Failed` when the downloader is old or the request
looks automated. Rebuild the provided Docker image with `--no-cache` so it installs the latest
`yt-dlp`. If the same link still fails, export browser cookies in Netscape format and save them as
`docker/cookies/bilibili_cookies.txt`.

### Douyin And TikTok

These platforms are best-effort. Short links can expire or redirect, and many videos need cookies.
If a link fails, try the final resolved URL or paste a transcript instead.

### Xiaohongshu / Rednote

Treat this as best-effort. Shared links may be unstable and cookie-sensitive. Keep source metadata
in the note before processing so you can recover context if downloading fails.

## Cookie Files

When a platform requires login, export cookies in Netscape format and put them in `docker/cookies`:

```text
youtube_cookies.txt
bilibili_cookies.txt
douyin_cookies.txt
tiktok_cookies.txt
xiaohongshu_cookies.txt
```

Never commit cookie files or credentials.
