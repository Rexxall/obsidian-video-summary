# Changelog

All notable changes to this project are documented here.

## 2.9.1

- The plugin description no longer names Obsidian, as the community directory requires. No
  other changes; the 2.9.0 backend package still applies.

## 2.9.0

English interface and a first result before any setup.

- **Follows Obsidian's language.** With Obsidian set to Chinese the plugin stays in Chinese; any
  other language gets English. This covers commands, settings, the setup wizard, the side panel,
  errors, empty states and hints. Notes the backend writes are unchanged.
- **Example note.** "See an example note" in the side panel writes one real, finished note
  (an interview on reading papers in three passes) marked `video_summary_demo: true`, so you can
  see the result before installing the backend. Delete it whenever you like.
- **Empty states say what to do next.** The side panel tells apart "no backend connected yet"
  (open first-run setup, or see the example) and "no jobs yet"; each has one next step.
- The connection check and the setup wizard now tell a slow backend (timeout) from one that is not
  running.
- Detail tabs scroll sideways in a narrow sidebar instead of being cut off; platform names are
  translated.
- Settings line up on one left and one right edge: group text, headings, notes, button rows and
  dividers start at the same place, setup steps stay in one group, and buttons without a row name
  of their own sit on a plain row. The divider under the side panel tabs ends where the cards do.
- Switches keep the knob 2px from every edge. Pressed, the knob stretches into a capsule inside the
  track instead of growing past it, then turns round and slides when released; with reduced motion
  it does not stretch.
- The backend is unchanged: `video-summary-backend-2.8.0.zip` works with this version.

## 2.8.0

Backend package and first-run setup.

- **One-download backend.** The release now has `video-summary-backend-2.8.0.zip` in place of the
  bare n8n workflow. Unzip it, double-click `start-mac.command` (macOS) or `start-windows.cmd`
  (Windows), paste your keys, and it builds and starts n8n with yt-dlp and ffmpeg. It switches to
  mainland-China mirrors by itself when Docker Hub is unreachable, picks a free port when 5678 is
  taken, and prints a connection code. Nothing to import or click in n8n: credentials and both
  workflows are created on first start.
- **One model for everything.** Every AI step uses one OpenAI-compatible model, set in `.env`.
  Default DeepSeek `deepseek-flash`; SiliconFlow, Qwen, Kimi or Gemini need only a different
  address and model name. The ten per-provider model nodes and unused branches are gone (61 → 51
  nodes).
- **Speech-to-text included.** Videos without subtitles and local audio/video work out of the box
  with SiliconFlow's free SenseVoice. Long audio is cut into 10-minute parts and joined in order.
  Local images are read by an OpenAI-compatible vision model; PDFs by n8n's own text extraction.
- **Bilibili first.** Uploader subtitles, then Bilibili's AI subtitles, then speech-to-text;
  danmaku is never used as a transcript. New in the setup wizard: scan a QR code with the Bilibili
  app to give your backend the login it needs for subtitles. Browser extension 0.6.0 can sync the
  login too, and now sends the backend password with its requests.
- **First-run setup in the plugin.** Settings → 视频总结 → 首次配置: paste the connection code
  from the clipboard, run the full check (backend, code, workflow version, yt-dlp and ffmpeg,
  model key and name, speech-to-text, Bilibili login), then a trial run. Every failed step says
  what to change. Wrong or missing model keys now end a job with that message instead of four
  silent retries.
- The plugin no longer keeps a list of model labels; the model name shown with each result comes
  from the backend.
- **Fixed (affects 2.7.0):** requests from the plugin to the backend failed inside Obsidian with
  "Failed to resolve module specifier 'obsidian'"; the bundle now loads Obsidian's API with
  `require`. Also fixed: every Bilibili link stopped at "Short-link redirect limit exceeded";
  logged-in Bilibili videos ignored their AI subtitles; `local_file: '…'` written with quotes was
  never found; links failed in n8n 2.x Code nodes, which have no `URL` global.
- Downloaded audio and subtitles older than a day are removed from the backend's working volume.
- Install guide rewritten in Chinese, with shorter English and Japanese versions.

## 2.7.0

Community-directory release.

