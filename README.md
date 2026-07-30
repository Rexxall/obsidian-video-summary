# Video Summary

Turn videos, local recordings, and rough transcripts into evidence-linked, searchable Obsidian
knowledge.

Video Summary connects Obsidian to a processing endpoint you control. The repository includes a
general-purpose n8n workflow; the plugin can also talk to a compatible external Worker endpoint.
It keeps the reader-facing result in Markdown and stores structured evidence, learning state, and
reproducibility metadata as local plugin sidecars.

## What it does

- Accept one URL, multiple URLs, n8n upload-relative local media names, pasted transcripts, or
  webhook JSON in the sidebar. Commands operate on the current note or batch selection;
  `obsidian://video-summary` captures a URL or validated absolute local media path.
- Generate Markdown notes plus timestamped transcript segments, evidence-backed claims,
  provenance, attention guidance, and optional learning cards.
- Read local media and YouTube beside the transcript, seek from evidence, and keep user highlights.
  Bilibili currently supports click-to-seek but not automatic playback tracking.
- Route courses, interviews, tutorials, news, meetings, reviews, and general videos into distinct
  output structures.
- Compile supported playlists into incremental course manifests without spending model quota
  during import.
- Search transcript, OCR, screen text, visual descriptions, titles, authors, and claims through one
  local cross-modal index.
- Compare two or more persisted videos in a review-gated claim matrix.
- Review flashcards and questions with local progress and due-date scheduling.
- Keep a searchable video library with real job status, cover images, retry, cancellation where the
  backend supports it, and optional preview before write.
- Switch between endpoint profiles, reuse cached results, and reprocess from verified local
  artifacts without reacquiring the source.

## Video knowledge workflow in 2.4.1

| Direction                 | Durable result                                                           | Requirement or boundary                                                                  |
| ------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Evidence map              | Timed segments, claims, source type, confidence, and provenance          | Precise links require a timed transcript                                                 |
| Synchronized reader       | Player, active transcript, seek links, and persistent highlights         | Local media and YouTube can follow playback; Bilibili is click-to-seek                   |
| Visual understanding      | Keyframes, OCR, and visual-only observations                             | Deep visual requires a separately deployed compatible Worker, ffmpeg, and a visual model |
| Content routing           | Course, interview, tutorial, news, meeting, review, or general structure | Manual choice overrides automatic routing                                                |
| Attention assessment      | `watch`, `skim`, or `skip`, transparent scores, and bounded ranges       | Missing Vault context is reported instead of invented                                    |
| Course compiler           | Incremental playlist manifest, ordering, numbered-lesson gaps, progress  | Dependencies come only from explicit adjacent lesson numbers; import does not call AI    |
| Claim Lab                 | Editable multi-video evidence matrix                                     | Requires at least two persisted artifacts; relations need human review                   |
| Cross-modal memory        | Local searchable evidence index with filters and score explanation       | Searches persisted artifacts only                                                        |
| Learning loop             | Flashcards, questions, attempts, mastery, and review schedule            | Progress is stored locally                                                               |
| Capture, Base, and replay | Offline inbox, managed `.base`, and reproducibility manifest             | Capture-only works offline; replay uses the current backend/model                        |

The bundled n8n workflow supports transcript acquisition and `evidence` depth. It does not perform
real frame analysis. `deep-visual` is available only through a compatible external Worker and is
not bundled with this repository. See the
[backend capability matrix](docs/BACKEND_CAPABILITY_MATRIX.md) before choosing a backend.

## Sidebar

The panel has four layers:

- **Action bar** — the note you currently have open and its status, one input that accepts URLs,
  multi-line batches, local file names, pasted transcripts, or webhook JSON, plus inline chips for
  mode, language, model, webhook profile, and output folder.
- **Jobs** — everything queued, running, waiting for confirmation, or recently finished. Cards show
  the current stage when the backend reports one, elapsed time, cancel, and retry. Failures show the
  actual error text.
