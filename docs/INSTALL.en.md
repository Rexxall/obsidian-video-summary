# Installation

[中文（完整版）](../INSTALL.md) · [日本語](INSTALL.ja.md)

Video Summary has two parts: the Obsidian plugin, and a backend that runs on your own computer in
Docker and fetches subtitles or audio, transcribes, and asks a model for the summary. A start script
sets the backend up; no coding is needed. Allow about 20 minutes, most of it the first image build.

## You need

- Obsidian desktop.
- Docker Desktop (Windows, macOS) or OrbStack (macOS), running.
- A key for an OpenAI-compatible chat model. The default is DeepSeek (`deepseek-flash`); any
  OpenAI-compatible service works, Gemini included.
- Optional: a SiliconFlow key for speech-to-text (its SenseVoice model is free) and image reading.
  Videos without subtitles and local audio/video need it.

## Steps

1. Install **Video Summary** from Obsidian's community plugins (or copy `main.js`, `manifest.json`
   and `styles.css` from the [latest release](https://github.com/Rexxall/obsidian-video-summary/releases/latest)
   into `<vault>/.obsidian/plugins/video-summary/`).
2. Download `video-summary-backend-<version>.zip` from the same release and unzip it somewhere
   permanent, outside your vault.
3. Start it: on macOS right-click `start-mac.command` → Open; on Windows double-click
   `start-windows.cmd`; on Linux run `./vs-backend.sh`. Paste the keys when asked. The first build
   takes 5–15 minutes.
4. The script ends with a **connection code** and copies it to the clipboard. It is the backend's
   password; keep it private. `./vs-backend.sh code` shows it again.
5. In Obsidian, open **Settings → Video Summary → 首次配置 (first-run setup)**: paste the code, run
   the full check, then the trial run. Each failing check says what to change.

## Everyday commands

`./vs-backend.sh` (Windows: `.\vs-backend.ps1`) followed by nothing (start, and apply `.env`
changes), `check`, `code`, `keys`, `logs`, `stop` or `update` (refresh yt-dlp when a site starts
failing).

To use another model, edit `VS_CHAT_BASE_URL`, `VS_CHAT_MODEL` and `VS_CHAT_API_KEY` in `.env` and
run the start script again. The table in the [Chinese guide](../INSTALL.md#换模型) lists tested
settings.

## Troubleshooting

Run the full check in the plugin first; it names the setting to fix. Common cases: Docker not
running (open it, rerun the script); port 5678 taken (the script picks the next free port, the code
already has it); "not ready" right after start (wait a minute); wrong key (`./vs-backend.sh keys`);
YouTube blocked on your network (set `VS_HTTP_PROXY`). The backend listens only on `127.0.0.1`; see
[backend/SECURITY.md](../backend/SECURITY.md) before exposing it anywhere else.

To see which step failed, open the address in the connection code (by default
<http://127.0.0.1:5678>) in a browser; the first visit creates an n8n account that stays on your
computer. Open **Executions**, then the latest run. A model or key problem still shows Success,
because the error is handed back to the plugin: open **AI: Write Note** and read its output.

<img src="screenshots/n8n-workflow.jpg" width="860" alt="The Video Summary workflow in n8n, one lane per kind of request">