- **New glass design.** The side panel, every dialog, the settings page and the browser extension were redone in the style of current macOS: content on solid grouped lists and cards, the tab bar and dialogs on glass, one accent colour (yours from Obsidian), capsule buttons and segmented controls. It follows light/dark mode and falls back to solid surfaces under the system's reduce-transparency and increase-contrast settings. The "Paper & ink style" option is gone, in the plugin and in the extension.
- Browser extension 0.5.0: the same design, with grouped settings and switches.
- Side panel reordered: the add box comes first, with 开始 inside it; mode, learning cards and the other defaults sit in one 选项 row that expands; the finished-jobs list is its own group. 复习学习卡, 跨视频搜索 and 设置 moved from the bottom links into the ··· menu next to the title. Videos without a cover show their platform icon instead of a grey block, including YouTube's grey placeholder for missing covers.
- Batch dialog: centred title; status, folder and date filters are one 筛选 capsule; 全选, 清空 and the select-by-status actions are in the ··· menu at the top of the list.
- **Quote the transcript into your notes.** In Reader, right-click a transcript line to copy it as
  a quote or insert it at the cursor of the note you were editing, or drag the line into a note.
  The quote links back to that second of the video. Change the format in Settings → 输出 →
  文稿引用格式 (`{{text}}`, `{{time}}`, `{{link}}`, `{{url}}`, `{{speaker}}`, `{{title}}`,
  `{{note}}`).
- **Collect the video links in a note.** New command 收集当前笔记里的视频链接到侧栏 puts every
  supported video link from the current note, including its properties, into the side panel's add
  box, once per video. Pick a mode and start; nothing runs until you do.
- n8n webhook requests now go through Obsidian's own network layer, like the Worker requests, so a
  browser CORS policy can no longer block them.
- Settings section titles use Obsidian's native headings; the webhook rows, batch progress and
  language switch use theme classes instead of inline styles.
- Command names no longer start with emoji, so they read cleanly in the command palette.
- Deleting a note from the library follows your Obsidian "Deleted files" setting.
- Passes the Obsidian community directory's automated review (eslint-plugin-obsidianmd recommended set) with no errors: replies from the webhook, the Worker and the browser are read as untyped data and checked field by field; js-yaml and builtin-modules are gone, the plugin uses Obsidian's own YAML functions.
- Upgrading from 2.1.x (plugin id `video-summary-plugin`): on first start the new version imports the old folder's settings, job history, webhook results and data folder. A data.json damaged by a sync conflict is no longer fatal: the readable settings and records are recovered and the original is kept as `data.corrupt-<time>.json`. Records already in history.json are never collapsed.
- The result cache only removes files inside its own folder; an index copied from another install can no longer delete files elsewhere.
- No lint warnings in the plugin source. The settings page appears in Obsidian 1.13's settings search; asset downloads use Obsidian's requestUrl; UI wording no longer mixes English product terms into Chinese sentences.
- Phones: row actions stay visible without hover, dialogs keep their inner margins, and a video without a cover shows its platform icon in the detail banner too.
- Requires Obsidian 1.8.7 or later.

## 2.6.0

Interface release. 2.5.0 was never published on its own; its fixes ship here.

- New look. The stylesheet was rewritten from scratch. By default it uses only Obsidian theme
  variables, so it follows your theme and light/dark mode; the old hard-coded "Morning/Nightfall"
  colours are gone. An optional **Paper & ink style** (Settings → 输出) adds a paper texture, thin
  ink lines, serif headings and a dark-red accent, in light and dark.
- Side panel: one add box for links, dropped audio/video files or pasted transcripts, a three-way
  switch (只要文稿 / 总结 / 证据), a 学习卡 checkbox and 开始. Language, content type, model,
  save folder, preview-before-write, watch-value assessment, skip-cache, manual transcript, local
  files and part ranges moved into a folded **更多选项**. Less-used commands are in the **···**
  menu; review, cross-video search and settings are links at the bottom.
- Jobs show a 进行中 count; a failed job gets a next step under it (no subtitles → paste a
  transcript; expired login → open settings; service not reachable → test again).
- The current-note strip has **陪读** for processed notes.
- Settings are one page in three parts (连接 / 输出 / 处理); Cookies, platform notes, request field
  names, cache and debug options are folded under **高级**.
- Browser extension 0.4.0: one home screen with the current video and its timestamp, a main button
  that names what it will do (for example 送去总结), three secondary actions, other routes folded,
  and a queue preview. Batch, history and settings are sub-pages. Follows the system light/dark
  mode; the same Paper & ink style can be turned on in its settings.

## 2.5.0

Reliability release. Brings the source back in line with the build that has been in daily use since
September, so the plugin can be rebuilt from this repository without losing fixes.

- Processing time limit now follows the **Timeout (minutes)** setting; it was fixed at 10 minutes
  before. The default is 30 minutes so long lectures are not cut off.
- Worker requests go through Obsidian's native network layer instead of the browser `fetch`, so a
  loopback Worker with an Origin check no longer rejects them. Cancel now also cancels the job on the
  Worker, including a cancel pressed before the job ID came back.
- Note writes check that the note has not changed since it was read; if you typed in it meanwhile,
  the write stops and your text is kept.
- Generated notes stay clean by default: summary and folded transcript only. Evidence and attention
  diagnostics are written only when requested.
- Renaming a video note keeps its task linked; opening a task finished before a rename finds the note
  through its artifact.
