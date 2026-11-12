# Video Summary Capture

A browser extension that sends the video you are watching to Obsidian or to your Video Summary backend, with the current timestamp.

## What it does

- **Capture the current tab** as a pending note in Obsidian (`obsidian://` link, or the Local REST API plugin if you set a token).
- **Append a link** to one Obsidian file, for a running reading list.
- **Scan a page** for YouTube, Bilibili, Douyin, TikTok, Xiaohongshu and other video links, pick several, and send them together.
- **Queue** videos from the toolbar, a shortcut or the right-click menu, and send the queue later.
- **Copy a timestamped Markdown link** to the moment you are watching.
- **Send to a backend:** the n8n webhook, using the same request format as the Obsidian plugin.
- **Backend connection code:** paste the code the backend's start script prints into Settings → Connection code; it sets the address and the password header. The password stays on this computer and is not synced.
- **Send without switching to Obsidian** (optional, off by default): turn on **Receive in the background** in Obsidian, then copy the pairing code from Obsidian (**Settings → Video Summary → Browser extension**) into the extension's **Settings → Obsidian pairing code**. Then switch on **Send without switching to Obsidian** and press Save; Chrome asks once for access to this computer. Captures then go to the plugin over `127.0.0.1` and Obsidian stays in the background. When Obsidian is not running, the extension opens it with an `obsidian://` link as before.
- **Send YouTube captions:** capturing a YouTube page also sends the captions its player loaded (written ones in the spoken language first, then automatic ones), so the Obsidian plugin can write the note without a backend. The extension switches captions on for a moment if they are off and switches them off again. Nothing is read during an ad; then only the link is sent. Turn it off under Settings → Send YouTube captions.
- **Sync Bilibili login:** Settings → Bilibili sign-in → Sync sends this browser's bilibili.com cookies to your own backend so it can fetch subtitles and Bilibili's AI subtitles. Chrome asks for cookie access the first time; nothing is sent anywhere else.

## Install

1. Open the [latest Video Summary release](https://github.com/Rexxall/obsidian-video-summary/releases/latest) and download `video-summary-capture-<version>.zip` under **Other downloads** (it lives in its own release, `capture-v<version>`), then unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.
3. Open the extension, go to **Settings**, and enter your vault name and folder.

Works in Chrome, Edge, Brave and other Chromium browsers.

## Shortcuts

| Action                     | macOS           | Windows / Linux |
| -------------------------- | --------------- | --------------- |
| Capture current video      | ⌘⇧S             | Ctrl+Shift+S    |
| Append current video link  | set it yourself | set it yourself |
| Add current video to queue | ⌃Z              | Alt+Shift+Q     |
| Open batch scan            | ⌃S              | Alt+Shift+B     |

Change them at `chrome://extensions/shortcuts`. Chrome keeps ⌘⇧A / Ctrl+Shift+A for its own tab search, so the append shortcut starts unset.

The popup, menus and notices follow the browser's language: English, 简体中文 or 日本語.

## Privacy

- **Site access:** the extension reads only the tab you use it on (toolbar button, shortcut or right-click menu), and installing grants no site access at all. Opening Obsidian with an `obsidian://` link needs none; when you save a setting that sends to a site (Obsidian on this computer for background sending or the REST API, or your backend), Chrome asks you for that one site.
- Settings sync with your browser profile, except the Obsidian REST token, which stays on this device.
- Queue and history are stored locally in the browser.
- Video links go only to the targets you choose: Obsidian on this computer, or the backend URL you set.
- YouTube captions are read from the page you are on and go only to Obsidian with the link; the extension makes no request of its own to anyone else.
- The full policy is in [PRIVACY.md](PRIVACY.md).

## Development

The files in `vendor/` are generated from the plugin's `shared/` folder so the extension and the plugin detect platforms and build requests the same way:

```bash
node tools/sync-extension-shared.mjs
```

`npm test` fails if `vendor/` is out of date.
