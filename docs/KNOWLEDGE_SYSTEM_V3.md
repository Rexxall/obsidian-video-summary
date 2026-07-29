# Video Knowledge System v3

This document is the implementation and acceptance contract for the ten product
directions approved on 2026-07-29. A direction is complete only when its data,
user interaction, durable output, and verification evidence all exist.

## Delivery order

The order follows data dependencies rather than the order in which the ideas
were proposed.

1. Versioned artifact schema and reproducible storage.
2. Multimodal evidence map.
3. Synchronized video reader.
4. Visual understanding and processing-depth controls.
5. Automatic content-type routing.
6. Attention assessment.
7. Playlist and channel course compiler.
8. Multi-video claim lab.
9. Cross-modal video memory.
10. Learning and review loop.
11. Capture-anywhere inbox and native Obsidian views.

The final item combines the capture and native-Obsidian portions of product
direction 10. Reproducible storage is implemented first because every other
direction depends on it.

## Canonical artifact

Rich results are persisted as a versioned JSON sidecar. Markdown remains the
reader-facing durable note; the sidecar contains machine-oriented evidence that
would be unsafe or unwieldy to keep in YAML.

```text
<plugin-data>/artifacts/<artifact-id>.json
```

Every artifact records:

- canonical source URL and source hash;
- processing depth, backend, model, prompt/profile version, and generation time;
- timestamped transcript segments;
- visual observations and keyframes;
- evidence-backed claims;
- content route and attention assessment;
- learning cards, questions, attempts, and review schedule;
- user highlights;
- playlist/course membership;
- searchable text and visual descriptors.

Markdown frontmatter stores only stable lookup and filter fields such as
`video_artifact_id`, `video_content_type`, `video_attention_action`,
`video_review_due`, and `video_summary_status`.

## Acceptance matrix

### 1. Multimodal evidence map

- A rich backend response with timestamped segments and claims is normalized.
- Native subtitle cues retain start/end times instead of being flattened.
- Each claim distinguishes speech, screen text, comments, user input, and AI
  inference.
- Clicking a claim or segment opens/seeks the source timestamp.
- Stable segment/block identifiers survive reprocessing of unchanged evidence.
- The Markdown note contains a bounded evidence section with timestamp links.

### 2. Synchronized video reader

- The detail view has a reader tab with player, transcript, evidence, and
  highlight controls.
- Clicking a transcript segment seeks the embedded/local video.
- Supported players update the active transcript segment during playback.
- User highlights persist in the artifact and influence later regeneration
  payloads.
- Unsupported players degrade to an external timestamp link without losing
  transcript or highlights.

### 3. Visual understanding

- Processing depth offers quick, evidence, and deep-visual modes.
- Evidence/deep modes return or derive keyframes, OCR text, and visual-only
  observations.
- Speech/screen mismatches are presented as review candidates, never asserted
  as certain errors.
- Fast-scene limitations are visible in provenance.
- A fixture video proves visual evidence is written, rendered, and searchable.

### 4. Automatic content-type routing

- Supported routes include course, interview, tutorial, news, meeting, review,
  and general.
- Auto routing can be overridden per job.
- Each route produces a distinct durable structure.
- Speaker-labelled input is preserved for interview and meeting routes.

### 5. Attention assessment

- The result contains watch, skim, or skip plus transparent component scores.
- It lists must-watch and skippable ranges with reasons.
- Vault relevance is a separate signal rather than an opaque combined score.
- The assessment is visible before expensive deep processing can be requested.

### 6. Playlist/channel course compiler

- YouTube playlists and Bilibili collections/favourites are supported.
- Import is canonical-ID deduplicated and incremental.
- A course note records source order, recommended order, prerequisites,
  progress, duplicates, and missing concepts.
- Newly discovered videos enter pending state and do not automatically spend
  model quota.

### 7. Multi-video claim lab

- Two or more selected video artifacts produce a claim/evidence matrix.
- Agreement, conflict, update, and unique-claim relations are represented.
- Every matrix cell links to source evidence or is explicitly marked missing.
- Results are saved as editable Markdown, not only shown in chat.

### 8. Cross-modal video memory

- Text, OCR, visual descriptors, titles, and claims share one local search
  interface.
- Search returns video, timestamp, evidence type, and keyframe where available.
- Filters cover author, platform, date, content type, and course.
- Suggested note relations require user review before Markdown links are added.

### 9. Learning loop

- Artifacts can contain flashcards, multiple-choice questions, and Feynman
  prompts.
- Answers and confidence are recorded locally.
- Wrong answers link back to source evidence.
- Review scheduling and mastery state survive reload.

### 10. Capture-anywhere and native Obsidian layer

- Protocol capture supports capture-only and capture-and-process actions.
- Capture-only works while the backend is offline.
- Duplicate source URLs update or reveal the existing pending item.
- A generated `.base` file provides Inbox, Processing, Ready, Error, and Review
  views over standard Properties.
- Raw transcript/evidence can be reprocessed without reacquiring the video.

## Final system acceptance

Completion requires all of the following:

1. TypeScript build, lint, targeted unit tests, and workflow contract tests pass.
2. Plugin source, built assets, and installed runtime copies match.
3. One YouTube URL, one Bilibili URL, one local fixture, one playlist, and one
   offline capture complete their applicable end-to-end paths.
4. Obsidian is reloaded and the real sidebar is inspected at narrow and wide
   widths.
5. Evidence seeking, highlight persistence, search, comparison, review, and
   reprocessing are exercised in the installed plugin.
6. No push or release is performed without separate user approval.