- **Library** — every video note in the vault, backed by an incremental index rather than a full
  scan, filtered by status chips and searchable.
- **Detail** — synchronized reader, evidence, result preview, transcript, metadata, and logs, plus
  write actions: write to the note, apply to the open note, insert at the end, or create a new note.

Turn on `写入前预览` in the chip row if you want every result to stop for confirmation before it
touches a note.

## Typical workflow

1. Create a note with a `link` property, paste a URL in the sidebar, or capture it with the Obsidian
   URI.
2. Choose `quick` or `evidence` depth. Use `deep-visual` only with a configured compatible Worker.
3. Submit the job. The plugin sends the minimum selected input and settings to your endpoint.
4. The endpoint acquires or uses the transcript and returns Markdown plus any structured evidence.
5. Review the result first if `写入前预览` is enabled.
6. The plugin updates managed Markdown/frontmatter and saves machine-readable sidecars locally.
7. Open the reader, search, Claim Lab, course, or review tools when the artifact contains the
   required evidence.

```yaml
---
link: 'https://www.youtube.com/watch?v=example'
status: pending
---
```

## Install

### Install a release

Download `video-summary-2.4.1.zip` from the
[2.4.1 release](https://github.com/Rexxall/obsidian-video-summary-plugin/releases/tag/2.4.1)
and extract its three files into:

```text
<your-vault>/.obsidian/plugins/video-summary/
```

The folder must directly contain:

```text
main.js
manifest.json
styles.css
```

Restart Obsidian, then enable `Video Summary` from `Settings -> Community plugins`.

The separately attached `Obsidian Video Summary.json` is an n8n import, not an Obsidian plugin
file.

This release is desktop-only. Its manifest minimum is Obsidian 1.4.0 and it was exercised on
Obsidian 1.12.7. The generated `.base` library views require Obsidian 1.9.10 or newer with the
Bases core plugin enabled.

### Build from source

```bash
git clone https://github.com/Rexxall/obsidian-video-summary-plugin.git
cd obsidian-video-summary-plugin
npm install
npm run build
```

Copy these files into your vault plugin folder:

```text
main.js
manifest.json
styles.css
```

Recommended folder:

```text
<your-vault>/.obsidian/plugins/video-summary/
```

### n8n workflow

Import `Obsidian Video Summary.json` into n8n and configure your own service credentials inside n8n. The repository never includes private credentials, cookies, personal cache files, or vault data.

Default webhook:

```text
http://127.0.0.1:5678/webhook/obsidian-video-summary
```

The public workflow deliberately leaves both ASR subworkflow selectors at
`CONFIGURE_ASR_WORKFLOW_ID`. Native subtitles and pasted transcripts work without that integration;
videos with no usable subtitle and local audio/video require your own ASR subworkflow. Configure the
two `SubFlow: Transcript...` nodes using the
[ASR subworkflow contract](docs/ASR_SUBWORKFLOW_CONTRACT.md).

For bundled n8n local-file processing, copy media into `docker/uploads/` and submit only the file
name or a safe relative path below that folder. Do not send a host absolute path; the container
cannot see it. URI capture can still save an absolute local path offline, but automatic processing
requires a Worker that can access that exact path.

For a full setup guide, see [INSTALL.md](INSTALL.md).

If you are setting this up for the first time, also read
[Beginner Deployment Test and Troubleshooting](docs/BEGINNER_DEPLOYMENT_TEST.md). It records
real clean-environment install issues and fixes, including Docker, n8n, webhook paths, local
files, cookies, and credentials.

For a publishing-ready walkthrough, see the sample notes and scripts in [demo/](demo/).

## Commands

The 2.4.1 command labels are currently Chinese. Common entries include:

- `快速总结当前笔记`
- `将当前笔记全文作为文稿总结`
- `快速提取文稿`
- `更新视频信息（不改正文）`
- `批量处理视频`
- `搜索跨模态视频记忆`
- `生成多视频论点实验室`
- `复习当前视频的学习卡`
- `复习所有到期的视频学习卡`
- `用本地可复现工件重新处理`
- `生成或安全更新视频库 Base`
- `标记为非视频笔记`

## Settings

- Backend: n8n webhook or compatible worker endpoint.
- Webhook profiles: save and switch multiple endpoints.
- Setup check: run a connection diagnostic from Obsidian settings before processing a real video.
- Processing mode: full note, transcript only, or metadata only.
- Language: Chinese, English, or Japanese.
- Processing model: a label passed through to your n8n switch node.
- Cache: reuse only an exact source-and-processing fingerprint, including backend, model, language,
  depth, content route, visual/attention/learning options, and local-file digest when applicable.
- Batch concurrency: limit simultaneous files.
- Payload keys: customize request field names to match your workflow.

## Platform and transcript strategy

The bundled n8n workflow uses this transcript ladder:

1. Use a transcript pasted in Obsidian when present.
2. Try native subtitles first for YouTube and Bilibili, selecting the video's original audio
   language rather than the Obsidian note output language.
3. Fall back to audio download and your configured ASR subworkflow when no usable subtitle is
   found. The ASR subworkflow is not bundled.
4. Treat Douyin, TikTok, and Xiaohongshu/Rednote as cookie-sensitive best-effort sources.

Supported URL families include YouTube, Bilibili, Bilibili short links, Douyin short links,
TikTok short links, and Xiaohongshu/Rednote links.

For platform-specific expectations, see
[Platform Capability Matrix](docs/PLATFORM_CAPABILITY_MATRIX.md).
For processing-depth and backend differences, see
[Backend Capability Matrix](docs/BACKEND_CAPABILITY_MATRIX.md).

## Privacy and data boundary

The plugin only sends the data required for the selected operation to the endpoint you configure.
Depending on mode, that can include the note name, video URL, pasted transcript, local file name or
path,
language, processing mode, model label, user highlights, or a validated local evidence snapshot.

Rich results are stored below the plugin folder in local sidecars:

```text
data/knowledge-artifacts/
data/learning-progress/
data/reproducibility/
data/course-manifests/
```

These files can contain transcripts, claims, visual evidence references, learning attempts, and
course progress. They are not committed by this repository, but they are part of your local plugin
data: include them in private backups if you want the knowledge tools to survive a reinstall, and
remove them before sharing a vault or plugin-data folder.

Do not commit these local files:

- `data.json`
- `data/`
- `.DS_Store`
- cookie files
- credential exports
- personal transcripts or processed vault notes

The included `.gitignore` already excludes local cache and runtime data. Review ignored files before publishing a release.

## Development

```bash
npm install
npm run dev
npm run build
```

Useful checks before release:

```bash
npm test
npm run build
npm run lint
npm run format
git status --short
```

## Release

Obsidian installs community plugin files from GitHub Releases. The release tag must match `manifest.json` exactly and include:

- `main.js`
- `manifest.json`
- `styles.css` if present

The release workflow also publishes:

- `video-summary-<version>.zip` containing only the three plugin runtime files
- `Obsidian Video Summary.json` as a separate optional n8n import
- `SHA256SUMS` for downloaded-asset verification

The included GitHub Actions workflow tests and builds the plugin, validates all version files, and
publishes the assets when you push a semantic version tag such as `2.4.1`.

## Community submission

Before submitting to the Obsidian community directory, confirm:

- `manifest.json` has an accurate `id`, `name`, `version`, `description`, `author`, and `minAppVersion`.
- `README.md` explains purpose and usage.
- `LICENSE` is present.
- The release tag equals the manifest version.
- The release assets include the required plugin files.

## Support

- Issues: https://github.com/Rexxall/obsidian-video-summary-plugin/issues
- Discussions: https://github.com/Rexxall/obsidian-video-summary-plugin/discussions

## License

MIT. See [LICENSE](LICENSE).
