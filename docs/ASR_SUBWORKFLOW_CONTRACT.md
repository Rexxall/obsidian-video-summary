# n8n ASR Subworkflow Contract

The public `Obsidian Video Summary.json` intentionally does not embed a private n8n workflow ID,
speech-provider account ID, or credential binding. Native subtitles and pasted transcripts do not
need an ASR subworkflow. Videos without usable subtitles and local audio/video files do.

After importing the main workflow, configure these two nodes:

- `SubFlow: Transcript`
- `SubFlow: Transcript from Local File`

Both contain the visible placeholder `CONFIGURE_ASR_WORKFLOW_ID`. Select your own saved ASR
subworkflow in each node before relying on the audio-transcription fallback.

## Input

Create the ASR workflow with an **Execute Workflow Trigger** and one string input:

```json
{
  "audio_file_path": "/absolute/path/inside-the-n8n-container/audio-file.mp3"
}
```

The path is inside the n8n runtime, not a macOS/Windows host path. With the repository's Docker
example, downloaded and uploaded media is mounted below `/home/node/`.

## Required output

Return one item containing at least:

```json
{
  "full_transcript": "Complete merged transcript text",
  "transcript_source": "asr"
}
```

The main workflow accepts additional fields but depends on a non-empty `full_transcript`.
If your provider processes chunks, merge them in source order before returning.

## Suggested steps

1. Accept and validate `audio_file_path`.
2. Use ffmpeg to normalize or split long audio if required by your provider.
3. Read each audio file as binary.
4. Send it to the ASR provider you chose using credentials stored in n8n.
5. Merge transcript chunks in source order.
6. Return `full_transcript` and `transcript_source`.
7. Select this workflow in both transcript subflow nodes in the imported main workflow.
8. Run n8n's test execution with a non-sensitive fixture before activating the main webhook.

## Security boundary

- Keep provider tokens and account identifiers in n8n credentials, not node parameters or exports.
- Review any ASR workflow export before sharing it.
- Do not expose n8n or media directories publicly without authentication and network controls.
- Treat `audio_file_path` as untrusted even though it came from the main workflow. Resolve the real
  path and accept only a regular file below `/home/node/files/` or `/home/node/uploads/`; reject
  symlinks, traversal, control characters, and any other root.
- Never interpolate `audio_file_path` into an Execute Command string, shell variable assignment, or
  `bash -c` fragment. Use a fixed executable with a real argument array, or use n8n's binary-file
  nodes without a shell.
- Give every execution its own working directory and delete only files created by that execution.
  Never use a global wildcard such as `/home/node/files/*.mp3`, which can delete another concurrent
  job's input.
- If you do not want an ASR integration, use native subtitles or paste a transcript; do not treat an
  empty fallback as a successful transcription.
