# Chrome Web Store listing: Video Summary Capture 0.9.0

Everything the developer dashboard asks for, ready to paste. Checked against the Chrome Web Store program policies, the privacy-tab guide and the listing-image guide on developer.chrome.com on 2026-11-12.

## Package

Upload `video-summary-capture-0.9.0.zip`, built from `browser-extension/`:

```bash
cd browser-extension && zip -qrX ../video-summary-capture-0.9.0.zip . -x README.md -x '.*' -x '*/.DS_Store' -x 'vendor/*.mjs'
```

`vendor/*.mjs` are the module copies the tests import; the extension loads only `vendor/shared.global.js`.

## Store listing tab

- **Name and summary:** come from the package (`_locales/*/messages.json`), in English, 简体中文 and 日本語.
- **Category:** Productivity → Tools
- **Language:** English, then add 简体中文 and 日本語 and paste each description below.
- **Screenshots (1280×800):** `screenshot-1-<lang>.png` to `screenshot-5-<lang>.png` for each listing language (`en`, `zh_CN`, `ja`), in that order: popup, note anatomy, paper pieces, light and dark, background sending. The example notes are unedited plugin output (each in its listing language) for NASA Goddard's public-domain "An Introduction to the James Webb Space Telescope Mission".
- **Small promo tile (440×280):** `promo-small.png`
- **Icon (128×128):** `browser-extension/icons/icon128.png`
- **Homepage:** https://github.com/Rexxall/obsidian-video-summary
- **Support:** https://github.com/Rexxall/obsidian-video-summary/issues

Sources are in `src/`: `store.html?lang=ja&shot=2` (render at 1280×800), `tile.html` (440×280), `popup/`, popup captures from the packaged extension with demo data, and `fonts/`, Bodoni Moda (SIL OFL, licence beside it).

### Description: English

Press ⌘⇧S (Ctrl+Shift+S) on a YouTube or Bilibili video. The extension reads the captions the page's player has loaded and sends them, with the link and the current time, to your Obsidian vault. The Video Summary plugin for Obsidian then writes the note with the model and key you set there: a summary, timestamped key points, and the full transcript folded at the end. No server and no account; an hour-long lecture takes about a minute.

- Captions in the spoken language come first, written ones before automatic ones. On a dubbed video it takes the original audio's language.
- Queue videos, scan a page for video links, copy a link to the current moment, or append links to a reading list in your vault.
- Optional, off by default: pair it with the plugin and Obsidian stays in the background while the note is written.
- For videos without captions, send the link to a Video Summary backend you run yourself.
- Follows your browser's language (English, 简体中文, 日本語) and light or dark mode.

Works with the free, open-source Video Summary plugin for Obsidian. The extension reads a page only when you use it there and sends nothing to its developer or to anyone else.

Obsidian, YouTube and Bilibili are trademarks of their respective owners. This extension is not made or endorsed by them.

### 简介：简体中文

在 YouTube 或 B 站视频页按 ⌘⇧S（Windows 上是 Ctrl+Shift+S），扩展读取播放器已经加载的字幕，连同链接和当前时间一起送进你的 Obsidian 库。Obsidian 的 Video Summary 插件用你在插件里设好的模型和密钥写成笔记：摘要、带时间戳的要点，末尾折叠着完整文稿。不用服务器，不用注册，一小时的讲座大约一分钟出笔记。

- 优先取原声语言的字幕，人工字幕优先于自动字幕；多语配音的视频取原声那一种。
- 把视频加入队列、扫描页面里的视频链接、复制当前时刻的链接，或把链接追加到库里的待看清单。
- 可选，默认关闭：和插件配对后，Obsidian 留在后台写笔记，不打断你看视频。
- 没有字幕的视频，可以把链接送到你自己运行的 Video Summary 后端。
- 界面跟随浏览器语言（English、简体中文、日本語）和浅色、深色模式。

配合免费开源的 Obsidian 插件 Video Summary 使用。扩展只在你使用的那个页面上读取内容，不向开发者或任何第三方发送数据。

Obsidian、YouTube 和哔哩哔哩是其各自所有者的商标，本扩展并非由它们制作或认可。

### 説明：日本語

YouTube や bilibili の動画ページで ⌘⇧S（Windows では Ctrl+Shift+S）を押すと、プレーヤーが読み込んだ字幕を、リンクと再生位置と一緒に Obsidian の保管庫へ送ります。Obsidian 用プラグイン Video Summary が、プラグインで設定したモデルとキーでノートを書きます。要約、タイムスタンプ付きの要点、末尾に折りたたんだ全文。サーバーもアカウントも不要で、1 時間の講義ならおよそ 1 分です。

