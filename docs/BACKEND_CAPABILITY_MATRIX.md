# 后端能力矩阵（Backend Capability Matrix）

> 本系统有三个可选后端。它们能力差别很大，**选错后端会导致同一条视频在 A 后端正常出稿、在 B 后端静默失败**。
> 本文是选择依据的单一来源。最后更新：2026-06-28。

## TL;DR

- **默认用 `n8n`**：它是目前唯一能"下载音频 + 转写 + 看画面"的完整管线。
- `codex-worker` 目前只能处理**已有字幕 / 已有文稿 / 本地文本**的视频，**不会下载音频、不会做语音转写、不会看画面**。对没有原生字幕的视频会返回 `needs_transcript` 而不是报错。
- `obsidian-uri` 不做任何处理，只负责把链接/待办笔记送进 vault。

## 能力对照

| 能力 | n8n 工作流 | codex-worker（已加固） | obsidian-uri |
|---|---|---|---|
| 入口角色 | 重后端（完整处理） | 本地轻量后端 | 仅落地，不处理 |
| 下载视频/音频（yt-dlp） | ✅ | ❌（只取字幕文件） | ❌ |
| 原生字幕提取 | ✅ | ✅ | ❌ |
| 语音转写（无字幕时） | ✅（下载音频→转写） | ❌（返回 needs_transcript） | ❌ |
| 画面/帧分析（Gemini Vision） | ✅ | ❌（README 标注为"下一阶段"） | ❌ |
| 已粘贴文稿 → 总结 | ✅ | ✅ | ❌ |
| 本地文件 → 总结 | ✅（docker/uploads） | ✅（本地文本，5MB 上限） | ❌ |
| 视频元数据（标题等） | ✅ | 部分（取决于字幕/yt-dlp） | ❌ |
| 多模型（DeepSeek/Gemini/OpenAI 兼容） | ✅（10 个 agent） | ✅（codex CLI / gemini / openai 兼容 / n8n 透传 / 本地兜底） | — |
| 总结质量门 + 自动重写 | 部分（解析重试） | ✅（note-quality + 1 次修复） | — |
| 并发上限 / 队列 | n8n 自身调度 | ✅（WORKER_MAX_CONCURRENCY，默认 2，FIFO） | — |
| 真正的取消（杀子进程） | n8n 控制台 | ✅（AbortController + SIGTERM/SIGKILL） | — |
| 请求超时 | 工作流内 | ✅（WORKER_JOB_TIMEOUT_MS，默认 10 分钟） | — |
| 鉴权 / CORS 收口 | 取决于部署 | ✅（loopback 白名单 + 可选 WORKER_AUTH_TOKEN） | n/a |
| 离线可用（无外网模型） | 取决于配置 | ✅（local 兜底） | ✅ |

## 怎么选

- **YouTube / Bilibili 等线上视频，且不确定有没有字幕** → `n8n`。worker 目前没有音频转写，遇到无字幕会失败。
- **你已经有文稿 / 字幕 / 本地文本，只想要总结** → `codex-worker` 完全够用，而且本地、快、可离线。
- **只想先把链接存进 vault，稍后再处理** → `obsidian-uri`。

## 当前默认 & 如何切换

- 代码默认（`constants.ts` `DEFAULT_SETTINGS.activeBackend`）：`n8n`。
- 你的 live `data.json` 已于 2026-06-28 从 `codex-worker` 切回 `n8n`（备份：`data.json.bak-backend-switch-20260628`）。
  **改动后需重启 Obsidian**（或在插件设置里的后端下拉框确认），否则运行中的实例可能仍用旧值。
- 随时可在插件设置里把后端切回 `codex-worker`（处理纯文本/字幕任务时推荐）。

## 把 worker 补齐到能替代 n8n（路线）

worker 要真正取代 n8n，需要补上现在缺的三块（n8n 里已有现成实现可搬）：

1. **无字幕时的音频转写**：下载音频（yt-dlp）→ Whisper / faster-whisper（或调用云 STT）。
2. **画面理解**：抽关键帧 → Gemini Vision（搬 n8n 的 `Code: Prepare Gemini Parts` / `Analyze video` 节点逻辑）。
3. **元数据补全**：yt-dlp `--dump-json` 拿标题/作者/时长。

在补齐之前，建议保留 **n8n 为默认**。

## 可选增强：自动回退

更省心的做法（需要插件侧改一处）：默认走 `codex-worker`，当它返回 `needs_transcript` / 空转写时，**自动回退到 `n8n`** 重试一次。这样能兼顾"本地快"和"无字幕也能出稿"。目前未实现，作为后续选项。