- Pasted captions such as `[00:00]first[00:02]second` on one line are split into timed segments.
- The side panel has a labelled **插件设置** button; settings tabs are renamed by purpose.
- Fixed the sidebar header so Hover Editor and similar plugins keep working.
- Cached results from before this release are not reused, because the note format changed.
- Added the **Video Summary Capture** browser extension (`browser-extension/`, 0.3.0). It replaces
  the earlier Video Bridge and Video Capture extensions. The Obsidian REST token now stays on the
  device instead of syncing with the browser profile, and notes saved through the REST API into a
  subfolder keep the folder path.

## 2.4.2

Security and community-directory readiness release.

- Hardened the bundled n8n path against untrusted URL and local-file input, removed shell command
  interpolation of webhook fields, canonicalized supported video paths, confined uploads to safe
  root-level filenames, and removed disabled TLS verification from media commands.
- Required unbound n8n Header Auth credentials for the public webhook and optional Gemini Vision
  request; added matching per-profile plugin headers and removed API keys from URL parameters.
- Bound the bundled Docker service to the host loopback interface and updated its pinned n8n image
  from 2.23.4 to 2.35.7 after upstream security advisories. Pinned yt-dlp to 2026.8.19, restricted
  n8n file roots, blocked node environment access, and disabled n8n diagnostics.
- Removed dynamic `innerHTML` rendering, rejected unsafe backend evidence links, restricted inline
  covers to trusted platform media hosts, and neutralized model-authored Markdown embeds before
  preview or managed-note insertion.
- Bound Worker asset downloads to the active configured loopback origin and fixed asset path with
  redirects disabled; backend-asserted Vault asset paths are discarded and trusted paths are bound
  to the plugin-recorded media root. Reader now auto-loads only existing media files inside the
  current vault.
- Corrected command IDs so Obsidian can apply its own plugin prefix. Users who assigned hotkeys in a
  manually installed 2.4.1 build need to assign those shortcuts once more after updating.
- Removed unpublished versions from `versions.json`, preventing Obsidian from selecting a release
  tag that does not exist when resolving compatibility.
- Added explicit network, external-file, account, and payment-boundary disclosures; redacted
  Webhook secrets from diagnostics and stopped URL-expansion debug output from printing source URLs.
- Added pull-request CI and automated checks for manifest alignment, command IDs, release tags, and
  policy disclosures.

## 2.4.1

Turns the sidebar redesign into an evidence-aware video knowledge workflow.

- Added versioned local knowledge artifacts with timed transcript segments, evidence-backed claims,
  visual references, provenance, stable identifiers, and managed Markdown blocks that preserve
  user-authored content.
- Added a synchronized reader for local media and YouTube, transcript-to-time seeking, persistent
  highlights, and accessible keyboard controls. Bilibili supports click-to-seek but does not claim
  automatic playback tracking.
- Added `quick`, `evidence`, and `deep-visual` processing depths with truthful backend degradation.
  The bundled n8n workflow supports evidence depth; deep visual requires a separately deployed
  compatible Worker, ffmpeg, and a configured visual model.
- Added automatic and manual routing for course, interview, tutorial, news, meeting, review, and
  general content, with route-specific output contracts.
- Added transparent watch / skim / skip attention assessment, bounded must-watch and skippable
  ranges, and explicit limitations when Vault relevance or timed evidence is unavailable.
- Added incremental YouTube playlist and Bilibili collection course manifests with deduplication,
  ordering, deterministic adjacent-lesson dependencies, missing lesson-number gaps, retained
  progress, and pending-note import without automatic model calls. This does not infer semantic
  prerequisite concepts.
- Added a review-gated multi-video Claim Lab and a local cross-modal search index over transcripts,
  OCR, screen text, visual descriptions, metadata, and claims.
- Added local flashcard and question review with attempts, confidence, mastery, due scheduling, and
  links back to source evidence.
- Added offline-first `obsidian://video-summary` capture, managed Obsidian Base views, and validated
  reprocessing from local reproducibility manifests without reacquiring the source.
- Declared desktop-only support for the file and local-backend workflow. The core plugin can load
  from Obsidian 1.4.0; generated `.base` views require Obsidian 1.9.10 or newer with Bases enabled.
- Added platform-cover loading and metadata/status reconciliation so newly added supported links can
  populate library covers after metadata is available.
- Generalized the public n8n prompts so the distributed workflow contains no private user profile
  or unsupported frame-analysis instruction. Instance-specific ASR workflow IDs are replaced by an
  explicit setup placeholder and public subworkflow contract.
- Expanded automated coverage to 143 plugin/workflow tests and added release packaging/version
  validation. Local Obsidian UI acceptance was performed offline; online platform playback,
  playlist import, n8n end-to-end processing, and live visual-model calls remain integration checks.

