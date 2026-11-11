# Chrome Web Store listing: Video Summary Capture

Everything the developer dashboard asks for, ready to paste. Images are in this folder; their sources are in `src/` (render with headless Chrome at 1280×800 and 440×280).

## Store listing

- **Name:** Video Summary Capture
- **Summary** (from the manifest, 106 of 132 characters): Press ⌘⇧S on a YouTube video: its captions go to your Obsidian vault, where Video Summary writes the note.
- **Category:** Productivity → Tools
- **Language:** English (add 简体中文 below as a second listing language)
- **Screenshots:** `screenshot-1.png` (1280×800)
- **Small promo tile:** `promo-small.png` (440×280)
- **Icon:** `browser-extension/icons/icon128.png`
- **Homepage:** https://github.com/Rexxall/obsidian-video-summary
- **Support:** https://github.com/Rexxall/obsidian-video-summary/issues

### Description (English)

Press ⌘⇧S (Ctrl+Shift+S) on a YouTube video. The extension reads the captions the page's player has loaded and sends them, with the link, to your Obsidian vault. The Video Summary plugin then writes the note with your own model key: summary, timestamped key points, and the full transcript folded at the end. No server, no account; about a minute for an hour-long lecture.

- Works with the Video Summary plugin for Obsidian (free, open source).
- Uses the summary model you choose in the plugin (DeepSeek, Qwen, Kimi, Gemini, SiliconFlow or any OpenAI-compatible address), with your own key.
- Captions in the spoken language are preferred; written captions before automatic ones.
- Also: queue videos, scan a page for video links, copy a timestamped link, append a link to a reading list.
- Advanced: send links to your own n8n backend for platforms and videos without captions.

The extension reads a page only when you use it there, and sends nothing to its developer or any third party.

### 简介（简体中文）

在 YouTube 视频页按 ⌘⇧S（Windows 上是 Ctrl+Shift+S），扩展会读取播放器已经加载的字幕，连同链接一起送进你的 Obsidian 库。Video Summary 插件用你自己的模型密钥写成笔记：摘要、带时间戳的要点，正文末尾折叠着完整文稿。不用服务器，不用注册，一小时的讲座大约一分钟出笔记。

- 配合 Obsidian 的 Video Summary 插件使用（免费、开源）。
- 用你在插件里选的模型（DeepSeek、通义千问、Kimi、Gemini、硅基流动，或任何兼容 OpenAI 的地址）和你自己的密钥。
- 优先取原声语言的字幕，人工字幕优先于自动字幕。
- 还能：把视频加入队列、扫描页面里的视频链接、复制带时间戳的链接、把链接追加到阅读清单。
- 高阶玩法：没有字幕的平台和视频，可以送到你自己的 n8n 后端处理。

扩展只在你使用的那个页面上读取内容，不向开发者或任何第三方发送数据。

## Privacy practices tab

**Single purpose:** Send the video page you are on, with its captions, to your own Obsidian vault (or your own backend) so it can be turned into a note.

**Permission justifications**

| Permission                                | Why                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                               | Read the page you invoke the extension on (toolbar, shortcut, right-click menu): its address, title, playback time and the captions its player loaded. |
| `scripting`                               | Run the reading code in that tab, show the "Sent" message there, and open the `obsidian://` link from it.                                              |
| `contextMenus`                            | The right-click entries: capture this page, queue a link, copy a timestamped link.                                                                     |
| `storage`                                 | Settings, the queue and the send history.                                                                                                              |
| `clipboardWrite`                          | Copy a timestamped Markdown link.                                                                                                                      |
| Host `localhost`, `127.0.0.1`             | Send to Obsidian's Local REST API plugin and to a backend running on the same computer.                                                                |
| Optional host `http://*/*`, `https://*/*` | Requested for one site only, when the user saves the address of a backend on another computer.                                                         |
| Optional `cookies`                        | Requested only when the user presses "sync Bilibili login", to pass their bilibili.com cookies to their own backend.                                   |

**Remote code:** No. All code is in the package.

**Data usage** (tick these): Website content (captions, page title), Web history is **not** collected (only the page the user acts on); Authentication information: only for the optional Bilibili sync, sent to the user's own backend. Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** https://github.com/Rexxall/obsidian-video-summary/blob/main/browser-extension/PRIVACY.md (live once `main` is pushed).

## Package

```bash
cd browser-extension && zip -r ../video-summary-capture-0.8.0.zip . -x README.md -x '.*'
```

## Before submitting

- The developer account needs a one-time registration fee and 2-Step Verification on the Google account.
- Review usually takes a few days, up to a few weeks; broad host permissions make it longer, which is why install-time access is now limited to this computer.
- Policy line to keep in mind: no downloading of videos. The extension reads captions the page has already loaded and never downloads media.
