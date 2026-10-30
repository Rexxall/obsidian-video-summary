/**
 * What a person sees when they open the workflow in n8n: node names that say what each step
 * does, one AI step instead of a copy for retries, a left-to-right layout by input kind and
 * sticky notes that explain each lane. Every function here is idempotent.
 */

import { NOTE_SYSTEM_MESSAGE, notePromptExpression } from './note-prompt.mjs';

export const WRITE_NOTE = 'AI: Write Note';

/** Old default or vague names, and what they are called now. */
export const RENAMED_NODES = {
  'AI Agent1': WRITE_NOTE,
  'CMD: Get Video Metadata1': 'CMD: Get Video Metadata',
  Merge: 'Merge: Result',
  Switch: 'Switch: Has Link?',
  'Set User Provided Transcript': 'Set: Pasted Transcript',
  'Set: Given Output': 'Set: Note from Request',
  'Respond to Webhook': 'Respond: Result',
  'Respond to Webhook: Test': 'Respond: Health Report',
  'Respond to Webhook: Cookies': 'Respond: Cookies Saved',
  'Stop and Error': 'Stop: No Link or Transcript',
  'Code: Parse AI JSON Output & Manage Retries': 'Code: Parse Note JSON',
  'Switch: AI Parse Retry?': 'Switch: Retry Note?',
  'Write Cookie File': 'File: Write Cookies',
  'Read Local Document': 'File: Read Local Document',
};

/** The retry copy of the AI step; retries now loop back to the one AI step. */
const RETRY_AGENT = 'AI Agent6';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteReferences(value, from, to) {
  if (typeof value === 'string') {
    const name = escapeRegExp(from);
    return value
      .replace(new RegExp(`\\$\\('${name}'\\)`, 'g'), `$('${to}')`)
      .replace(new RegExp(`\\$\\("${name}"\\)`, 'g'), `$("${to}")`)
      .replace(new RegExp(`\\$node\\["${name}"\\]`, 'g'), `$node["${to}"]`);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteReferences(item, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteReferences(item, from, to)]),
    );
  }
  return value;
}

function renameNode(workflow, from, to) {
  const node = workflow.nodes.find((candidate) => candidate.name === from);
  if (!node) return;
  node.name = to;
  for (const other of workflow.nodes) {
    other.parameters = rewriteReferences(other.parameters, from, to);
  }
  if (workflow.connections[from]) {
    workflow.connections[to] = workflow.connections[from];
    delete workflow.connections[from];
  }
  for (const kinds of Object.values(workflow.connections)) {
    for (const branches of Object.values(kinds)) {
      for (const branch of branches) {
        for (const edge of branch || []) if (edge.node === from) edge.node = to;
      }
    }
  }
}

function dropRetryAgent(workflow) {
  if (!workflow.nodes.some((node) => node.name === RETRY_AGENT)) return;
  workflow.nodes = workflow.nodes.filter((node) => node.name !== RETRY_AGENT);
  delete workflow.connections[RETRY_AGENT];
  for (const kinds of Object.values(workflow.connections)) {
    for (const branches of Object.values(kinds)) {
      for (let index = 0; index < branches.length; index += 1) {
        branches[index] = (branches[index] || []).filter((edge) => edge.node !== RETRY_AGENT);
      }
    }
  }
}

export function renameLegacyNodes(workflow) {
  for (const [from, to] of Object.entries(RENAMED_NODES)) renameNode(workflow, from, to);
  dropRetryAgent(workflow);
  return workflow;
}

function booleanRule(outputKey, leftValue, operation) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: `retry-${outputKey.toLowerCase()}`,
          leftValue,
          rightValue: '',
          operator: { type: 'boolean', operation, singleValue: true },
        },
      ],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey,
  };
}

