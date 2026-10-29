# Speech-to-text subworkflow

The backend package ships `backend/workflows/video-summary-speech.json` (n8n id
`vsSpeechToText01`) and imports it on every start that changes it. The main workflow calls it for
videos without usable subtitles, for local audio/video, and for the setup wizard's deep check.

## What the bundled workflow does

1. Accepts `audio_file_path`, a path inside the container under `/home/node/files/` or
   `/home/node/uploads/`. Symlinks, other roots and non-regular files are rejected.
2. Converts the audio with ffmpeg to 16 kHz mono MP3 and cuts it into 10-minute parts in a working
   folder of its own (`/home/node/files/stt-<random>`). Each part stays far below the 50 MB and
   one-hour limits of SiliconFlow's `/audio/transcriptions`.
3. Sends the parts one by one to `VS_SPEECH_BASE_URL/audio/transcriptions` with
   `model=VS_SPEECH_MODEL` (default `FunAudioLLM/SenseVoiceSmall`), retrying each part up to three
   times.
4. Joins the text in order, strips model tags such as `<|zh|>`, and deletes its working folder.
   Working folders older than six hours (from a run that failed half-way) are removed by the next
   run.

Any OpenAI-compatible `/audio/transcriptions` service works: set the three `VS_SPEECH_*` values in
`.env` and run the start script again.

## Contract, for a replacement

Input (Execute Workflow Trigger):

```json
{ "audio_file_path": "/home/node/uploads/lecture.mp3" }
```

Output, one item:

```json
{
  "full_transcript": "Complete transcript in source order",
  "transcript_source": "asr",
  "video_segments": [{ "id": "stt-001", "start": 0, "end": 600, "text": "…" }],
  "timing_quality": "estimated"
}
```

`full_transcript` is required; the other fields are optional. Keep provider keys in n8n
credentials, never interpolate `audio_file_path` into a shell string, and delete only files your
own run created.
