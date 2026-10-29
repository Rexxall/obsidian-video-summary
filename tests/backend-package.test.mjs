import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

import {
  buildCredentials,
  fillWorkflow,
  parseEnv,
  publicStatus,
  resolveConfig,
} from '../backend/init/configure.mjs';
import {
  CREDENTIALS,
  WORKFLOW_IDS,
  buildSpeechWorkflow,
  runJoinTranscriptNode,
} from '../tools/backend-workflow.mjs';
import { DEFAULT_WORKFLOW_PATH, MEDIA_RUNNER_PROGRAM } from '../tools/upgrade-workflow-v3.mjs';

const TOKEN = 'a'.repeat(48);
const FAKE_KEY = 'fixture-key-not-real';

function mainWorkflow() {
  return JSON.parse(readFileSync(DEFAULT_WORKFLOW_PATH, 'utf8'));
}

function codeOf(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Missing node: ${name}`);
  return node.parameters.jsCode;
}

function runCode(code, items, nodes = {}) {
  const $input = { all: () => items, first: () => items[0] };
  const $ = (name) => {
    if (!(name in nodes)) return { isExecuted: false, first: () => ({ json: {} }) };
    const list = nodes[name];
    return { isExecuted: true, first: () => list[0], all: () => list, item: list[0] };
  };
  return vm.runInNewContext(`(function ($input, $) {\n${code}\n})`, { Buffer })($input, $);
}

test('.env parsing ignores comments and keeps values with symbols', () => {
  const env = parseEnv(
    [
      '# comment',
      'VS_WEBHOOK_TOKEN=abc',
      'VS_CHAT_MODEL="deepseek-flash"  ',
      "export VS_SPEECH_MODEL='FunAudioLLM/SenseVoiceSmall'",
      'VS_CHAT_API_KEY=sk-x=y # trailing note',
      'lowercase=ignored',
    ].join('\n'),
  );
  assert.deepEqual(env, {
    VS_WEBHOOK_TOKEN: 'abc',
    VS_CHAT_MODEL: 'deepseek-flash',
    VS_SPEECH_MODEL: 'FunAudioLLM/SenseVoiceSmall',
    VS_CHAT_API_KEY: 'sk-x=y',
  });
});

test('config defaults to DeepSeek and SiliconFlow and image reading reuses the speech key', () => {
  const config = resolveConfig({ VS_WEBHOOK_TOKEN: TOKEN, VS_SPEECH_API_KEY: FAKE_KEY });
  assert.equal(config.chat.base, 'https://api.deepseek.com');
  assert.equal(config.chat.model, 'deepseek-flash');
  assert.equal(config.chat.key, '');
  assert.equal(config.speech.base, 'https://api.siliconflow.cn/v1');
  assert.equal(config.speech.model, 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(config.vision.base, config.speech.base);
  assert.equal(config.vision.key, FAKE_KEY);

  const status = publicStatus(config);
  assert.deepEqual(status.chat, {
    configured: false,
    model: 'deepseek-flash',
    host: 'api.deepseek.com',
  });
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FAKE_KEY));
});

test('config rejects a missing token and values that could break out of the workflow', () => {
  assert.throws(() => resolveConfig({}), /VS_WEBHOOK_TOKEN/);
  assert.throws(
    () => resolveConfig({ VS_WEBHOOK_TOKEN: TOKEN, VS_CHAT_BASE_URL: 'https://x.com/"+$env' }),
    /VS_CHAT_BASE_URL/,
  );
  assert.throws(
    () => resolveConfig({ VS_WEBHOOK_TOKEN: TOKEN, VS_CHAT_MODEL: "a'); process.exit(1); ('" }),
    /VS_CHAT_MODEL/,
  );
  assert.throws(
    () => resolveConfig({ VS_WEBHOOK_TOKEN: TOKEN, VS_CHAT_API_KEY: 'two words' }),
    /VS_CHAT_API_KEY/,
  );
});

test('filled workflows carry models and URLs but never keys', () => {
  const config = resolveConfig({
    VS_WEBHOOK_TOKEN: TOKEN,
    VS_CHAT_BASE_URL: 'https://api.siliconflow.cn/v1/',
    VS_CHAT_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
    VS_CHAT_API_KEY: FAKE_KEY,
    VS_SPEECH_API_KEY: `${FAKE_KEY}-speech`,
  });
  for (const workflow of [mainWorkflow(), buildSpeechWorkflow()]) {
    const filled = JSON.stringify(fillWorkflow(workflow, config));
    assert.doesNotMatch(filled, /__VS_[A-Z_]+__|VS_BACKEND_CONFIG/);
    assert.doesNotMatch(filled, new RegExp(FAKE_KEY));
    assert.doesNotMatch(filled, new RegExp(TOKEN));
  }
  const filled = fillWorkflow(mainWorkflow(), config);
  const model = filled.nodes.find((node) => node.name === 'Model: Chat');
  assert.equal(model.parameters.model.value, 'deepseek-ai/DeepSeek-V4.1-Flash');
  const health = filled.nodes.find((node) => node.name === 'Health: Chat Models');
  assert.equal(health.parameters.url, 'https://api.siliconflow.cn/v1/models');
  const speech = fillWorkflow(buildSpeechWorkflow(), config).nodes.find(
    (node) => node.name === 'Speech to Text',
  );
  assert.equal(speech.parameters.url, 'https://api.siliconflow.cn/v1/audio/transcriptions');
});

test('credentials use the ids the workflows reference', () => {
  const config = resolveConfig({ VS_WEBHOOK_TOKEN: TOKEN, VS_CHAT_API_KEY: FAKE_KEY });
  const credentials = buildCredentials(config);
  assert.deepEqual(
    credentials.map(({ id, type }) => ({ id, type })),
    Object.values(CREDENTIALS).map(({ id, type }) => ({ id, type })),
  );
  const webhook = credentials.find((credential) => credential.id === CREDENTIALS.webhook.id);
  assert.deepEqual(webhook.data, { name: 'X-Video-Summary-Token', value: TOKEN });
  const speech = credentials.find((credential) => credential.id === CREDENTIALS.speech.id);
  assert.equal(speech.data.value, 'Bearer not-configured');
});

test('Bilibili prefers uploader subtitles, then its AI subtitles, and never danmaku', () => {
  const source = MEDIA_RUNNER_PROGRAM.match(
    /function selectBilibiliSubtitle\(info\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(source, 'selectBilibiliSubtitle not found in the media runner');
  const select = vm.runInNewContext(`(${source[0]})`);
  const pick = (...keys) =>
    select({ subtitles: Object.fromEntries(keys.map((key) => [key, [{ ext: 'srt' }]])) });
  assert.equal(pick('danmaku', 'ai-zh', 'zh-Hans'), 'zh-Hans');
  assert.equal(pick('danmaku', 'ai-en', 'ai-zh'), 'ai-zh');
  assert.equal(pick('danmaku', 'ai-en'), 'ai-en');
  assert.equal(pick('danmaku'), '');
});

test('cookie upload keeps only lines for the chosen platform and rejects other formats', () => {
  const code = codeOf(mainWorkflow(), 'Code: Prepare Cookie File');
  const upload = (platform, cookies) =>
    runCode(code, [{ json: { body: { metadata: { platform, cookies } } } }]);
  const text = [
    '# Netscape HTTP Cookie File',
    '.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\tfixture',
    '.example.com\tTRUE\t/\tFALSE\t1893456000\tother\tvalue',
    '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tbili_jct\tfixture2',
  ].join('\n');
  const [item] = upload('bilibili', text);
  assert.equal(item.json.count, 2);
  assert.equal(item.json.fileName, '/home/node/cookies/bilibili_cookies.txt');
  const written = Buffer.from(item.binary.data.data, 'base64').toString('utf8');
  assert.doesNotMatch(written, /example\.com/);
  assert.match(written, /SESSDATA\tfixture/);

  assert.throws(() => upload('../../etc', text), /Unsupported cookie platform/);
  assert.throws(() => upload('bilibili', 'SESSDATA=abc; bili_jct=def'), /Netscape/);
  assert.throws(
    () => upload('youtube', '.bilibili.com\tTRUE\t/\tTRUE\t1\tSESSDATA\tx'),
    /No youtube cookies/,
  );
});

test('health report explains what is configured without leaking anything secret', () => {
  const code = codeOf(mainWorkflow(), 'Code: Health Report').replace(
    '/* VS_BACKEND_CONFIG */ null',
    JSON.stringify({
      chat: { configured: true, model: 'deepseek-flash', host: 'api.deepseek.com' },
      speech: {
        configured: false,
        model: 'FunAudioLLM/SenseVoiceSmall',
        host: 'api.siliconflow.cn',
      },
      vision: { configured: false, model: 'Qwen/Qwen3-VL-8B-Instruct', host: 'api.siliconflow.cn' },
    }),
  );
  const probe = { json: { stdout: JSON.stringify({ tools: { ytDlp: '2026.10.26' } }) } };
  const [basic] = runCode(code, [probe], { 'CMD: Health Probe': [probe] });
  assert.equal(basic.json.workflow.version, '3.0.0');
  assert.equal(basic.json.backend.chat.checked, false);

  const [deep] = runCode(code, [probe], {
    'CMD: Health Probe': [probe],
    'Health: Chat Models': [
      {
        json: {
          statusCode: 200,
          body: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
        },
      },
    ],
    'Health: Speech to Text': [
      { json: { error: 'Authorization failed - please check your credentials' } },
    ],
  });
  assert.equal(deep.json.backend.chat.ok, true);
  assert.equal(deep.json.backend.chat.modelListed, true);
  assert.equal(deep.json.backend.speech.ok, false);
  assert.match(deep.json.backend.speech.error, /Authorization failed/);
});

test('speech-to-text joins chunks in order, strips model tags and keeps rough timing', () => {
  const parts = [
    {
      json: {
        path: '/home/node/files/stt-0123456789ab/part-000.mp3',
        start: 0,
        end: 600,
        workdir: '/home/node/files/stt-0123456789ab',
      },
    },
    { json: { path: '/home/node/files/stt-0123456789ab/part-001.mp3', start: 600, end: 742.5 } },
  ];
  const [result] = runJoinTranscriptNode(
    {
      all: () => [{ json: { text: '<|zh|><|NEUTRAL|>第一段。' } }, { json: { text: '第二段。' } }],
    },
    () => ({ all: () => parts }),
  );
  assert.equal(result.json.full_transcript, '第一段。\n第二段。');
  assert.equal(result.json.timing_quality, 'estimated');
  assert.equal(result.json.transcript_source, 'asr');
  assert.deepEqual(
    result.json.video_segments.map(({ start, end }) => [start, end]),
    [
      [0, 600],
      [600, 742.5],
    ],
  );
  assert.equal(result.json.workdir, '/home/node/files/stt-0123456789ab');
});

test('speech workflow commands only accept container paths and its own working folders', () => {
  const workflow = buildSpeechWorkflow();
  assert.equal(workflow.id, WORKFLOW_IDS.speech);
  const split = workflow.nodes.find((node) => node.name === 'CMD: Split Audio').parameters.command;
  const clean = workflow.nodes.find((node) => node.name === 'CMD: Clean Up').parameters.command;
  const evaluate = (expression, json) =>
    vm.runInNewContext(expression.replace(/^=\{\{|\}\}$/g, ''), { $json: json });
  assert.throws(() => evaluate(split, { audio_file_path: '/etc/passwd' }), /inside the container/);
  const command = evaluate(split, { audio_file_path: "/home/node/uploads/课程 01 (it's).mp3" });
  assert.match(command, / [A-Za-z0-9._~%-]+$/);
  assert.doesNotMatch(command.split(' ').pop(), /['()]/);
  assert.throws(
    () => evaluate(clean, { workdir: '/home/node/files' }),
    /Unexpected working folder/,
  );
  assert.match(
    evaluate(clean, { workdir: '/home/node/files/stt-0123456789ab' }),
    /stt-0123456789ab$/,
  );
});

test('start scripts parse, keep Windows-readable encoding and never echo keys', async () => {
  const { spawnSync } = await import('node:child_process');
  const { statSync } = await import('node:fs');
  const sh = new URL('../backend/vs-backend.sh', import.meta.url);
  assert.equal(spawnSync('bash', ['-n', sh.pathname]).status, 0);
  assert.ok(statSync(sh).mode & 0o111, 'vs-backend.sh must be executable');
  assert.ok(statSync(new URL('../backend/start-mac.command', import.meta.url)).mode & 0o111);

  const ps1 = readFileSync(new URL('../backend/vs-backend.ps1', import.meta.url));
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell 5.1 needs a UTF-8 BOM');
  const cmd = readFileSync(new URL('../backend/start-windows.cmd', import.meta.url), 'utf8');
  assert.match(cmd, /\r\n/, 'cmd files need CRLF line endings');

  const script = readFileSync(sh, 'utf8');
  assert.match(script, /read -rs value/, 'keys are read without echo');
  assert.doesNotMatch(script, /echo[^\n]*API_KEY/);
});