/** One AI step: the parser decides whether to retry, and a retry goes back to the same step. */
export function applyNoteStep(workflow) {
  const agent = workflow.nodes.find((node) => node.name === WRITE_NOTE);
  if (!agent) throw new Error(`Workflow node not found: ${WRITE_NOTE}`);
  agent.parameters.text = notePromptExpression();
  // The reply is parsed by Code: Parse Note JSON, so the agent needs no output-parser slot.
  agent.parameters.hasOutputParser = false;
  agent.parameters.options = { ...agent.parameters.options, systemMessage: NOTE_SYSTEM_MESSAGE };

  const retry = workflow.nodes.find((node) => node.name === 'Switch: Retry Note?');
  retry.parameters = {
    rules: {
      values: [
        booleanRule('Done', '={{ $json.trigger_ai_retry }}', 'false'),
        booleanRule('Retry', '={{ $json.trigger_ai_retry }}', 'true'),
      ],
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'Failed' },
  };
  workflow.connections['Switch: Retry Note?'] = {
    main: [
      [{ node: 'Set: Summary', type: 'main', index: 0 }],
      [{ node: WRITE_NOTE, type: 'main', index: 0 }],
      [{ node: 'Set: Error Transcript', type: 'main', index: 0 }],
    ],
  };
}

/* ------------------------------------------------------------------------------- layout */

const X = (column) => -2860 + column * 240;

/** [x, y] per node: one lane per kind of request, the shared note-writing path on the right. */
const POSITIONS = {
  Webhook: [X(0), 760],
  'Code: Validate Video URL': [X(1), 760],
  'Switch: Input Type': [X(2), 760],

  'CMD: Health Probe': [X(4), -620],
  'Switch: Deep Check': [X(5), -620],
  'Health: Chat Models': [X(6), -700],
  'Health: Speech to Text': [X(7), -700],
  'Code: Health Report': [X(8), -620],
  'Respond: Health Report': [X(9), -620],

  'Code: Prepare Cookie File': [X(4), -300],
  'File: Write Cookies': [X(5), -300],
  'Respond: Cookies Saved': [X(6), -300],

  'Set: Local Audio File Path': [X(4), 60],
  'Switch: File Extension': [X(5), 60],
  'Code: Split Files': [X(6), -20],
  'File: Read Local Document': [X(7), -20],
  'Switch: Document Kind': [X(8), -20],
  'Extract PDF Text': [X(9), -100],
  'Merge: Documents': [X(10), -20],
  'Code: Prepare Document Request': [X(11), -20],
  'Switch: Needs Vision': [X(12), -20],
  'Vision: Read Images': [X(13), -100],
  'Set: Extracted Text': [X(14), -20],
  'SubFlow: Transcript from Local File': [X(6), 160],

  'Set: Pasted Transcript': [X(4), 420],
  'Set: Note from Request': [X(4), 580],

  'Set: Video Link from Input': [X(4), 820],
  'Switch: Info Only?': [X(5), 820],
  'Code: Detect Platform & Prepare Download': [X(6), 820],
  'CMD: Try Native Subtitles': [X(7), 820],
  'Code: Parse Native Subtitles': [X(8), 820],
  'Switch: Native Transcript Found': [X(9), 820],
  'CMD: Download Audio': [X(10), 940],
  'SubFlow: Transcript': [X(11), 940],

  'Switch: Has Link?': [X(4), 1180],
  'CMD: Get Video Metadata': [X(5), 1180],
  'Code: Parse Metadata': [X(6), 1180],
  'Set: Metadata': [X(7), 1180],

  'Stop: No Link or Transcript': [X(4), 1400],

  'Merge: Transcript Sources': [X(16), 420],
  'Set: Final Transcript for AI': [X(17), 420],
  'Switch: Operation Mode': [X(18), 420],
  [WRITE_NOTE]: [X(19) + 40, 300],
  'Model: Chat': [X(19) + 40, 520],
  'Code: Parse Note JSON': [X(20) + 160, 300],
  'Switch: Retry Note?': [X(21) + 160, 300],
  'Set: Summary': [X(22) + 160, 240],
  'Set: Error Transcript': [X(22) + 160, 440],
  'Merge: Result': [X(23) + 160, 420],
  'Respond: Result': [X(24) + 160, 420],
};

