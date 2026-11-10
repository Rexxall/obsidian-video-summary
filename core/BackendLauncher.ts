/**
 * Starts a backend that is already installed on this computer: opens the Docker
 * engine, starts the container that owns the webhook's port, and waits for the
 * webhook to answer. It never downloads or builds anything; a first install
 * stays with the start script the user runs themselves.
 *
 * Running programs, sleeping and probing are passed in, so the sequence can be
 * tested without Docker.
 */
import { BackendDiagnosis } from './BackendHealth';

export interface CommandResult {
  /** Exit code; null when the program could not be run or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program does not exist on this computer. */
  notFound?: boolean;
}

export type RunCommand = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; input?: string },
) => Promise<CommandResult>;

export type LaunchStage =
  /** The docker command does not exist. */
  | 'no-docker'
  /** Docker is installed; its engine did not come up. */
  | 'engine'
  /** No container owns the port and no backend folder is known. */
  | 'no-folder'
  /** The container did not start or stopped again. */
  | 'container'
  /** The container runs; the workflow does not answer. */
  | 'workflow';

export type LaunchStep = 'engine' | 'container' | 'answer';

export type LaunchResult =
  | { ok: true; backendDir?: string }
  | { ok: false; stage: LaunchStage; detail?: string; backendDir?: string };

export interface LaunchDeps {
  run: RunCommand;
  probe: () => Promise<BackendDiagnosis>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Opens OrbStack or Docker Desktop. false when there is nothing to open. */
  openEngine: () => Promise<boolean>;
  /** Host port of the webhook address. */
  port: number;
  /** Folder with compose.yaml; used when no existing container owns the port. */
  backendDir?: string;
  /** Whether `backendDir` has a .env file to pass to compose. */
  hasEnvFile?: boolean;
  onStep?: (step: LaunchStep) => void;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface BackendContainer {
  id: string;
  name: string;
  running: boolean;
  /** The compose project folder the container was created from, when it has one. */
  workingDir?: string;
  /** The image reference the container was created from. */
  image: string;
  /** Docker's restart policy name: 'no', 'always', 'unless-stopped' or 'on-failure'. */
  restart: string;
}

const INSPECT_FORMAT =
  '{{.Id}}\t{{.State.Running}}\t{{.Name}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{.Config.Image}}\t{{.HostConfig.RestartPolicy.Name}}\t{{json .HostConfig.PortBindings}}';

/** Reads `docker inspect` lines in INSPECT_FORMAT and returns the container bound to `port`. */
export function findContainerForPort(inspectOutput: string, port: number): BackendContainer | null {
  const matches: BackendContainer[] = [];
  for (const line of inspectOutput.split(/\r?\n/)) {
    const [id, running, name, workingDir, image, restart, bindings] = line.split('\t');
    if (!id || !bindings) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bindings);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const owns = Object.values(parsed as Record<string, unknown>).some(
      (hosts) =>
        Array.isArray(hosts) &&
        hosts.some(
          (host) =>
            !!host &&
            typeof host === 'object' &&
            Number((host as { HostPort?: string }).HostPort) === port,
        ),
    );
    if (!owns) continue;
    matches.push({
      id,
      running: running === 'true',
      name: (name || '').replace(/^\//, ''),
      workingDir: workingDir && workingDir !== '<no value>' ? workingDir : undefined,
      image: image || '',
      restart: restart || 'no',
    });
  }
  return matches.find((container) => container.running) ?? matches[0] ?? null;
}

/** The container bound to `port`, running or stopped. null when the engine has none. */
export async function locateContainer(
  run: RunCommand,
  port: number,
): Promise<BackendContainer | null> {
  const list = await run('docker', ['ps', '-aq'], { timeoutMs: 8000 });
  if (list.code !== 0) return null;
  const ids = list.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return null;
  const inspect = await run('docker', ['inspect', '--format', INSPECT_FORMAT, ...ids], {
    timeoutMs: 8000,
  });
  return findContainerForPort(inspect.stdout, port);
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : undefined;
}

export async function launchBackend(deps: LaunchDeps): Promise<LaunchResult> {
  const { run, probe, sleep, now } = deps;
  const interval = deps.intervalMs ?? 2000;
  const deadline = now() + (deps.timeoutMs ?? 90_000);
  const engineUp = async () =>
    (await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 6000 })).code ===
    0;

  // 1. Docker engine
  deps.onStep?.('engine');
  const first = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 6000,
  });
  if (first.notFound) return { ok: false, stage: 'no-docker' };
  if (first.code !== 0) {
    await deps.openEngine();
    let up = false;
    while (now() < deadline) {
      await sleep(interval);
      if (await engineUp()) {
        up = true;
        break;
      }
    }
    if (!up) return { ok: false, stage: 'engine', detail: lastLine(first.stderr) };
  }

  // 2. Container
  deps.onStep?.('container');
  let container = await locateContainer(run, deps.port);
  let backendDir = container?.workingDir ?? deps.backendDir;
  if (container && !container.running) {
    const started = await run('docker', ['start', container.id], { timeoutMs: 30_000 });
    if (started.code !== 0) {
      return { ok: false, stage: 'container', detail: lastLine(started.stderr), backendDir };
    }
  } else if (!container) {
    if (!deps.backendDir) return { ok: false, stage: 'no-folder' };
    backendDir = deps.backendDir;
    // --pull never and --no-build: start what is installed, never fetch or build.
    const up = await run(
      'docker',
      [
        'compose',
        ...(deps.hasEnvFile ? ['--env-file', '.env'] : []),
        'up',
        '-d',
        '--no-build',
        '--pull',
        'never',
      ],
      { cwd: deps.backendDir, timeoutMs: 60_000 },
    );
    if (up.code !== 0) {
      return { ok: false, stage: 'container', detail: lastLine(up.stderr), backendDir };
    }
  }

  // 3. Webhook answers
  deps.onStep?.('answer');
  let last: BackendDiagnosis | undefined;
  for (;;) {
    last = await probe();
    if (last.ok) return { ok: true, backendDir };
    if (now() >= deadline) break;
    await sleep(interval);
  }

  container = await locateContainer(run, deps.port);
  if (!container || !container.running) {
    return { ok: false, stage: 'container', backendDir };
  }
  const workflowFault =
    last.fault === 'workflow-inactive' ||
    last.fault === 'empty-response' ||
    last.fault === 'workflow-error' ||
    last.fault === 'auth';
  return {
    ok: false,
    stage: workflowFault ? 'workflow' : 'container',
    detail: last.fault,
    backendDir,
  };
}
