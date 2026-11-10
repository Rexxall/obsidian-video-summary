import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { withSettingsFixes, type SetupStep } from '../core/BackendSetup';
import type { CommandResult } from '../core/BackendLauncher';
import {
  applyModelConfig,
  backendOutdated,
  bundledImageVersion,
  connectionFor,
  installScript,
  isBundledImage,
  managedCompose,
  planEnv,
  readEnvValue,
  requiredImage,
  type BackendFacts,
} from '../core/ManagedBackend';
import {
  LLM_PROVIDERS,
  modelConfigFingerprint,
  resolveLlm,
  resolveSpeech,
} from '../core/ModelSettings';

const FAKE_KEY = 'sk-test-0123456789abcdef';
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

void test('the compose file the plugin writes runs the same service as the packaged one', () => {
  const packaged = readFileSync(join(process.cwd(), 'backend/compose.yaml'), 'utf8');
  const written = managedCompose('9.9.9');
  // Every port, volume and environment line of the packaged file, comments aside.
  const wanted = packaged
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  assert.ok(wanted.length > 20);
  for (const line of wanted) {
    assert.ok(written.includes(line), `compose.yaml written by the plugin lacks: ${line}`);
  }
  assert.match(written, /image: \$\{VS_IMAGE:-ghcr\.io\/rexxall\/video-summary-backend:9\.9\.9\}/);
  assert.match(written, /restart: unless-stopped/);
  assert.doesNotMatch(written, /build:|0\.0\.0\.0/);
});

void test('a new .env gets a token and a port; an existing one keeps every line it has', () => {
  const fresh = planEnv(null, { port: 5679, timeZone: 'Asia/Tokyo' });
  assert.match(fresh.token, /^[0-9a-f]{48}$/);
  assert.equal(fresh.port, 5679);
  assert.equal(readEnvValue(fresh.text, 'VS_WEBHOOK_TOKEN'), fresh.token);
  assert.equal(readEnvValue(fresh.text, 'TZ'), 'Asia/Tokyo');
  assert.doesNotMatch(fresh.text, /API_KEY/);
  assert.notEqual(planEnv(null, { port: 5678, timeZone: 'UTC' }).token, fresh.token);

  const scripted = [
    '# made by the start script',
    'VS_WEBHOOK_TOKEN=abcdefghijklmnopqrstuvwxyz012345',
    'VS_PORT=5680',
    `VS_CHAT_API_KEY=${FAKE_KEY}`,
    'VS_CHAT_MODEL=qwen-plus',
    '',
  ].join('\n');
  const adopted = planEnv(scripted, { port: 5678, timeZone: 'UTC' });
  assert.equal(adopted.text, scripted, 'an adopted .env is not rewritten');
  assert.equal(adopted.token, 'abcdefghijklmnopqrstuvwxyz012345');
  assert.equal(adopted.port, 5680);
  assert.deepEqual(connectionFor(adopted.port, adopted.token), {
    url: 'http://127.0.0.1:5680/webhook/obsidian-video-summary',
    headerName: 'X-Video-Summary-Token',
    secret: 'abcdefghijklmnopqrstuvwxyz012345',
  });

  const mirrored = planEnv(scripted, {
    port: 5678,
    timeZone: 'UTC',
    image: 'mirror.example/vsb:1',
  });
  assert.equal(readEnvValue(mirrored.text, 'VS_IMAGE'), 'mirror.example/vsb:1');
  assert.equal(readEnvValue(mirrored.text, 'VS_CHAT_API_KEY'), FAKE_KEY);
});

