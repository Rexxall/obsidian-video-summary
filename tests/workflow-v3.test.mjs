import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import {
  DEFAULT_WORKFLOW_PATH,
  NOTE_PROMPT_MARKER,
  MEDIA_RUNNER_PROGRAM,
  PUBLIC_WORKFLOW_VERSION,
  VIDEO_URL_SECURITY_MARKER,
  executeNodeCode,
  runSplitLocalFilesNode,
  runValidateVideoUrlNode,
  upgradeWorkflow,
  validateWorkflow,
} from '../tools/upgrade-workflow-v3.mjs';
import { CREDENTIALS, WORKFLOW_IDS, buildSpeechWorkflow } from '../tools/backend-workflow.mjs';
import { buildNotePrompt } from '../tools/note-prompt.mjs';

function loadWorkflow() {
  return JSON.parse(readFileSync(DEFAULT_WORKFLOW_PATH, 'utf8'));
}

function nodeCode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node.parameters.jsCode;
}

/** Evaluate the AI step's `={{ ... }}` prompt the way n8n does, with stand-ins for $ and $json. */
function evaluatePromptExpression(text, { transcript, language, metadata = {}, json = {} }) {
  assert.ok(
    text.startsWith('={{') && text.trimEnd().endsWith('}}'),
    'prompt is one n8n expression',
  );
  const body = text.trim().slice(3, -2);
  const nodes = {
    'Set: Final Transcript for AI': { video_transcript: transcript, video_segments: [] },
    Webhook: { body: { metadata: { ...metadata, language } } },
  };
  const $ = (name) => ({ item: { json: nodes[name] || {} } });
  return vm.runInNewContext(body, { $, $json: json, JSON, String, Number, Array, Object });
}

test('workflow upgrade is idempotent and passes structural validation', () => {
  const workflow = loadWorkflow();
  const once = upgradeWorkflow(workflow);
  const twice = upgradeWorkflow(once);

  assert.deepEqual(once, workflow, 'Run tools/upgrade-workflow-v3.mjs');
  assert.deepEqual(twice, once);
  assert.deepEqual(validateWorkflow(workflow), []);
});

test('public workflow security revision is consistently versioned', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  assert.equal(PUBLIC_WORKFLOW_VERSION, '3.1.0');
  assert.equal(workflow.version, PUBLIC_WORKFLOW_VERSION);
  assert.equal(workflow.meta.videoSummaryWorkflow.version, PUBLIC_WORKFLOW_VERSION);
  assert.match(nodeCode(workflow, 'Code: Health Report'), /"version":"3\.1\.0"/);
});

test('public workflow does not embed a private user profile', () => {
  const serialized = JSON.stringify(upgradeWorkflow(loadWorkflow()));
  assert.doesNotMatch(serialized, /\*\*用户画像\*\*/);
  assert.doesNotMatch(serialized, /针对[^\n]{0,80}定制/);
  assert.doesNotMatch(serialized, /我的背景契合度/);
  assert.doesNotMatch(serialized, /结合[^\n|]{0,80}背景分析/);
  assert.doesNotMatch(
    serialized,
    /申请状态::|教育申请|光遗传学|内诺|第二大脑数字管家|导师特征分析/,
  );
});

test('the AI prompt is evaluated, not sent as source code, and follows the request language', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const agents = workflow.nodes.filter((node) => /\.agent$/.test(node.type));
  assert.deepEqual(
    agents.map((node) => node.name),
    ['AI: Write Note'],
  );
  const text = agents[0].parameters.text;
  const headings = { zh: '> [!summary] 摘要', en: '> [!summary] Summary', ja: '> [!summary] 要約' };
  for (const [language, heading] of Object.entries(headings)) {
    const prompt = evaluatePromptExpression(text, { transcript: '[00:01] hello', language });
    assert.equal(typeof prompt, 'string');
    assert.match(prompt, new RegExp(NOTE_PROMPT_MARKER));
    assert.ok(prompt.includes('[00:01] hello'), language);
    assert.ok(prompt.includes(heading), language);
    assert.doesNotMatch(
      prompt,
      /\$\{|\bconst \w+ =|return userPrompt/,
      'no unevaluated JavaScript reaches the model',
    );
  }
  assert.doesNotMatch(text, /核心摘要|95%/);
});

