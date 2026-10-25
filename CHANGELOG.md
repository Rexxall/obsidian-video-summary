# Changelog

All notable changes to this project are documented here.

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
