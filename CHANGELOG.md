# Changelog

All notable changes to this project are documented here.

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