test('the prompt asks for a summary and key points, not a retelling', () => {
  const short = buildNotePrompt({ transcript: 'x'.repeat(2000), language: 'en' });
  const long = buildNotePrompt({ transcript: 'x'.repeat(60000), language: 'en' });
  assert.match(short, /4 to 6 bullets/);
  assert.match(long, /6 to 10 bullets/);
  assert.match(long, /about 1,200 words/);
  assert.match(long, /Do not retell the transcript/);
  const retry = buildNotePrompt({ transcript: 'x', retryCount: 1, parseError: 'Unexpected token' });
  assert.match(retry, /could not be parsed: Unexpected token/);
  const learning = buildNotePrompt({ transcript: 'x', metadata: { generate_learning: true } });
  assert.match(learning, /- learning:/);
  assert.doesNotMatch(buildNotePrompt({ transcript: 'x' }), /- learning:/);
});

test('the prompt carries every content type and the no-frames limit', () => {
  const prompt = buildNotePrompt({ transcript: 'x', language: 'zh' });
  for (const route of ['course', 'interview', 'tutorial', 'news', 'meeting', 'review', 'general']) {
    assert.match(prompt, new RegExp(`- ${route}: `), route);
  }
  assert.match(prompt, /does not receive video frames/);
});

test('nodes have descriptive names, one AI step, and sticky notes explain each lane', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const names = workflow.nodes.map((node) => node.name);
  for (const name of names) {
    assert.doesNotMatch(
      name,
      /^(AI Agent\d*|Merge|Switch|Respond to Webhook|Stop and Error)$|\D1$/,
      name,
    );
  }
  assert.ok(
    workflow.connections['Switch: Retry Note?'].main[1].some(
      (edge) => edge.node === 'AI: Write Note',
    ),
    'a failed parse retries the same AI step',
  );
  const stickies = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.stickyNote');
  assert.ok(stickies.length >= 6);
  assert.match(stickies[0].parameters.content, /Executions/);
  for (const node of workflow.nodes) assert.equal(node.position.length, 2, node.name);
});

test('transcript subflows call the bundled speech-to-text workflow', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  for (const name of [
    'SubFlow: Transcript',
    'SubFlow: Transcript from Local File',
    'Health: Speech to Text',
  ]) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    assert.ok(node, `Missing node: ${name}`);
    assert.equal(node.parameters.workflowId.value, WORKFLOW_IDS.speech);
    assert.equal(node.parameters.workflowId.mode, 'id');
  }
  assert.equal(buildSpeechWorkflow().id, WORKFLOW_IDS.speech);
});

