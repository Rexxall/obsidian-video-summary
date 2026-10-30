/**
 * The prompt that turns a transcript into a note. One set of rules for every video, shaped by
 * content type, written in the language the plugin asks for.
 *
 * `buildNotePrompt` runs inside an n8n expression (`={{ (...)(...) }}`), so it must stay a
 * self-contained function: no imports, no template literals, no `}}` in its source.
 */

export const NOTE_PROMPT_MARKER = 'VIDEO_NOTE_PROMPT_V4';

export const NOTE_SYSTEM_MESSAGE = [
  'You turn video transcripts into notes for Obsidian.',
  'Write only what the transcript supports. When something is missing, say it is not in the video instead of filling the gap.',
  'Reply with one JSON object and nothing else.',
].join('\n');

export function buildNotePrompt(input) {
  const MARKER = 'VIDEO_NOTE_PROMPT_V4';
  const languages = {
    zh: {
      name: 'Simplified Chinese',
      summary: '摘要',
      points: '要点',
      details: '展开细节',
      missing: '视频里没有提到',
    },
    en: {
      name: 'English',
      summary: 'Summary',
      points: 'Key points',
      details: 'More detail',
      missing: 'Not in the video',
    },
    ja: {
      name: 'Japanese',
      summary: '要約',
      points: '要点',
      details: '詳しく',
      missing: '動画では触れられていない',
    },
  };
  const lang = languages[input.language] || languages.zh;
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const contentType = metadata.content_type || 'auto';
  const assessAttention = metadata.attention_assessment !== false;
  const makeLearning = metadata.generate_learning === true;
  const segments = Array.isArray(input.segments)
    ? input.segments.map(function (segment) {
        return {
          id: segment.id,
          start: segment.start,
          end: segment.end,
          text: segment.text,
          source: segment.source || 'speech',
        };
      })
    : [];
  const transcript = String(input.transcript || '');
  const long = transcript.length > 12000;

  const lines = [
    '// ' + MARKER,
    'Write a note about this video in ' +
      lang.name +
      '. Every heading, callout title and table header is in ' +
      lang.name +
      ' too.',
    '',
    'Title: ' + (input.title || '(none)'),
    'Author: ' + (input.author || '(none)'),
    'Requested content type: ' + contentType,
    '',
    'Transcript:',
    '---',
    transcript,
    '---',
    '',
    'NOTE SHAPE (the "note" field, Markdown)',
    '1. Start with "> [!summary] ' +
      lang.summary +
      '": 2 to 4 sentences saying what the video is about and what it concludes.',
    '2. Then "## ' +
      lang.points +
      '": ' +
      (long ? '6 to 10' : '4 to 6') +
      ' bullets, one line each, the points a viewer should remember. Start a bullet with its time, like [12:34], when the transcript has times.',
    '3. Then the sections for the content type below, as ## headings with short bullets or a table. Put long explanations, quotes and worked examples inside folded callouts ("> [!note]- ' +
      lang.details +
      '"); keep blank lines inside a callout as ">".',
    '4. Do not retell the transcript. The plugin adds the full timestamped transcript under the note, so the note keeps only what is worth rereading. Aim for ' +
      (long
        ? 'about 1,200 words (2,000 Chinese or Japanese characters) at most'
        : 'about a quarter of the transcript length') +
      '.',
    '5. Use a table when comparing three or more things. Use ==highlight== for at most five key terms. Put a space between Chinese or Japanese text and Latin words or numbers.',
    '',
    'CONTENT TYPES. If the requested type is not auto, use it. Otherwise pick one from the title and transcript; use general when unsure.',
    '- course: learning goals, key concepts (term and meaning), walkthrough, questions to check understanding. A language lesson also gets a vocabulary table: word, reading, meaning, example sentence from the video.',
    '- interview: who is talking and why, topics, views by speaker, key questions and answers, open questions. A question from the host is not a claim by the guest.',
    '- tutorial: goal and prerequisites, setup, numbered steps (commands in code blocks), how to check it worked and fix problems. Do not add steps the video does not show.',
    '- news: what happened, timeline, who is involved and their sources, what is confirmed versus claimed versus unknown, what comes next.',
    '- meeting: context, decisions, action items (item, owner, due, status), discussion, open issues.',
    '- review: what was tested and how, facts about the product, strengths, weaknesses and trade-offs, who it suits.',
    '- general: overview, main points, evidence and limits, takeaways.',
    "The workflow does not receive video frames. Describe scenes, slides, code on screen or music only when the speaker describes them, and say that it is the speaker's description.",
    'Write "' + lang.missing + '" where a section has nothing to go on.',
    '',
    'JSON FIELDS',
    '- video_title: a clear title, at most 15 Chinese/Japanese characters or 8 English words, no special symbols.',
    '- summary: one or two sentences for a list view.',
    '- note: the Markdown note above, as one JSON string (escape newlines as \\n and quotes as \\").',
    '- content_type: course, interview, tutorial, news, meeting, review or general; it matches the shape of the note.',
    '- evidence_claims: up to 8 checkable statements: {"id":"claim-1","claim":"...","evidence":[{"segment_id":"an id from the list below","source":"speech","quote":"the exact words"}],"start":seconds or null,"end":seconds or null,"confidence":0 to 1,"review_state":"supported, needs-review or inference"}. Use only segment ids from the list; with no list, return [].',
  ];
  if (assessAttention) {
    lines.push(
      '- attention: {"action":"watch, skim or skip","score":0 to 1,"confidence":0 to 1,"rationale":"one sentence","information_density":0 to 1,"originality":0 to 1,"actionability":0 to 1,"promotional_ratio":0 to 1,"evidence_segment_ids":[],"limitations":[]}.',
    );
  }
  if (makeLearning) {
    lines.push(
      '- learning: {"flashcards":[{"front":"...","back":"...","evidence_segment_ids":[]}],"questions":[],"feynman_prompts":[]}, 3 to 8 cards, ids only from the list.',
    );
  }
  lines.push(
    '',
    'Times: never invent 0:00 or start=0 when there is no time; use null.',
    'A statement inferred from the transcript but not said in it gets review_state inference or needs-review.',
    '',
    'Segments you may cite (speech, not images):',
    JSON.stringify(segments),
  );
  if (Number(input.retryCount) > 0 && input.parseError) {
    lines.push(
      '',
      'Your previous reply could not be parsed: ' + String(input.parseError).slice(0, 300),
      'Reply again with valid JSON only: no code fence, no text before or after, newlines inside strings escaped.',
    );
  }
  return lines.join('\n');
}

/** The AI step's prompt field: an n8n expression that calls buildNotePrompt with live values. */
export function notePromptExpression() {
  const source = buildNotePrompt.toString().replace(/\}\}/g, '} }');
  return [
    '={{ (',
    source,
    ')({',
    "  transcript: $('Set: Final Transcript for AI').item.json.video_transcript,",
    "  segments: $('Set: Final Transcript for AI').item.json.video_segments,",
    "  title: $json.video_title || $('Set: Final Transcript for AI').item.json.video_title,",
    "  author: $json.video_author || $('Set: Final Transcript for AI').item.json.video_author,",
    "  language: $('Webhook').item.json.body.metadata.language,",
    "  metadata: $('Webhook').item.json.body.metadata,",
    '  retryCount: $json.ai_retry_count,',
    '  parseError: $json.parsing_error_details,',
    '}) }}',
  ].join('\n');
}