- 話されている言語の字幕を優先し、手動字幕を自動字幕より先に使います。吹き替えのある動画では元の音声の言語を選びます。
- 動画をキューに追加、ページ内の動画リンクを検索、今の再生位置へのリンクをコピー、保管庫の「あとで見る」リストへリンクを追記できます。
- 任意（初期設定はオフ）：プラグインとペアリングすれば、Obsidian は裏でノートを書き、動画の視聴を邪魔しません。
- 字幕のない動画は、ご自身で動かす Video Summary バックエンドへリンクを送れます。
- 表示はブラウザの言語（English、简体中文、日本語）とライト／ダークモードに合わせます。

無料のオープンソース Obsidian プラグイン Video Summary と一緒に使います。拡張機能は使ったページだけを読み取り、開発者やほかの誰にもデータを送りません。

Obsidian、YouTube、bilibili はそれぞれの所有者の商標です。この拡張機能はそれらの企業が作成または承認したものではありません。

## Privacy practices tab

**Single purpose:**

> Send the video page the user is on, with its captions and the current playback time, to the user's own Obsidian vault (or a backend the user runs) so it can be turned into a note.

**Permission justifications**

| Field                                                  | Paste                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                            | Reads only the tab where the user presses the toolbar button, the shortcut or the right-click menu: its address, title, playback time and the captions its video player already loaded. No access to other tabs or to pages in the background.                                                                                |
| `scripting`                                            | Runs the reading code in that one tab (playback time, captions, video links on the page), shows a short "Sent" notice there, and opens the obsidian:// link that hands the video to Obsidian.                                                                                                                                 |
| `contextMenus`                                         | Right-click entries on a page or link: send this video, add it to the queue, append it to the list file, copy a timestamped link.                                                                                                                                                                                             |
| `storage`                                              | Saves the user's settings, queue and send history in the browser. The Obsidian token and backend password stay in local storage on this device.                                                                                                                                                                               |
| `clipboardWrite`                                       | Copies a Markdown link to the current moment of the video when the user asks for it.                                                                                                                                                                                                                                          |
| Optional host permission (`http://*/*`, `https://*/*`) | Nothing is granted at install. When the user saves a setting that sends somewhere, the popup asks Chrome for that one site only: `127.0.0.1` for the optional background sending to the Video Summary plugin in Obsidian (off by default) or for Obsidian's Local REST API plugin, and the address of the user's own backend. |
| Optional `cookies`                                     | Requested only when the user presses Sync next to Bilibili sign-in, to pass their bilibili.com login cookies to their own backend so it can fetch subtitles. Never read otherwise.                                                                                                                                            |

**Are you using remote code?** No, I am not using remote code. All JavaScript is in the package; the extension fetches no scripts.

**Data usage.** Of the dashboard's categories (Personally identifiable information, Health information, Financial and payment information, Authentication information, Personal communications, Location, Web history, User activity, Website content), tick only these:

- **Website content:** the page title and the captions or subtitles of the video the user sends (YouTube captions the player loaded; Bilibili subtitles the page fetches with the user's own sign-in, which the extension neither reads nor stores).
- **Web history:** the address of the page the user sends (only that page, only on their action).
- **Authentication information:** only with the optional Bilibili sync, bilibili.com cookies sent to the user's own backend.

Tick all three certifications: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/Rexxall/obsidian-video-summary/blob/main/browser-extension/PRIVACY.md (live once this commit is pushed to `main`).

## Distribution tab

Free; all regions; Public (or Unlisted to try the store install first).

## Test instructions tab (optional)

> No login is needed. Open any YouTube video and press the toolbar button: the popup shows the video and its playback time. "Summarize in Obsidian" opens an obsidian:// link, which needs the free Obsidian app with the Video Summary plugin; without Obsidian, "Copy link" and "Add to queue" show the same page reading.

## Policy notes

- One page is read, and only when the user acts; installing asks for no site access at all, this computer included.
- No media is downloaded. The extension reads the captions the player already loaded on the page.
- The description names four products (Obsidian, YouTube, Bilibili, Video Summary), under the five-brand keyword-spam limit.
- Trademarks are named only to say what the extension works with, with a line that it is not made or endorsed by them.