test('incoming video URLs require HTTPS and an exact supported hostname', () => {
  for (const link of [
    'https://www.youtube.com/watch?v=abc123',
    'https://youtu.be/abc123',
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://b23.tv/example',
    'https://v.douyin.com/example/',
    'https://vm.tiktok.com/example/',
    'https://www.xiaohongshu.com/explore/64abcdef0123456789abcdef',
  ]) {
    const [item] = runValidateVideoUrlNode({
      all: () => [{ json: { body: { metadata: { link } } } }],
    });
    assert.match(item.json.validated_video_url, /^https:\/\//);
    assert.match(item.json.video_url_token, /^[A-Za-z0-9_-]+$/);
    assert.equal(
      Buffer.from(item.json.video_url_token, 'base64url').toString('utf8'),
      item.json.validated_video_url,
    );
  }

  for (const link of [
    'http://www.youtube.com/watch?v=abc123',
    'https://youtube.com.evil.example/watch?v=abc123',
    'https://user:password@www.youtube.com/watch?v=abc123',
    'https://www.youtube.com:8443/watch?v=abc123',
    'https://127.0.0.1/video',
    'file:///etc/passwd',
    ' https://www.youtube.com/watch?v=abc123',
    'https://www.youtube.com/watch?v=abc123\n',
    'https://www.youtube.com/watch?v=abc123\0ignored',
    'https://www.youtube.com/redirect?q=https://127.0.0.1/',
    'https://www.bilibili.com/account/history',
    'https://www.douyin.com/user/example',
    'https://www.tiktok.com/login',
    'https://www.xiaohongshu.com/user/profile/example',
  ]) {
    assert.throws(
      () =>
        runValidateVideoUrlNode({
          all: () => [
            {
              json: { body: { metadata: { link } } },
            },
          ],
        }),
      /Video URL|YouTube|Bilibili|Douyin|TikTok|Xiaohongshu/,
      link,
    );
  }
});

test('download commands contain only a URL token and fixed runner arguments', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  assert.throws(
    () =>
      executeNodeCode(nodeCode(workflow, 'Code: Detect Platform & Prepare Download'), [
        {
          json: {
            video_link: 'https://www.youtube.com/watch?v=$(touch%20/tmp/video-summary-pwned)',
          },
        },
      ]),
    /video id/,
  );
  const [item] = executeNodeCode(nodeCode(workflow, 'Code: Detect Platform & Prepare Download'), [
    { json: { video_link: 'https://www.youtube.com/watch?v=abc123' } },
  ]);

  assert.match(item.json.video_url_token, /^[A-Za-z0-9_-]+$/);
  assert.match(item.json.ytdlp_command, /^node -e /);
  assert.match(item.json.native_subtitle_command, /^node -e /);
  assert.doesNotMatch(item.json.ytdlp_command, /video-summary-pwned/);
  assert.doesNotMatch(item.json.native_subtitle_command, /video-summary-pwned/);
  assert.doesNotMatch(item.json.ytdlp_command, /--no-check-certificate/);
  assert.match(item.json.ytdlp_command, /spawnSync/);
  assert.doesNotThrow(() => new vm.Script(`(async function () {\n${MEDIA_RUNNER_PROGRAM}\n})`));
});

test('every AI step shares one model and only packaged credentials are referenced', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const webhook = workflow.nodes.find((candidate) => candidate.name === 'Webhook');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.credentials.httpHeaderAuth.id, CREDENTIALS.webhook.id);

  const models = workflow.nodes.filter((node) => /\.lmChat/.test(node.type));
  assert.deepEqual(
    models.map((node) => node.name),
    ['Model: Chat'],
  );
  assert.deepEqual(
    workflow.connections['Model: Chat'].ai_languageModel[0].map((edge) => edge.node).sort(),
    ['AI: Write Note'],
  );
  assert.equal(models[0].parameters.model.value, '__VS_CHAT_MODEL__');
  assert.ok(
    !workflow.nodes.some((node) => /googleGemini|Gemini/i.test(`${node.type} ${node.name}`)),
  );

  const known = new Set(Object.values(CREDENTIALS).map((credential) => credential.id));
  for (const flow of [workflow, buildSpeechWorkflow()]) {
    for (const node of flow.nodes) {
      for (const reference of Object.values(node.credentials || {})) {
        assert.ok(known.has(reference.id), `${node.name} uses ${reference.id}`);
      }
    }
    const serialized = JSON.stringify(flow);
    assert.doesNotMatch(serialized, /YOUR_GEMINI_API_KEY|[?&]key=|sk-[A-Za-z0-9]{8}/i);
  }

  // Every node except the triggers and the model is reachable.
  const targets = new Set();
  for (const kinds of Object.values(workflow.connections)) {
    for (const branches of Object.values(kinds)) {
      for (const branch of branches) for (const edge of branch || []) targets.add(edge.node);
    }
  }
  const orphans = workflow.nodes
    .filter((node) => node.type !== 'n8n-nodes-base.stickyNote')
    .filter((node) => !targets.has(node.name) && !['Webhook', 'Model: Chat'].includes(node.name))
    .map((node) => node.name);
  assert.deepEqual(orphans, []);
});

test('model errors that retrying cannot fix end the run with an actionable message', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const [item] = executeNodeCode(
    nodeCode(workflow, 'Code: Parse Note JSON'),
    [{ json: { error: 'Authorization failed - please check your credentials' } }],
    { 'Set: Final Transcript for AI': { video_transcript: 'x' } },
  );
  assert.equal(item.json.trigger_ai_retry, false);
  assert.match(item.json.output.summary, /VS_CHAT_API_KEY/);
});

