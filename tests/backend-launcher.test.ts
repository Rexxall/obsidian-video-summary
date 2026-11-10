import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendDiagnosis } from '../core/BackendHealth';
import {
  CommandResult,
  LaunchDeps,
  LaunchStep,
  findContainerForPort,
  launchBackend,
} from '../core/BackendLauncher';

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'failed'): CommandResult => ({ code: 1, stdout: '', stderr });
const inspectLine = (id: string, running: boolean, name: string, dir: string, hostPort: number) =>
  `${id}\t${running}\t/${name}\t${dir}\t{"5678/tcp":[{"HostIp":"127.0.0.1","HostPort":"${hostPort}"}]}`;

interface World {
  dockerInstalled: boolean;
  engineUp: boolean;
  /** Seconds after openEngine until the engine answers. */
  engineBootMs: number;
  containers: Array<{ id: string; running: boolean; name: string; dir: string; port: number }>;
  composeWorks: boolean;
  /** What the webhook answers once the container runs. */
  webhook: BackendDiagnosis['fault'] | 'ok';
}

function harness(world: World, overrides: Partial<LaunchDeps> = {}) {
  let clock = 0;
  let engineOpenedAt: number | null = null;
  const commands: string[] = [];
  const steps: LaunchStep[] = [];
  const engine = () =>
    world.engineUp || (engineOpenedAt !== null && clock - engineOpenedAt >= world.engineBootMs);
  const deps: LaunchDeps = {
    port: 5678,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    openEngine: async () => {
      engineOpenedAt = clock;
      return true;
    },
    onStep: (step) => steps.push(step),
    run: async (file, args, options) => {
      commands.push([file, ...args].join(' ') + (options?.cwd ? ` @${options.cwd}` : ''));
      if (!world.dockerInstalled) return { code: null, stdout: '', stderr: '', notFound: true };
      if (args[0] === 'info')
        return engine() ? ok('28.0') : fail('Cannot connect to the Docker daemon');
      if (!engine()) return fail('Cannot connect to the Docker daemon');
      if (args[0] === 'ps') return ok(world.containers.map((c) => c.id).join('\n'));
      if (args[0] === 'inspect') {
        return ok(
          world.containers
            .map((c) => inspectLine(c.id, c.running, c.name, c.dir, c.port))
            .join('\n'),
        );
      }
      if (args[0] === 'start') {
        const container = world.containers.find((c) => c.id === args[1]);
        if (!container) return fail('No such container');
        container.running = true;
        return ok();
      }
      if (args[0] === 'compose') {
        if (!world.composeWorks) return fail('pull access denied\nimage not found: vs:2.12.5');
        world.containers.push({
          id: 'new',
          running: true,
          name: 'vs-n8n-1',
          dir: options?.cwd || '',
          port: 5678,
        });
        return ok();
      }
      return fail(`unexpected ${args.join(' ')}`);
    },
    probe: async () => {
      const running = engine() && world.containers.some((c) => c.running && c.port === 5678);
      if (!running) return { ok: false, fault: 'unreachable', checkedAt: clock };
      return world.webhook === 'ok'
        ? { ok: true, checkedAt: clock }
        : { ok: false, fault: world.webhook, checkedAt: clock };
    },
    ...overrides,
  };
  return { deps, commands, steps, elapsed: () => clock };
}

const base = (): World => ({
  dockerInstalled: true,
  engineUp: false,
  engineBootMs: 8000,
  containers: [{ id: 'abc', running: false, name: 'n8n', dir: '/srv/n8n', port: 5678 }],
  composeWorks: true,
  webhook: 'ok',
});

void test('docker inspect output is matched on the host port, running container first', () => {
  const output = [
    inspectLine('a1', false, 'old-n8n', '/old', 5678),
    inspectLine('b2', true, 'n8n', '/srv/n8n', 5678),
    inspectLine('c3', true, 'postgres', '', 5432),
    'garbage line',
    'd4\ttrue\t/noports\t\t{}',
  ].join('\n');
  assert.deepEqual(findContainerForPort(output, 5678), {
    id: 'b2',
    name: 'n8n',
    running: true,
    workingDir: '/srv/n8n',
  });
  assert.equal(findContainerForPort(output, 9999), null);
  assert.equal(findContainerForPort(output, 5432)?.workingDir, undefined);
});

void test('engine down, container stopped: opens Docker, starts the container, waits for the webhook', async () => {
  const { deps, commands, steps, elapsed } = harness(base());
  const result = await launchBackend(deps);
  assert.deepEqual(result, { ok: true, backendDir: '/srv/n8n' });
  assert.deepEqual(steps, ['engine', 'container', 'answer']);
  assert.ok(commands.includes('docker start abc'));
  assert.equal(
    commands.some((command) => command.startsWith('docker compose')),
    false,
  );
  assert.ok(elapsed() <= 90_000);
});

void test('no container yet: runs compose in the known folder without pulling or building', async () => {
  const world = { ...base(), engineUp: true, containers: [] };
  const { deps, commands } = harness(world, { backendDir: '/vs/backend', hasEnvFile: true });
  const result = await launchBackend(deps);
  assert.deepEqual(result, { ok: true, backendDir: '/vs/backend' });
  assert.ok(
    commands.includes('docker compose --env-file .env up -d --no-build --pull never @/vs/backend'),
  );
});

void test('each way of not coming up names the stage it is stuck at', async () => {
  const stageOf = async (world: World, overrides: Partial<LaunchDeps> = {}) => {
    const result = await launchBackend(harness(world, overrides).deps);
    assert.equal(result.ok, false);
    return result.ok ? '' : result.stage;
  };
  assert.equal(await stageOf({ ...base(), dockerInstalled: false }), 'no-docker');
  assert.equal(await stageOf({ ...base(), engineBootMs: 10 * 60_000 }), 'engine');
  assert.equal(await stageOf({ ...base(), engineUp: true, containers: [] }), 'no-folder');
  assert.equal(
    await stageOf(
      { ...base(), engineUp: true, containers: [], composeWorks: false },
      { backendDir: '/vs/backend' },
    ),
    'container',
  );
  assert.equal(await stageOf({ ...base(), webhook: 'workflow-inactive' }), 'workflow');
  assert.equal(await stageOf({ ...base(), webhook: 'empty-response' }), 'workflow');
});

void test('a failed compose reports the last line Docker printed, and nothing waits 90 seconds', async () => {
  const world = { ...base(), engineUp: true, containers: [], composeWorks: false };
  const { deps, elapsed } = harness(world, { backendDir: '/vs/backend' });
  const result = await launchBackend(deps);
  assert.deepEqual(result, {
    ok: false,
    stage: 'container',
    detail: 'image not found: vs:2.12.5',
    backendDir: '/vs/backend',
  });
  assert.equal(elapsed(), 0);
});

void test('the wait is bounded by the timeout', async () => {
  const { deps, elapsed } = harness({ ...base(), webhook: 'workflow-inactive' });
  await launchBackend(deps);
  assert.ok(elapsed() >= 90_000 && elapsed() <= 94_000, `waited ${elapsed()} ms`);
});
