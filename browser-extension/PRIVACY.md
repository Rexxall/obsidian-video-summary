# Video Summary Capture: privacy policy

Last updated: 2026-11-11

Video Summary Capture sends the video you are watching to your own Obsidian vault, or to a Video Summary backend you run yourself. It has no server of its own, no account, no analytics and no advertising.

## What it handles

| Data                                                                             | When                                                                                           | Where it goes                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The page's address and title, and the playback time                              | When you capture a page (toolbar button, shortcut or right-click menu)                         | Obsidian on this computer, through an `obsidian://` link or the Local REST API plugin, or the backend address you set                           |
| YouTube captions the page's player loaded, the channel name and the video length | When you capture a YouTube page and **YouTube 字幕** is on                                     | Obsidian on this computer, with the link                                                                                                        |
| Video links found on the page                                                    | When you open **Scan** in the popup                                                            | Stay in the popup until you send them                                                                                                           |
| bilibili.com cookies                                                             | Only when you press **同步到后端** under **B 站登录**, after Chrome asks you for cookie access | Your backend address, so it can fetch Bilibili subtitles for you                                                                                |
| Settings, queue and history                                                      | While you use the extension                                                                    | Your browser's extension storage. Settings sync with your browser profile; the backend password and the Obsidian REST token stay on this device |

The extension reads a page only when you use it on that page. It does not read your browsing history, other tabs or pages in the background.

## What it does not do

- It sends nothing to the extension's developer or to any third party.
- It does not sell, share or transfer data, and does not use it for advertising, credit decisions or anything other than sending the page you chose to the place you chose.
- It loads no remote code.

The use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Your control

- Turn off caption sending under **Settings → YouTube 字幕**.
- Clear the queue and history in the popup; removing the extension deletes everything it stored.
- What reaches Obsidian or your backend is then in your vault or on your machine, under your control.

## Contact

Questions: open an issue at https://github.com/Rexxall/obsidian-video-summary/issues.