void test('the Terminal script says what it will run and waits for Return before any download', () => {
  for (const chinese of [true, false]) {
    for (const update of [true, false]) {
      const script = installScript({ chinese, update });
      const read = script.indexOf('read -r -p');
      const pull = script.indexOf('docker compose --env-file .env pull');
      const up = script.indexOf('docker compose --env-file .env up -d');
      const shown = script.indexOf("echo '  docker compose pull && docker compose up -d'");
      assert.ok(shown > 0 && shown < read, 'the command is shown before the prompt');
      assert.ok(read > 0 && read < pull && pull < up, 'nothing is downloaded before Return');
      assert.match(script, /^#!\/bin\/bash\n/);
      assert.doesNotMatch(script, /curl|wget|sudo|rm -/);
    }
  }
  // A quote in a message cannot end the shell string it is echoed from.
  assert.doesNotMatch(installScript({ chinese: false, update: false }), /echo '[^'\n]*'[A-Za-z]/);
});

void test('bundled images are recognised from any registry, and an older tag asks for an update', () => {
  assert.equal(isBundledImage('ghcr.io/rexxall/video-summary-backend:2.12.5'), true);
  assert.equal(isBundledImage('video-summary-backend:dev-local'), true);
  assert.equal(isBundledImage('mirror.example/rexxall/video-summary-backend@sha256:abc'), true);
  assert.equal(isBundledImage('n8n-n8n'), false);
  assert.equal(isBundledImage('docker.n8n.io/n8nio/n8n:2.0'), false);
  assert.equal(bundledImageVersion('ghcr.io/rexxall/video-summary-backend:2.12.5'), '2.12.5');
  assert.equal(bundledImageVersion('video-summary-backend:dev-local'), '');
  assert.equal(requiredImage('2.13.0'), 'ghcr.io/rexxall/video-summary-backend:2.13.0');
  assert.equal(requiredImage('2.13.0', ' mirror/x:1 '), 'mirror/x:1');

  const facts = (image: string): BackendFacts => ({
    docker: 'running',
    container: {
      id: 'c1',
      name: 'video-summary-n8n-1',
      running: true,
      image,
      restart: 'unless-stopped',
    },
    bundled: isBundledImage(image),
    imageVersion: bundledImageVersion(image),
  });
  assert.equal(
    backendOutdated(facts('ghcr.io/rexxall/video-summary-backend:2.12.5'), '2.13.0'),
    true,
  );
  assert.equal(
    backendOutdated(facts('ghcr.io/rexxall/video-summary-backend:2.13.0'), '2.13.0'),
    false,
  );
  // Someone's own n8n is never told to update.
  assert.equal(backendOutdated(facts('n8n-n8n'), '2.13.0'), false);
  assert.equal(
    backendOutdated(
      facts('video-summary-backend:dev-local'),
      '2.13.0',
      'video-summary-backend:dev-local',
    ),
    false,
  );
});

void test('keys reach the backend on standard input only, then the container restarts', async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run = async (_file: string, args: string[], options?: { input?: string }) => {
    calls.push({ args, input: options?.input });
    return args[0] === 'exec' ? ok('{"applied":true,"chat":{"configured":true}}\n') : ok();
  };
  const result = await applyModelConfig(run, 'c1', {
    chat: { key: FAKE_KEY, base: 'https://api.deepseek.com', model: 'deepseek-flash' },
    speech: {},
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map((call) => call.args[0]),
    ['exec', 'restart'],
  );
  assert.equal(
    calls
      .flatMap((call) => call.args)
      .join(' ')
      .includes(FAKE_KEY),
    false,
  );
  assert.ok(calls[0].input?.includes(FAKE_KEY));
  assert.equal(calls[1].input, undefined);
});

void test('a backend too old to take settings, or one that rejects them, is not restarted', async () => {
  const restarted: string[] = [];
  const old = await applyModelConfig(
    async (_file, args) => {
      if (args[0] === 'restart') restarted.push('old');
      return ok('[video-summary] workflows and keys unchanged since the last start\n');
    },
    'c1',
    { chat: { key: FAKE_KEY }, speech: {} },
  );
  assert.deepEqual(old, { ok: false, reason: 'old-backend' });

  const rejected = await applyModelConfig(
    async (_file, args) => {
      if (args[0] === 'restart') restarted.push('rejected');
      return {
        code: 1,
        stdout: '',
        stderr:
          '[video-summary] VS_CHAT_MODEL may contain only letters, digits and . _ : / @ + -\n',
      };
    },
    'c1',
    { chat: { key: FAKE_KEY, model: 'bad model' }, speech: {} },
  );
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.reason, 'rejected');
  assert.equal(!rejected.ok && rejected.detail?.includes(FAKE_KEY), false);
  assert.deepEqual(restarted, []);
});

void test('provider presets resolve to an address and a model; the fingerprint holds no key', async () => {
  assert.deepEqual(
    LLM_PROVIDERS.map((provider) => provider.id),
    ['deepseek', 'siliconflow', 'qwen', 'kimi', 'gemini', 'custom'],
  );
  const deepseek = resolveLlm({ llmProvider: 'deepseek', llmModel: '', llmBaseUrl: 'ignored' });
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(deepseek.model, 'deepseek-flash');
  const custom = resolveLlm({
    llmProvider: 'custom',
    llmModel: ' my-model ',
    llmBaseUrl: 'https://llm.example.com/v1/',
  });
  assert.deepEqual([custom.baseUrl, custom.model], ['https://llm.example.com/v1', 'my-model']);
  assert.equal(resolveLlm({ llmProvider: 'kimi', llmModel: '', llmBaseUrl: '' }).model, '');
  assert.equal(
    resolveSpeech({ speechBaseUrl: '', speechModel: '' }).model,
    'FunAudioLLM/SenseVoiceSmall',
  );

  const one = await modelConfigFingerprint({ chat: { key: FAKE_KEY, model: 'a' }, speech: {} });
  const two = await modelConfigFingerprint({
    chat: { key: `${FAKE_KEY}x`, model: 'a' },
    speech: {},
  });
  assert.match(one, /^[0-9a-f]{24}$/);
  assert.notEqual(one, two);
  assert.equal(one.includes(FAKE_KEY), false);
});

void test('with keys managed in settings, key fixes point at settings, not at .env', () => {
  const steps: SetupStep[] = [
    { id: 'connect', label: 'Backend running', state: 'ready', detail: '' },
    {
      id: 'chat',
      label: 'Summary model',
      state: 'missing',
      detail: 'no key yet',
      fix: "Set VS_CHAT_API_KEY in the backend's .env (or run vs-backend keys), then run the start script again.",
    },
    { id: 'tools', label: 'Tools', state: 'missing', detail: '', fix: 'Update the backend.' },
  ];
  const fixed = withSettingsFixes(steps);
  assert.doesNotMatch(fixed[1].fix || '', /\.env|vs-backend/);
  assert.equal(fixed[2].fix, 'Update the backend.');
});
