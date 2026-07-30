# Launch Guide

This guide is for sharing Video Summary publicly while keeping the repository clean and supportable.

## Positioning

Short description:

> Video Summary turns video links, local recordings, and pasted transcripts into evidence-linked
> Obsidian knowledge through a processing endpoint you control.

What to emphasize:

- It is an Obsidian workflow plugin, not a hosted service.
- The user controls the backend endpoint.
- It supports URL notes, uploaded local media, pasted transcripts, batch processing, evidence
  maps, synchronized reading, local search, learning review, caching, and note renaming.
- The reader-facing output is Markdown; machine-oriented evidence and progress stay in local
  plugin sidecars.

Avoid overclaiming:

- Do not promise that every video platform will work.
- Do not imply credentials are included.
- Do not imply the plugin processes private videos without the user's own platform permissions.
- Do not present generated notes as guaranteed factual summaries.

## Social post draft

Title:

> 我写了一个把视频整理成 Obsidian 笔记的插件

Body:

> 之前每次看长视频、课程、讲座都要手动复制链接、找字幕、整理摘要，最后笔记格式还很乱。于是我做了 Video Summary：在 Obsidian 里选一条视频笔记，它会把链接、文稿或本地录音交给自己的 n8n 工作流处理，再把结构化 Markdown 写回笔记。
>
> 现在支持：当前笔记与批量处理、证据地图、同步陪读、跨视频检索与论点对比、学习复习、缓存、Webhook 多配置和自动重命名。公开 n8n 工作流优先使用原生字幕；无字幕/本地音频的 ASR 子流程需要自己配置。
>
> 适合用 Obsidian 学习课程、整理讲座、沉淀公开视频资料的人。项目已经开源，安装和 n8n 工作流导入步骤写在 README 里。

## Suggested platforms

- GitHub repository and Releases
- Obsidian forum Share & showcase
- Obsidian Discord updates after community approval
- Xiaohongshu
- Bilibili dynamic or demo video
- V2EX or similar developer communities
- Personal blog or Notion/Obsidian Publish page

## Demo checklist

Record a short demo with these steps:

1. Show a note with a video URL.
2. Run `快速总结当前笔记`.
3. Show the n8n webhook receiving the request.
4. Show the returned Markdown in Obsidian.
5. Show the dashboard or batch panel.
6. Show settings with webhook profiles and cache controls.

Keep personal vault names, private URLs, cookies, and credential screens out of the recording.

## Repository checklist

- `README.md` explains the workflow and installation.
- `INSTALL.md` covers local build, n8n import, and troubleshooting.
- `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md` are present.
- `manifest.json` uses a community-safe ID and a semantic version.
- `versions.json` maps plugin versions to minimum Obsidian versions.
- `.gitignore` excludes runtime data and cache files.
- Release workflow attaches the three required plugin files, an install ZIP, the optional n8n
  workflow, and checksums.

## Release checklist

```bash
npm ci
npm test
npm run lint
npm run format
npm run build
git status --short
```

Then:

1. Commit the release-ready changes.
2. Push the branch.
3. Create and push a tag that matches `manifest.json`, for example `2.4.1`.
4. Confirm GitHub Actions creates the release assets.
5. Test manual install from release assets in a clean vault.

## Community directory notes

The Obsidian community directory reviews the repository and the GitHub Release. The manifest version and release tag must match exactly. The plugin ID should be short, lowercase, unique, and not end with `plugin`.