test('workflow command nodes never interpolate the raw webhook link', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const validationNode = workflow.nodes.find(
    (candidate) => candidate.name === 'Code: Validate Video URL',
  );
  assert.ok(validationNode);
  assert.match(validationNode.parameters.jsCode, new RegExp(VIDEO_URL_SECURITY_MARKER));

  const commandNodes = workflow.nodes.filter(
    (candidate) => candidate.type === 'n8n-nodes-base.executeCommand',
  );
  for (const node of commandNodes) {
    const command = String(node.parameters.command || '');
    assert.doesNotMatch(command, /metadata\.link/, node.name);
    assert.doesNotMatch(command, /--no-check-certificate/, node.name);
  }

  const metadataNode = workflow.nodes.find(
    (candidate) => candidate.name === 'CMD: Get Video Metadata',
  );
  assert.match(metadataNode.parameters.command, /\$json\.video_url_token/);
  assert.match(metadataNode.parameters.command, /spawnSync/);
});

test('bundled n8n is pinned and published on localhost only', () => {
  const dockerfile = readFileSync(new URL('../backend/Dockerfile', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../backend/compose.yaml', import.meta.url), 'utf8');

  assert.match(dockerfile, /^ARG N8N_VERSION=2\.43\.8$/m);
  assert.match(dockerfile, /^ARG YT_DLP_VERSION=2026\.10\.26$/m);
  assert.match(compose, /'127\.0\.0\.1:\$\{VS_PORT:-5678\}:5678'/);
  assert.match(compose, /NODES_EXCLUDE=\["n8n-nodes-base\.localFileTrigger"\]/);
  assert.match(compose, /\.\/\.env:\/run\/video-summary\/config\.env:ro/);
  assert.doesNotMatch(compose, /env_file/);
  assert.doesNotMatch(compose, /^\s*- ['"]?5678:5678['"]?\s*$/m);
  assert.match(
    compose,
    /N8N_RESTRICT_FILE_ACCESS_TO=\/home\/node\/uploads;\/home\/node\/files;\/home\/node\/cookies/,
  );
  assert.match(compose, /N8N_BLOCK_ENV_ACCESS_IN_NODE=true/);
  assert.match(compose, /N8N_DIAGNOSTICS_ENABLED=false/);
});

test('local-file workflow paths remain inside the mounted uploads directory', () => {
  const valid = runSplitLocalFilesNode({
    all: () => [
      {
        json: {
          body: {
            metadata: {
              local_file: '课程 01.mp4, interview.mp3',
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(
    valid.map((item) => item.json.audio_file_path_for_subflow),
    ['/home/node/uploads/课程 01.mp4', '/home/node/uploads/interview.mp3'],
  );

  for (const localFile of [
    '/etc/passwd',
    '../cookies/token.txt',
    'course/../../cookies/token.txt',
    'C:\\Users\\example\\video.mp4',
    'course//video.mp4',
    'course/notes.txt',
    'course/video.mp3\0ignored',
    '$(touch hacked).mp3',
    '`touch hacked`.mp3',
    'quote"name.mp3',
    "quote'name.mp3",
    'semi;colon.mp3',
    'amp&ersand.mp3',
    'pipe|name.mp3',
  ]) {
    assert.throws(
      () =>
        runSplitLocalFilesNode({
          all: () => [
            {
              json: {
                body: { metadata: { local_file: localFile } },
              },
            },
          ],
        }),
      /backend uploads folder/,
      localFile,
    );
  }

  const workflow = upgradeWorkflow(loadWorkflow());
  const pathNode = workflow.nodes.find(
    (candidate) => candidate.name === 'Set: Local Audio File Path',
  );
  const assignment = pathNode.parameters.assignments.assignments.find(
    (candidate) => candidate.name === 'audio_file_path_for_subflow',
  );
  const expression = assignment.value.slice(3, -2).trim();
  const evaluate = (localFile) =>
    vm.runInThisContext(`(function ($json) { return (${expression}); })`)({
      body: { metadata: { local_file: localFile } },
    });
  assert.equal(evaluate('课程 01.mp4'), '/home/node/uploads/课程 01.mp4');
  assert.throws(() => evaluate('../cookies/token.txt'), /backend uploads folder/);
  assert.throws(() => evaluate('/etc/passwd'), /backend uploads folder/);
  assert.throws(() => evaluate('$(touch hacked).mp3'), /backend uploads folder/);
  assert.throws(() => evaluate('`touch hacked`.mp3'), /backend uploads folder/);
  assert.throws(() => evaluate('quote"name.mp3'), /backend uploads folder/);
  assert.throws(() => evaluate('semi;colon.mp3'), /backend uploads folder/);
  assert.throws(() => evaluate('amp&ersand.mp3'), /backend uploads folder/);
  assert.throws(() => evaluate('pipe|name.mp3'), /backend uploads folder/);
});

test('rich Set node expressions evaluate with representative context', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const finalContext = {
    video_transcript: '[00:01] source words',
    video_segments: [{ id: 'seg-1', start: 1, text: 'source words' }],
    timing_quality: 'exact',
    transcript_source: 'native_subtitle',
  };
  const $json = {
    ...finalContext,
    output: {
      summary: 'Summary',
      note: 'Note',
      content_type: 'course',
      evidence_claims: [],
      attention: { action: 'watch', rationale: 'Useful' },
      learning: { feynman_prompts: ['Explain it'] },
    },
  };
  const $ = (name) => ({
    item: {
      json: name === 'Set: Final Transcript for AI' ? finalContext : {},
    },
  });

  for (const name of ['Set: Final Transcript for AI', 'Set: Summary']) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    assert.ok(node, `Missing node: ${name}`);
    for (const assignment of node.parameters.assignments.assignments) {
      assert.match(assignment.value, /^=\{\{[\s\S]*\}\}$/);
      const expression = assignment.value.slice(3, -2).trim();
      assert.doesNotThrow(
        () => vm.runInThisContext(`(function ($json, $) { return (${expression}); })`)($json, $),
        `${name}.${assignment.name}`,
      );
    }
  }
});

test('native SRT produces exact speech segments and labelled transcript', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const input = [
    {
      json: {
        stdout: [
          '__NATIVE_SUBTITLE_LANGS__=zh-CN',
          '__NATIVE_SUBTITLE_FILE__=/tmp/example.zh-CN.srt',
          '1',
          '00:00:01,250 --> 00:00:03,500',
          '<i>第一句证据</i>',
          '',
          '2',
          '00:00:04,000 --> 00:00:06,125',
          '第二句',
          '跨行证据',
        ].join('\n'),
      },
    },
  ];

  const result = executeNodeCode(nodeCode(workflow, 'Code: Parse Native Subtitles'), input, {
    'Code: Detect Platform & Prepare Download': {
      video_link: 'https://example.com/video',
    },
  })[0].json;

  assert.equal(result.transcript_source, 'native_subtitle');
  assert.equal(result.timing_quality, 'exact');
  assert.equal(result.video_segments.length, 2);
  assert.deepEqual(result.video_segments[0], {
    id: result.video_segments[0].id,
    start: 1.25,
    end: 3.5,
    text: '第一句证据',
    source: 'speech',
    timing_quality: 'exact',
  });
  assert.match(result.video_segments[0].id, /^seg-1250-/);
  assert.equal(result.video_transcript, '[00:01] 第一句证据\n[00:04] 第二句 跨行证据');
});

test('native WEBVTT accepts cue identifiers and timestamp settings', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const input = [
    {
      json: {
        stdout: [
          '__NATIVE_SUBTITLE_FILE__=/tmp/example.vtt',
          'WEBVTT',
          '',
          'intro-cue',
          '00:01.000 --> 00:03.200 align:start position:0%',
          '<v Speaker>hello &amp; welcome</v>',
          '',
          '00:00:04.000 --> 00:00:05.000',
          'second cue',
        ].join('\n'),
      },
    },
  ];

  const result = executeNodeCode(nodeCode(workflow, 'Code: Parse Native Subtitles'), input)[0].json;

  assert.equal(result.video_segments.length, 2);
  assert.equal(result.video_segments[0].start, 1);
  assert.equal(result.video_segments[0].end, 3.2);
  assert.equal(result.video_segments[0].text, 'hello & welcome');
  assert.equal(result.video_segments[1].start, 4);
});

test('untimed native text falls back without fabricating a zero timestamp', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const input = [
    {
      json: {
        stdout: [
          '__NATIVE_SUBTITLE_FILE__=/tmp/not-a-subtitle.txt',
          'plain untimed text',
          'still no cue timing',
        ].join('\n'),
      },
    },
  ];

  const result = executeNodeCode(nodeCode(workflow, 'Code: Parse Native Subtitles'), input)[0].json;

  assert.equal(result.transcript_source, 'asr_fallback');
  assert.equal(result.timing_quality, 'none');
  assert.deepEqual(result.video_segments, []);
  assert.equal(result.video_transcript, '');
  assert.doesNotMatch(JSON.stringify(result), /\[(?:0+:)?00:00\]/);
});

test('both AI parsers preserve rich output and restore transcript evidence context', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const richOutput = {
    video_title: 'Evidence test',
    summary: 'Summary',
    note: 'Note',
    content_type: 'course',
    evidence_claims: [
      {
        id: 'claim-1',
        claim: 'A supported claim',
        evidence: [
          {
            segment_id: 'seg-1000-test',
            source: 'speech',
            quote: 'source words',
          },
        ],
      },
    ],
    attention: {
      action: 'watch',
      rationale: 'Dense material',
      evidence_segment_ids: ['seg-1000-test'],
    },
    learning: {
      feynman_prompts: ['Explain the claim'],
    },
  };
  const transcriptContext = {
    video_transcript: '[00:01] source words',
    video_segments: [
      {
        id: 'seg-1000-test',
        start: 1,
        end: 2,
        text: 'source words',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    timing_quality: 'exact',
    transcript_source: 'native_subtitle',
  };

  for (const parserName of ['Code: Parse Note JSON']) {
    const result = executeNodeCode(
      nodeCode(workflow, parserName),
      [{ json: { output: JSON.stringify(richOutput) } }],
      { 'Set: Final Transcript for AI': transcriptContext },
    )[0].json;

    assert.deepEqual(result.output, richOutput, parserName);
    assert.deepEqual(result.video_segments, transcriptContext.video_segments);
    assert.equal(result.video_transcript, transcriptContext.video_transcript);
    assert.equal(result.timing_quality, 'exact');
    assert.equal(result.transcript_source, 'native_subtitle');
    assert.equal(result.trigger_ai_retry, false);
  }
});

test('AI parse failure retains evidence context for retry', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const transcriptContext = {
    video_transcript: '[00:07] retained evidence',
    video_segments: [
      {
        id: 'seg-7000-test',
        start: 7,
        end: 8,
        text: 'retained evidence',
        source: 'speech',
        timing_quality: 'exact',
      },
    ],
    timing_quality: 'exact',
    transcript_source: 'native_subtitle',
  };
  const result = executeNodeCode(
    nodeCode(workflow, 'Code: Parse Note JSON'),
    [{ json: { output: '{broken json' } }],
    { 'Set: Final Transcript for AI': transcriptContext },
  )[0].json;

  assert.equal(result.trigger_ai_retry, true);
  assert.equal(result.ai_retry_count, 1);
  assert.deepEqual(result.video_segments, transcriptContext.video_segments);
  assert.equal(result.video_transcript, transcriptContext.video_transcript);
  assert.match(result.parsing_error_details, /JSON解析失败/);
});

test('Code nodes that parse links work without a URL global, as in the n8n 2.x sandbox', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  const compose = readFileSync(new URL('../backend/compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /NODE_FUNCTION_ALLOW_BUILTIN=url$/m);
  for (const name of ['Code: Validate Video URL', 'Code: Detect Platform & Prepare Download']) {
    const code = nodeCode(workflow, name);
    assert.ok(code.startsWith("const URL = globalThis.URL || require('url').URL;"), name);
    // Same sandbox shape as the n8n task runner: no URL, but require('url') is allowed.
    const sandbox = { require: (id) => (id === 'url' ? { URL } : assert.fail(id)), Buffer };
    const run = vm.runInNewContext(`(function ($input) {\n${code}\n})`, sandbox);
    if (name === 'Code: Validate Video URL') {
      const [item] = run({
        all: () => [
          { json: { body: { metadata: { link: 'https://www.bilibili.com/video/BV1uv411q7Mv' } } } },
        ],
      });
      assert.equal(item.json.validated_video_url, 'https://www.bilibili.com/video/BV1uv411q7Mv');
    }
  }
});
