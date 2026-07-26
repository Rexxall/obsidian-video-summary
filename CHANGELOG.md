# Changelog

All notable changes to this project are documented here.

## 2.4.0

Implements the「媒体库」design handoff (design_handoff_video_summary_ui, TURN 2/3).

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