const STICKY_TYPE = 'n8n-nodes-base.stickyNote';

/** [name, x, y, width, height, color, content]. Color 7 is n8n's grey, 1 its yellow. */
const STICKIES = [
  [
    'Note: About this workflow',
    X(0) - 40,
    -820,
    700,
    520,
    1,
    [
      '## Video Summary backend',
      'The Obsidian plugin posts a link, a pasted transcript or a file name to the **Webhook**. This workflow gets a transcript, asks the model for a note and answers with JSON.',
      '',
      '- **Keys** live in the backend `.env`. The start script turns them into the credentials under **Overview → Credentials**; you do not paste keys here.',
      '- **Something failed?** Open **Executions** at the top and the latest run. A model or key problem still shows Success there: open **AI: Write Note** in that run, its output says what went wrong.',
      '- **Change the note style** in **AI: Write Note**. Updating the backend or changing keys imports the bundled workflow again, so keep your own version in `workflows/video-summary.json` in the backend folder.',
      '',
      'Obsidian 插件把链接、文稿或文件名发到 Webhook；这里取得文稿、让模型写笔记，再把 JSON 交回去。出错时点上方 Executions 打开最近一次运行，看 AI: Write Note 的输出。',
    ].join('\n'),
  ],
  [
    'Note: Health check',
    X(4) - 40,
    -800,
    1500,
    300,
    7,
    "## Health check\nThe plugin's **Full check** lands here. It reports tools, versions and, on a deep check, whether the model and speech keys work.",
  ],
  [
    'Note: Cookies',
    X(4) - 40,
    -440,
    780,
    250,
    7,
    '## Cookies\nSaves a cookies.txt the plugin sends (for Bilibili and other sites that need a login) into the backend `cookies/` folder.',
  ],
  [
    'Note: Local files',
    X(4) - 40,
    -180,
    3460,
    480,
    7,
    '## Local files\nFiles in the backend `uploads/` folder. Audio and video go to speech-to-text; PDFs are read as text; images go to the vision model.',
  ],
  [
    'Note: Pasted text',
    X(4) - 40,
    340,
    520,
    380,
    7,
    '## Pasted text\nA transcript pasted in Obsidian skips downloading. A finished note sent back for reprocessing skips the model too.',
  ],
  [
    'Note: Video link',
    X(4) - 40,
    740,
    2020,
    360,
    7,
    "## Video link\nTries the video's own subtitles first. Without subtitles it downloads the audio and sends it to speech-to-text.",
  ],
  [
    'Note: Video details',
    X(4) - 40,
    1100,
    1020,
    260,
    7,
    '## Video details\nTitle, author, length and cover from yt-dlp, added to the result.',
  ],
  [
    'Note: Write the note',
    X(16) - 40,
    140,
    2400,
    540,
    7,
    '## Write the note\n**AI: Write Note** holds the prompt. If its reply is not valid JSON, **Code: Parse Note JSON** asks it again, up to three times; a wrong key or model name stops at once with a message.',
  ],
];

export function applyCanvasLayout(workflow) {
  workflow.nodes = workflow.nodes.filter((node) => node.type !== STICKY_TYPE);
  for (const node of workflow.nodes) {
    const position = POSITIONS[node.name];
    if (!position) throw new Error(`No canvas position for node: ${node.name}`);
    node.position = position;
  }
  for (const [name, x, y, width, height, color, content] of STICKIES) {
    workflow.nodes.push({
      id: `sticky-${name
        .toLowerCase()
        .replace(/[^a-z]+/g, '-')
        .replace(/^-|-$/g, '')}`,
      name,
      type: STICKY_TYPE,
      typeVersion: 1,
      position: [x, y],
      parameters: { content, width, height, color },
    });
  }
  return workflow;
}
