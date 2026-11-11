/**
 * The prompt that turns a transcript into a note. One set of rules for every video, shaped by
 * content type, written in the language the plugin asks for.
 *
 * `buildNotePrompt` runs inside an n8n expression (`={{ (...)(...) }}`), so it must stay a
 * self-contained function: no imports, no template literals, no `}}` in its source.
 */

export const NOTE_PROMPT_MARKER = 'VIDEO_NOTE_PROMPT_V6';

export const NOTE_SYSTEM_MESSAGE = [
  'You turn video transcripts into notes for Obsidian.',
  'Write only what the transcript supports. When something is missing, say it is not in the video instead of filling the gap.',
  'Reply with one JSON object and nothing else.',
].join('\n');

export function buildNotePrompt(input) {
  const MARKER = 'VIDEO_NOTE_PROMPT_V6';
  const languages = {
    zh: {
      name: 'Simplified Chinese',
      summary: '摘要',
      missing: '视频里没有提到',
      example: '身体影响大脑',
      generic: '要点、核心概念、主要内容、总结',
    },
    en: {
      name: 'English',
      summary: 'Summary',
      missing: 'Not in the video',
      example: 'Body shapes the brain',
      generic: 'Key points, Main ideas, Summary',
    },
    ja: {
      name: 'Japanese',
      summary: '要約',
      missing: '動画では触れられていない',
      example: '体が脳を変える',
      generic: '要点、主な内容、まとめ',
    },
  };
  const lang = languages[input.language] || languages.zh;
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const contentType = metadata.content_type || 'auto';
  const assessAttention = metadata.attention_assessment !== false;
  const makeLearning = metadata.generate_learning === true;
  // The reader's own way of writing notes (a setting); it is followed over the defaults.
  const style = String(metadata.note_style || '')
    .trim()
    .slice(0, 4000);
  // Pictures of the video the note may place: the cover and a few frames.
  const images = (Array.isArray(metadata.note_images) ? metadata.note_images : [])
    .filter(function (image) {
      return image && typeof image.url === 'string' && /^https:\/\//.test(image.url);
    })
    .slice(0, 6);
  const segments = Array.isArray(input.segments)
    ? input.segments.filter(function (segment) {
        return segment && segment.id && segment.text;
      })
    : [];
  const transcript = String(input.transcript || '');
  const long = transcript.length > 12000;
  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }
  // With timed segments, each transcript line carries its id, so the text is sent once.
  const transcriptText = segments.length
    ? segments
        .map(function (segment) {
          const time = Number.isFinite(Number(segment.start))
            ? '[' + clock(segment.start) + '] '
            : '';
          return time + '(' + segment.id + ') ' + segment.text;
        })
        .join('\n')
    : transcript;

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
    segments.length
      ? 'Transcript (each line: time, segment id in parentheses, words):'
      : 'Transcript:',
    '---',
    transcriptText,
    '---',
    '',
    'NOTE SHAPE (the "note" field, Markdown for Obsidian). The reader rereads these notes in a personal knowledge base. They want to see the structure of the video at a glance and read little prose: diagrams, tables, lists and callouts carry the content; sentences are the glue.',
    '',
    'Step 1. Decide what the video mainly is; do not write this step down. A requested content type other than auto is a strong hint. argument: it argues a thesis. method: it teaches how to do something or gives strategies. breakdown: it analyses a work or a thing part by part. story: what happened to a person, company, event or idea over time. explainer: how something works or what it is. conversation: an interview or a discussion.',
    '',
    'Step 2. Write the note.',
    '- Top: "> [!summary] ' +
      lang.summary +
      '" with at most 2 sentences: what the video takes on and what it concludes. Never "this video introduces".',
    '- Then always one picture of the whole video as a Mermaid diagram in a ```mermaid block. argument: flowchart of how the claims lead to the conclusion. method: flowchart from the problem to its cause to the strategies. breakdown: mindmap of the parts. story: timeline of the stages. explainer: flowchart from the simplest idea up to the hardest. conversation: mindmap of topics with the person who spoke to each. 4 to 8 nodes. Use flowchart LR only for up to 5 nodes, otherwise flowchart TD. Every node label in double quotes, like A["' +
      lang.example +
      '"], at most 16 characters or 8 words, with no parentheses, colons or quotes inside; ids are plain ASCII.',
    "- Body: one ## section per part of that picture. Each heading names the actual content in the video's own terms, never a generic label like " +
      lang.generic +
      '. Under each heading: first one line in bold with the point of this part; then the content in the most visual form that fits: 2 to 5 short bullets, a table when three or more things share the same attributes, numbered steps for a procedure, a checklist for things to do. At most 2 sentences of prose per section. ' +
      (long ? '3 to 6' : '2 to 4') +
      ' sections.',
    '- By kind: method puts its strategies in one table (strategy, when to use it, what to do, why it works); explainer adds a table of key terms (term, one-line meaning, example from the video); conversation adds a table of topics with what each person said; story gives each stage its date or order when the video says it.',
    '- End, only what the video gives: things to do as "- [ ]" items, and 1 to 3 quotes worth keeping, verbatim in the transcript\'s language with their time. Leave out what the video does not give; never write a section only to fill a slot.',
    '',
    'RULES',
    '- Leave out logistics and housekeeping: schedules, exam dates, credits, sponsors, greetings, calls to subscribe, jokes that carry no idea.',
    '- Say each idea once; the summary and the body do not repeat each other.',
    "- Bold the key terms; when the note is in another language than the video, give a term's original form in parentheses.",
    '- Write 3 to 6 central concepts as [[wiki links]] the first time they appear (links to notes the reader does not have are turned back into text).',
    '- Put the time like [12:34] after the bullet or line it supports, when the transcript has times.',
    '- Put a space between Chinese or Japanese text and Latin words or numbers. Formulas in $...$; code in fenced blocks with the language named.',
    '- Length: at most about ' +
      (long
        ? '1,500 Chinese or Japanese characters (900 English words)'
        : '800 Chinese or Japanese characters (500 English words)') +
      ' of text; diagrams and tables are not counted.',
    "- The workflow does not receive video frames. Describe scenes, slides, code on screen or music only when the speaker describes them, and say that it is the speaker's description.",
    '- Write "' + lang.missing + '" only where a fact the reader would expect is not in the video.',
  ];
  if (images.length) {
    lines.push(
      '',
      'PICTURES you may place where they fit (at most one per section; the first is the cover). Write each as ![caption](url):',
    );
    images.forEach(function (image) {
      lines.push('- ' + image.url + (image.label ? ' (' + image.label + ')' : ''));
    });
  }
  if (style) {
    lines.push('', "WRITING STYLE (the reader's own; follow it over the defaults above):", style);
  }
  lines.push(
    '',
    'JSON FIELDS',
    '- video_title: a clear title, at most 15 Chinese/Japanese characters or 8 English words, no special symbols.',
    '- note_title: a readable title for the note in ' +
      lang.name +
      ', at most 20 Chinese/Japanese characters or 10 English words, naming what the video teaches or argues rather than the channel or episode number. It may differ from video_title.',
    '- tldr: one sentence in ' +
      lang.name +
      ' with the main takeaway, written fresh: do not copy or cut a sentence from the transcript or the summary, and do not end with an ellipsis.',
    '- summary: one or two sentences for a list view.',
    '- note: the Markdown note above, as one JSON string (escape newlines as \\n and quotes as \\").',
    '- content_type: course, interview, tutorial, news, meeting, review or general; it matches the shape of the note.',
    '- evidence_claims: up to 8 checkable statements: {"id":"claim-1","claim":"...","evidence":[{"segment_id":"an id in parentheses from the transcript","source":"speech","quote":"the exact words"}],"start":seconds or null,"end":seconds or null,"confidence":0 to 1,"review_state":"supported, needs-review or inference"}. Use only those ids; when the transcript has none, return []. A quote is copied from the transcript in its own language, never translated; the claim is in the language of the note.',
  );
  if (assessAttention) {
    lines.push(
      '- attention: {"action":"watch, skim or skip","score":0 to 1,"confidence":0 to 1,"rationale":"one sentence","information_density":0 to 1,"originality":0 to 1,"actionability":0 to 1,"promotional_ratio":0 to 1,"evidence_segment_ids":[],"limitations":[]}.',
    );
  }
  if (makeLearning) {
    lines.push(
      '- learning: {"flashcards":[{"front":"...","back":"...","evidence_segment_ids":[]}],"questions":[],"feynman_prompts":[]}, 3 to 8 cards, ids only from the transcript.',
    );
  }
  lines.push(
    '',
    'Times: never invent 0:00 or start=0 when there is no time; use null.',
    'A statement inferred from the transcript but not said in it gets review_state inference or needs-review.',
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