## 2.4.0

Implements the media-library sidebar design.

- Sidebar: video thumbnails (76×44 job cards, 44×26 rows) with a platform colour bar and duration
  badge, placeholder stripes when no cover is available. `NoteIndex` now reads `cover` / `image` /
  `thumbnail` / `video_cover` and `video_duration` from frontmatter.
- Status dots became status pills, and the pills are actions: a failed row's pill re-runs the job
  without cache, a library row's pill filters the list to that status.
- Job cards are cards with the progress bar welded to the bottom edge; review cards carry
  preview / write / discard inline.
- Header shows a backend status pill (click to test), the input became a card with pill config
  chips, and the primary button is a 36px gradient.
- Panel tabs and the detail sub-tabs are segmented controls. Detail gained a 110px cover banner,
  a meta pill row, a green write-summary card, and collapsed six flat buttons into
  primary + more menu + discard.
- Settings page: gradient app badge header with backend pill, segmented tabs, one card per section
  with lucide icons instead of emoji headings, and the install check is a three-up status grid.
- Batch modal: segmented mode switch, five filter rows compressed to one, quick-select chips with a
  live selected counter, custom checkboxes, a "last batch" success/failure bar derived from
  history, and a footer with concurrency control plus a counted primary button. It now reads the
  note index instead of re-scanning the vault.
- Stylesheet gained a token layer (`--vs-card`, `--vs-chip`, `--vs-accent-*`, status tints, platform
  colours) derived entirely from Obsidian theme variables, so light and dark both work.

## 2.3.1

Fixes the reason 2.3.0 looked like a pile of gray boxes.

- Every control selector is now prefixed with `.video-summary-view`. Themes commonly style
  `button:not(.clickable-icon)` (specificity 0-1-1), which beat the plain single-class selectors in
  2.3.0, so icon buttons, chips, and the primary button were all repainted as default theme buttons.
- Grouping now uses whitespace and hairlines instead of stacked gray fills: the context strip is a
  left rule, detail stats are one wrapped meta line instead of three cards, the error block is a
  tinted panel with a red left border instead of a saturated red slab, and row actions appear on
  hover (always visible on touch devices).

## 2.3.0

Sidebar rewrite. The panel is now four layers: action bar, job stream, note library, detail.

- Jobs are first-class: queued/running/failed work lives in a store on the plugin, survives closing
  the panel, and shows stage, elapsed time, cancel, and retry. Progress stages are reported only by
  backends that expose job status (Codex worker); the n8n webhook is a single request, so the card
  says so instead of faking stages.
- One smart input replaces the single/multi/JSON radio group: URLs, multi-line batches, local file
  names, pasted transcripts, and webhook JSON are detected from the content.
- Settings moved into inline chips (mode, language, model, webhook, output folder) with a popover.
- Optional preview before write: results can be inspected (summary, transcript, metadata, raw JSON)
  and then written to the note, sent to a new note, or discarded.
- Failure reasons are recorded and displayed. History entries now carry the error message, source
  URL, platform, and duration.
- The note library is index-backed with incremental updates instead of a full vault scan on every
  render, filters by status chips, and renders in pages.
- Commands and the batch runner now go through the same job queue, so command-triggered work shows
  up in the panel.
- Visual pass: lucide icons instead of emoji, Obsidian theme variables everywhere, no hardcoded
  colors and no `!important`. Stylesheet went from 3610 to about 2200 lines.
- Removed the orphaned root `VideoSummaryModal.ts` and the duplicate render paths in the old view.
- `minAppVersion` raised to 1.4.0 because the view uses `MarkdownRenderer.render`.

## 2.2.0

- Split processing history into `history.json` so `data.json` stops growing without bound.
- Added backend preflight checks, a cookies manager, `obsidian://video-summary` protocol handling,
  and automatic short-link expansion.

## 2.1.4

- Added Bilibili cookie support with the expected `bilibili_cookies.txt` filename.
- Added Bilibili browser-like `yt-dlp` request headers in the bundled workflow.
- Updated Docker build guidance so `yt-dlp` can be refreshed when Bilibili returns HTTP 412.
- Made Bilibili metadata lookup failures easier to recover from during processing.

## 2.1.3

- Added visible Codex worker job routing and dashboard entry support.
- Improved backend connection testing.
- Added file picker support for multi-file local processing.
- Cleaned public documentation, repository metadata, and release guidance.
- Added governance files for license, contribution, security, launch, and release automation.

## 2.1.2

- Added cache management and repeated URL reuse.
- Reduced unnecessary repeated processing for the same URL and mode.

## 2.1.1

- Added real-time batch processing.
- Improved error isolation so one failed file does not block the whole queue.

## 2.1.0

- Initial public feature set with video note processing, transcript extraction, metadata update, settings, and batch commands.
