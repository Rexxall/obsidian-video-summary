# Video Summary backend

Start: macOS `start-mac.command` (right-click → Open), Windows `start-windows.cmd`, Linux
`./vs-backend.sh`. The full guide, in Chinese with English and Japanese summaries, is
[INSTALL.md](https://github.com/Rexxall/obsidian-video-summary/blob/main/INSTALL.md).

| File                            | Purpose                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `.env` (created on first start) | keys, model names, port; edit, then run the start script again                  |
| `uploads/`                      | put local audio, video, images and PDFs here                                    |
| `cookies/`                      | site login cookies (filled by the plugin's scan login or the browser extension) |
| `workflows/`                    | the two n8n workflows, imported automatically                                   |
| `init/`                         | first-start configuration that runs inside the container                        |
