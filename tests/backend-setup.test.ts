import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { interpretSetupCheck, parseConnectionCode, reportedChatModel } from '../core/BackendSetup';

const TOKEN = 'f'.repeat(48);
const FALLBACK = 'http://127.0.0.1:5678/webhook/obsidian-video-summary';

function healthReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    workflow: { version: '3.0.0' },
    backend: {
      tools: { ytDlp: '2026.10.26', ffmpeg: '8.1.3' },
      cookies: { bilibili: { present: false } },
      chat: {
        configured: true,
        model: 'deepseek-flash',
        host: 'api.deepseek.com',
        checked: true,
        ok: true,
        modelListed: true,
      },
      speech: {
        configured: true,
        model: 'FunAudioLLM/SenseVoiceSmall',
        host: 'api.siliconflow.cn',
        checked: true,
        ok: true,
      },
      vision: { configured: true, model: 'Qwen/Qwen3-VL-8B-Instruct', host: 'api.siliconflow.cn' },
      ...overrides,
    },
  };
}

function stateOf(steps: ReturnType<typeof interpretSetupCheck>, id: string) {
  const found = steps.find((step) => step.id === id);
  if (!found) throw new Error(`missing step ${id}`);
  return found;
}

test('connection code from the start script fills URL, header and token', () => {
  assert.deepEqual(
    parseConnectionCode(
      `  http://127.0.0.1:5690/webhook/obsidian-video-summary#token=${TOKEN}\n`,
      FALLBACK,
    ),
    {
      url: 'http://127.0.0.1:5690/webhook/obsidian-video-summary',
      headerName: 'X-Video-Summary-Token',
      secret: TOKEN,
    },
  );
  assert.equal(
    parseConnectionCode(
      `https://n8n.example.org/webhook/x#header=X-Custom&token=${TOKEN}`,
      FALLBACK,
    )?.headerName,
    'X-Custom',
  );
  assert.deepEqual(parseConnectionCode(TOKEN, FALLBACK), {
    url: FALLBACK,
    headerName: 'X-Video-Summary-Token',
    secret: TOKEN,
  });
  assert.equal(
    parseConnectionCode('http://127.0.0.1:5678/webhook/obsidian-video-summary', FALLBACK),
    null,
  );
  assert.equal(parseConnectionCode('#token=short', FALLBACK), null);
  assert.equal(parseConnectionCode(`javascript:alert(1)#token=${TOKEN}`, FALLBACK), null);
});

test('a backend that is not running points at Docker and the start script', () => {
  const steps = interpretSetupCheck({ error: 'connect ECONNREFUSED 127.0.0.1:5678', deep: false });
  assert.equal(stateOf(steps, 'connect').state, 'missing');
  assert.match(stateOf(steps, 'connect').fix ?? '', /Docker/);
  assert.match(stateOf(steps, 'connect').fix ?? '', /start-windows\.cmd/);
  assert.ok(steps.slice(1).every((step) => step.state === 'pending'));
});

test('a rejected token asks for a fresh connection code', () => {
  const steps = interpretSetupCheck({ status: 403, deep: false });
  assert.equal(stateOf(steps, 'connect').state, 'ready');
  assert.equal(stateOf(steps, 'token').state, 'missing');
  assert.match(stateOf(steps, 'token').fix ?? '', /vs-backend\.sh code/);
});

test('a manually imported old workflow is told to switch to the backend package', () => {
  const steps = interpretSetupCheck({
    status: 200,
    report: { ok: true, workflow: { version: '2.1.5' } },
    deep: true,
  });
  assert.equal(stateOf(steps, 'version').state, 'missing');
  assert.match(stateOf(steps, 'version').fix ?? '', /后端安装包/);
});

test('a healthy deep check marks every required step ready', () => {
  const steps = interpretSetupCheck({ status: 200, report: healthReport(), deep: true });
  for (const id of ['connect', 'token', 'version', 'tools', 'chat', 'speech', 'vision']) {
    assert.equal(stateOf(steps, id).state, 'ready', id);
  }
  assert.equal(stateOf(steps, 'bilibili').state, 'warning');
  assert.equal(reportedChatModel(healthReport()), 'deepseek-flash');
});

test('missing or wrong keys say which .env entry to change', () => {
  const missing = interpretSetupCheck({
    status: 200,
    report: healthReport({
      chat: { configured: false, model: 'deepseek-flash', host: 'api.deepseek.com' },
    }),
    deep: true,
  });
  assert.equal(stateOf(missing, 'chat').state, 'missing');
  assert.match(stateOf(missing, 'chat').fix ?? '', /VS_CHAT_API_KEY/);

  const wrong = interpretSetupCheck({
    status: 200,
    report: healthReport({
      speech: {
        configured: true,
        model: 'FunAudioLLM/SenseVoiceSmall',
        host: 'api.siliconflow.cn',
        checked: true,
        ok: false,
        error: 'Authorization failed - please check your credentials',
      },
    }),
    deep: true,
  });
  assert.equal(stateOf(wrong, 'speech').state, 'missing');
  assert.match(stateOf(wrong, 'speech').fix ?? '', /VS_SPEECH_API_KEY/);

  const offline = interpretSetupCheck({
    status: 200,
    report: healthReport({
      chat: {
        configured: true,
        model: 'deepseek-flash',
        host: 'api.deepseek.com',
        checked: true,
        ok: false,
        error: 'getaddrinfo ENOTFOUND api.deepseek.com',
      },
    }),
    deep: true,
  });
  assert.match(stateOf(offline, 'chat').fix ?? '', /VS_HTTP_PROXY/);

  const unlisted = interpretSetupCheck({
    status: 200,
    report: healthReport({
      chat: {
        configured: true,
        model: 'deepseek-typo',
        host: 'api.deepseek.com',
        checked: true,
        ok: true,
        modelListed: false,
      },
    }),
    deep: true,
  });
  assert.equal(stateOf(unlisted, 'chat').state, 'warning');
  assert.match(stateOf(unlisted, 'chat').fix ?? '', /VS_CHAT_MODEL/);
});

test('the quick check does not claim the keys work', () => {
  const steps = interpretSetupCheck({ status: 200, report: healthReport(), deep: false });
  assert.equal(stateOf(steps, 'chat').state, 'pending');
  assert.equal(stateOf(steps, 'speech').state, 'pending');
});

test('an empty provider balance says to top up, including for free models', () => {
  const steps = interpretSetupCheck({
    status: 200,
    report: healthReport({
      speech: {
        configured: true,
        model: 'FunAudioLLM/SenseVoiceSmall',
        host: 'api.siliconflow.cn',
        checked: true,
        ok: false,
        error: 'Payment required - perhaps check your payment details?',
      },
    }),
    deep: true,
  });
  assert.match(stateOf(steps, 'speech').fix ?? '', /充值/);
});

test('a slow provider is told apart from an unreachable one', () => {
  const failing = (error: string) =>
    interpretSetupCheck({
      status: 200,
      report: healthReport({
        chat: { configured: true, model: 'm', host: 'h', checked: true, ok: false, error },
      }),
      deep: true,
    }).find((step) => step.id === 'chat')?.fix ?? '';
  assert.match(failing('timeout of 20000ms exceeded'), /没有回应/);
  assert.match(failing('getaddrinfo ENOTFOUND h'), /连不上/);
});
