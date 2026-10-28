# Video Summary Capture

A browser extension that sends the video you are watching to Obsidian or to your Video Summary backend, with the current timestamp.

## What it does

- **Capture the current tab** as a pending note in Obsidian (`obsidian://` link, or the Local REST API plugin if you set a token).
- **Append a link** to one Obsidian file, for a running reading list.
- **Scan a page** for YouTube, Bilibili, Douyin, TikTok, Xiaohongshu and other video links, pick several, and send them together.
- **Queue** videos from the toolbar, a shortcut or the right-click menu, and send the queue later.
- **Copy a timestamped Markdown link** to the moment you are watching.
- **Send to a backend:** the n8n webhook or a compatible Worker, using the same request format as the Obsidian plugin.

## Install

1. Download `video-summary-capture-0.5.0.zip` from the [Releases](https://github.com/Rexxall/obsidian-video-summary/releases) page and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.
3. Open the extension, go to **Settings**, and enter your vault name and folder.

Works in Chrome, Edge, Brave and other Chromium browsers.

## Shortcuts

| Action                     | macOS | Windows / Linux |
| -------------------------- | ----- | --------------- |
| Capture current video      | ⌘⇧S   | Ctrl+Shift+S    |
| Append current video link  | ⌘⇧A   | Ctrl+Shift+A    |
| Add current video to queue | ⌃Z    | Alt+Shift+Q     |
| Open batch scan            | ⌃S    | Alt+Shift+B     |

Change them at `chrome://extensions/shortcuts`.

## Privacy

- Settings sync with your browser profile, except the Obsidian REST token, which stays on this device.
- Queue and history are stored locally in the browser.
- Video links go only to the targets you choose: Obsidian on this computer, or the backend URL you set.

## Development

The files in `vendor/` are generated from the plugin's `shared/` folder so the extension and the plugin detect platforms and build requests the same way:

```bash
node tools/sync-extension-shared.mjs
```

`npm test` fails if `vendor/` is out of date.
