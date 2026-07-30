import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONTENT_ROUTE_PROMPT_MARKER,
  DEFAULT_WORKFLOW_PATH,
  executeNodeCode,
  runSplitLocalFilesNode,
  upgradeWorkflow,
  validateWorkflow,
} from '../tools/upgrade-workflow-v3.mjs';

function loadWorkflow() {
  return JSON.parse(readFileSync(DEFAULT_WORKFLOW_PATH, 'utf8'));
}

function nodeCode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node.parameters.jsCode;
}

function materializeN8nPromptExpression(text) {
  const source = text.startsWith('=') ? text.slice(1) : text;
  let cursor = 0;
  let materialized = '';

  while (cursor < source.length) {
    const open = source.indexOf('{{', cursor);
    if (open < 0) {
      materialized += source.slice(cursor);
      break;
    }
    materialized += source.slice(cursor, open);

    let index = open + 2;
    let braceDepth = 0;
    let quote = null;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character;
        continue;
      }
      if (character === '{') {
        braceDepth += 1;
        continue;
      }
      if (character === '}' && braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }
      if (character === '}' && source[index + 1] === '}' && braceDepth === 0) {
        break;
      }
    }
    assert.ok(index < source.length, 'Unclosed n8n interpolation');

    const expression = source.slice(open + 2, index).trim();
    if (expression.includes('video_segments')) {
      materialized += '[]';
    } else if (expression.includes('body.metadata || {}')) {
      materialized += '{}';
    } else if (expression.includes('ai_retry_count')) {
      materialized += '0';
    } else {
      materialized += '""';
    }
    cursor = index + 2;
  }

  return materialized;
}

test('workflow upgrade is idempotent and passes structural validation', () => {
  const workflow = loadWorkflow();
  const once = upgradeWorkflow(workflow);
  const twice = upgradeWorkflow(once);

  assert.deepEqual(once, workflow, 'Run tools/upgrade-workflow-v3.mjs');
  assert.deepEqual(twice, once);
  assert.deepEqual(validateWorkflow(workflow), []);
});

test('public workflow does not embed a private user profile', () => {
  const serialized = JSON.stringify(upgradeWorkflow(loadWorkflow()));
  assert.doesNotMatch(serialized, /\*\*用户画像\*\*/);
  assert.doesNotMatch(serialized, /针对[^\n]{0,80}定制/);
  assert.doesNotMatch(serialized, /我的背景契合度/);
  assert.doesNotMatch(serialized, /结合[^\n|]{0,80}背景分析/);
  assert.match(serialized, /不得假设用户的教育背景、身份、研究方向或申请目标/);
});

test('active AI prompt expressions remain syntactically executable', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  for (const name of [
    'AI Agent',
    'AI Agent1',
    'AI Agent2',
    'AI Agent3',
    'AI Agent5',
    'AI Agent6',
  ]) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    assert.ok(node, `Missing node: ${name}`);
    const materialized = materializeN8nPromptExpression(node.parameters.text);
    assert.doesNotThrow(() => new Function(materialized), name);
  }
});

test('all active AI prompts carry every durable content route contract', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  for (const name of [
    'AI Agent',
    'AI Agent1',
    'AI Agent2',
    'AI Agent3',
    'AI Agent5',
    'AI Agent6',
  ]) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    assert.ok(node, `Missing node: ${name}`);
    assert.match(node.parameters.text, new RegExp(CONTENT_ROUTE_PROMPT_MARKER));
    for (const route of [
      'course',
      'interview',
      'tutorial',
      'news',
      'meeting',
      'review',
      'general',
    ]) {
      assert.match(node.parameters.text, new RegExp(`- ${route}：`), `${name}.${route}`);
    }
    assert.match(node.parameters.text, /当前 n8n 路径不接收视频帧/);
    assert.doesNotMatch(node.parameters.text, /逐帧拉片原案|光影构图/);
  }
});

test('public workflow requires an explicit local ASR subworkflow selection', () => {
  const workflow = upgradeWorkflow(loadWorkflow());
  for (const name of ['SubFlow: Transcript', 'SubFlow: Transcript from Local File']) {
    const node = workflow.nodes.find((candidate) => candidate.name === name);
    assert.ok(node, `Missing node: ${name}`);
    assert.deepEqual(node.parameters.workflowId, {
      __rl: true,
      value: 'CONFIGURE_ASR_WORKFLOW_ID',
      mode: 'id',
    });
  }
});

test('local-file workflow paths remain inside the mounted uploads directory', () => {
  const valid = runSplitLocalFilesNode({
    all: () => [
      {
        json: {
          body: {
            metadata: {
              local_file: 'course/lecture-01.mp4, interview.mp3',
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(
    valid.map((item) => item.json.audio_file_path_for_subflow),
    ['/home/node/uploads/course/lecture-01.mp4', '/home/node/uploads/interview.mp3'],
  );

  for (const localFile of [
    '/etc/passwd',
    '../cookies/token.txt',
    'course/../../cookies/token.txt',
    'C:\\Users\\example\\video.mp4',
    'course//video.mp4',
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
      /safe relative path/,
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
    new Function('$json', `return (${expression});`)({
      body: { metadata: { local_file: localFile } },
    });
  assert.equal(evaluate('course/lecture-01.mp4'), '/home/node/uploads/course/lecture-01.mp4');
  assert.throws(() => evaluate('../cookies/token.txt'), /safe relative path/);
  assert.throws(() => evaluate('/etc/passwd'), /safe relative path/);
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
        () => new Function('$json', '$', `return (${expression});`)($json, $),
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

  for (const parserName of [
    'Code: Parse AI JSON Output & Manage Retries',
    'Code: Parse AI JSON Output & Manage Retries1',
  ]) {
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
    nodeCode(workflow, 'Code: Parse AI JSON Output & Manage Retries'),
    [{ json: { output: '{broken json' } }],
    { 'Set: Final Transcript for AI': transcriptContext },
  )[0].json;

  assert.equal(result.trigger_ai_retry, true);
  assert.equal(result.ai_retry_count, 1);
  assert.deepEqual(result.video_segments, transcriptContext.video_segments);
  assert.equal(result.video_transcript, transcriptContext.video_transcript);
  assert.match(result.parsing_error_details, /JSON解析失败/);
});
