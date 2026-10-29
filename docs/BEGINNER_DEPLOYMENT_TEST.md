# Clean-environment acceptance test (2.8.0)

What a new user goes through, run from scratch on 2026-10-29: a new Docker project and volumes, a
new Obsidian vault with only this plugin, and real DeepSeek and SiliconFlow keys. The machine
already ran another n8n on port 5678, the case most likely to trip a new user.

Environment: macOS, OrbStack (8 CPU, 8 GB), Obsidian 1.13.7, network in Japan (global registries).
The backend folder was produced by `git archive`, exactly as the release zip is.

## Timings

| Step                                       | Time       | Notes                                                              |
| ------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| Image build, no cache                      | 9 min 47 s | 2.29 GB image; most of it is `npm install n8n`                     |
| Start script to "ready" (new volumes)      | 38 s       | port 5678 taken, the script moved to 5679 by itself                |
| Restart after a workflow update            | 40–45 s    | re-imports only when workflows or `.env` changed                   |
| Setup wizard: paste code, full check       | 3.5 s      | every required check green                                         |
| Setup wizard: trial run                    | 36.9 s     | built-in 150-character text                                        |
| Pasted transcript (about 600 characters)   | 40.3 s     | summary written into the note, note renamed                        |
| Local audio, 48 s (`讲座 01.m4a`)          | 53.3 s     | speech-to-text 8.1 s, model 41.6 s                                 |
| Local audio, 24 min (`长讲座.mp3`)         | 64.6 s     | cut into 3 parts; speech-to-text 14.7 s                            |
| Bilibili, no login (5 min)                 | 74.4 s     | no subtitles without login; fell back to download + speech-to-text |
| Bilibili, logged in (47 min, AI subtitles) | 180.8 s    | used `ai-zh` subtitles with timestamps; model 162 s                |
| Local PDF                                  | 58.5 s     | text taken from the PDF, no model call for reading                 |

Model time dominates every job; the backend's own steps take seconds.

## Cost

DeepSeek `deepseek-flash`, 8 summaries including the 47-minute video: about 60,000 input and 86,000
output tokens, about ¥0.4 at off-peak prices. SiliconFlow SenseVoice is free.

## Problems found and fixed during the run

| Problem                                                                | Effect                                                                                          | Fix                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The bundle kept `import('obsidian')`                                   | every webhook request from the plugin failed in Obsidian ("Failed to resolve module specifier") | esbuild now turns dynamic imports into `require`; a test guards the bundle        |
| n8n 2.x Code nodes have no `URL` global                                | every link was rejected as "Video URL is invalid"                                               | `NODE_FUNCTION_ALLOW_BUILTIN=url`, and the two link nodes take `URL` from it      |
| Bilibili redirects `/video/BV…` to `/video/BV…/`                       | "Short-link redirect limit exceeded" for every Bilibili link                                    | redirects are followed only for short links (b23.tv and similar)                  |
| Bilibili's public view API answers 412                                 | no title or duration                                                                            | falls back to yt-dlp for the metadata                                             |
| yt-dlp lists Bilibili subtitles only when asked                        | logged-in videos with AI subtitles still went to speech-to-text                                 | the metadata call asks for subtitles                                              |
| Quoted `local_file: '…'` kept its quotes                               | local files were never found                                                                    | YAML quotes are removed                                                           |
| Importing over a published workflow re-published the old version first | for 10–20 s after an update the old workflow answered                                           | the start step unpublishes before importing                                       |
| PDFs were routed as images; images were sent as n8n's file reference   | PDF gave an empty text, images were rejected                                                    | route by file extension; read image bytes through n8n's helper                    |
| The default image model (GLM-5.3-Flash) did not answer within 90 s     | image notes hung for five minutes                                                               | default is now `Qwen/Qwen3-VL-8B-Instruct`; the request times out after 2 minutes |
| Downloaded audio and subtitles stayed in the working volume            | the volume grows forever                                                                        | files older than a day are removed on the next link job                           |

## Not covered

- **Image reading end to end.** The SiliconFlow test account ran out of balance during the image
  tests. With a zero balance SiliconFlow rejects even its free models (HTTP 402), which the setup
  check now explains. The model was checked separately before that: it read an image correctly in
  13.5 s.
- **Windows.** `vs-backend.ps1` and `start-windows.cmd` were not run on Windows.
- **Mainland China network.** The mirror switch was checked only for reachability of the mirrors
  (Docker mirror, npmmirror, Aliyun PyPI and Alpine all answered), not by building from inside China.
- **Douyin, Xiaohongshu, YouTube.** Not part of this run.
