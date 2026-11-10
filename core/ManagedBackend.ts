/**
 * The backend the plugin sets up itself: which files go in its folder, what the
 * person runs in a terminal to download it, and how the plugin hands it the
 * model and keys afterwards.
 *
 * The plugin writes text files and starts what is installed. It never downloads
 * or updates the backend image: that is one command the person confirms in a
 * terminal window (Obsidian's developer policies do not let a plugin install or
 * update its own dependencies).
 */
import { DEFAULT_WEBHOOK_AUTH_HEADER } from '../constants';
import { type BackendContainer, type RunCommand, locateContainer } from './BackendLauncher';
import type { BackendModelConfig } from './ModelSettings';

export const BACKEND_IMAGE_REPO = 'ghcr.io/rexxall/video-summary-backend';
export const BACKEND_WEBHOOK_PATH = '/webhook/obsidian-video-summary';
export const BACKEND_DEFAULT_PORT = 5678;
export const INSTALL_SCRIPT_NAME = 'install-backend.command';

/** The image this plugin version expects; the tag is the plugin version. */
export function requiredImage(pluginVersion: string, override = ''): string {
  return override.trim() || `${BACKEND_IMAGE_REPO}:${pluginVersion}`;
}

/** Version tag of a bundled backend image, or '' for any other image. */
export function bundledImageVersion(image: string): string {
  const match = /(?:^|\/)video-summary-backend:([0-9][0-9A-Za-z._-]*)$/.exec(image || '');
  return match ? match[1] : '';
}

/** true for the packaged backend, whichever registry or local tag it came from. */
export function isBundledImage(image: string): boolean {
  return /(?:^|\/)video-summary-backend(?::|@|$)/.test(image || '');
}

/**
 * compose.yaml for a backend folder the plugin writes. The same service as
 * backend/compose.yaml, without the build section: this folder has no Dockerfile.
 */
export function managedCompose(pluginVersion: string): string {
  return `# Written by the Video Summary plugin. Settings are in .env next to this file.
name: \${VS_PROJECT:-video-summary}

services:
  n8n:
    image: \${VS_IMAGE:-${BACKEND_IMAGE_REPO}:${pluginVersion}}
    pull_policy: missing
    restart: unless-stopped
    # Reachable only from this computer.
    ports:
      - '127.0.0.1:\${VS_PORT:-5678}:5678'
    volumes:
      - n8n-data:/home/node/.n8n
      - work:/home/node/files
      - ./uploads:/home/node/uploads
      - ./cookies:/home/node/cookies
      - ./.env:/run/video-summary/config.env:ro
    environment:
      - WEBHOOK_URL=http://127.0.0.1:\${VS_PORT:-5678}/
      - GENERIC_TIMEZONE=\${TZ:-Asia/Shanghai}
      - TZ=\${TZ:-Asia/Shanghai}
      - N8N_DIAGNOSTICS_ENABLED=false
      - N8N_VERSION_NOTIFICATIONS_ENABLED=false
      - N8N_PERSONALIZATION_ENABLED=false
      - N8N_PYTHON_ENABLED=false
      - NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=true
      - NODE_FUNCTION_ALLOW_BUILTIN=url
      - N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=true
      - N8N_RESTRICT_FILE_ACCESS_TO=/home/node/uploads;/home/node/files;/home/node/cookies
      - EXECUTIONS_DATA_PRUNE=true
      - EXECUTIONS_DATA_MAX_AGE=168
      - EXECUTIONS_DATA_PRUNE_MAX_COUNT=2000
      - HTTP_PROXY=\${VS_HTTP_PROXY:-}
      - HTTPS_PROXY=\${VS_HTTP_PROXY:-}
      - NO_PROXY=localhost,127.0.0.1

volumes:
  n8n-data:
  work:
`;
}

/** A webhook token the backend accepts: 48 hex characters from the system's random source. */
export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readEnvValue(envText: string, key: string): string {
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return '';
}

function setEnvValue(envText: string, key: string, value: string): string {
  const lines = envText.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  return lines.join('\n');
}

export interface EnvPlan {
  text: string;
  token: string;
  port: number;
}

/**
 * The .env to write. An existing file is kept line for line: only a missing
 * token, port or image line is added, so a backend set up with the start script
 * keeps its token, its port and any keys it has.
 */
export function planEnv(
  existing: string | null,
  wanted: { port: number; timeZone: string; image?: string },
): EnvPlan {
  let text =
    existing ??
    [
      '# Video Summary backend. Written by the plugin; the model and keys are set in',
      '# Obsidian → Settings → Video Summary, not here.',
      '',
    ].join('\n');
  let token = readEnvValue(text, 'VS_WEBHOOK_TOKEN');
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
    token = newToken();
    text = setEnvValue(text, 'VS_WEBHOOK_TOKEN', token);
  }
  let port = Number(readEnvValue(text, 'VS_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = wanted.port;
    text = setEnvValue(text, 'VS_PORT', String(port));
  }
  if (existing === null) text = setEnvValue(text, 'TZ', wanted.timeZone);
  if (wanted.image && readEnvValue(text, 'VS_IMAGE') !== wanted.image) {
    text = setEnvValue(text, 'VS_IMAGE', wanted.image);
  }
  return { text: text.endsWith('\n') ? text : `${text}\n`, token, port };
}

export function connectionFor(port: number, token: string) {
  return {
    url: `http://127.0.0.1:${port}${BACKEND_WEBHOOK_PATH}`,
    headerName: DEFAULT_WEBHOOK_AUTH_HEADER,
    secret: token,
  };
}

/**
 * The script opened in Terminal for the one step the plugin leaves to the
 * person: downloading the backend image. It says what it will run and waits
 * for Return before running it.
 */
export function installScript(options: { chinese: boolean; update: boolean }): string {
  const say = options.chinese
    ? {
        title: options.update ? 'Video Summary：更新处理后端' : 'Video Summary：下载并启动处理后端',
        what: options.update
          ? '这一步会下载新版后端镜像（约 550 MB），然后用它重新启动后端。'
          : '这一步会下载后端镜像（约 550 MB），然后在这台电脑上启动它。',
        will: '将要运行：',
        go: '按回车开始，按 Ctrl-C 取消… ',
        noDocker:
          '没有找到 docker 命令。请先打开 OrbStack 或 Docker Desktop，等它显示运行中，再回到 Obsidian 重试。',
        pullFailed: '下载失败。检查网络后，回到 Obsidian 再点一次。',
        local: '下载不了，改用这台电脑上已有的同名镜像。',
        done: '后端已启动。回到 Obsidian，它会自己接着检查。这个窗口可以关了。',
        failed: '没有启动成功，上面是 Docker 给出的原因。',
      }
    : {
        title: options.update
          ? 'Video Summary: update the processing backend'
          : 'Video Summary: download and start the processing backend',
        what: options.update
          ? 'This downloads the new backend image (about 550 MB) and restarts the backend with it.'
          : 'This downloads the backend image (about 550 MB) and starts it on this computer.',
        will: 'It will run:',
        go: 'Press Return to start, or Ctrl-C to cancel… ',
        noDocker:
          'The docker command was not found. Open OrbStack or Docker Desktop, wait until it says running, then try again from Obsidian.',
        pullFailed:
          'The download failed. Check your network, then choose the button in Obsidian again.',
        local:
          'The download is not possible; using the image of the same name already on this computer.',
        done: 'The backend is running. Go back to Obsidian; it carries on by itself. You can close this window.',
        failed: 'It did not start. Docker gave the reason above.',
      };
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
# Written by the Video Summary plugin. Safe to delete; the plugin writes it again when needed.
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.orbstack/bin:$HOME/.docker/bin"
echo
echo ${quote(say.title)}
echo ${quote(say.what)}
echo
echo ${quote(say.will)}
echo '  docker compose pull && docker compose up -d'
echo
if ! command -v docker >/dev/null 2>&1; then
  echo ${quote(say.noDocker)}
  exit 1
fi
read -r -p ${quote(say.go)} _
echo
if ! docker compose --env-file .env pull; then
  image="$(docker compose --env-file .env config --images 2>/dev/null | head -n 1)"
  if [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1; then
    echo ${quote(say.local)}
  else
    echo
    echo ${quote(say.pullFailed)}
    exit 1
  fi
fi
if docker compose --env-file .env up -d; then
  echo
  echo ${quote(say.done)}
else
  echo
  echo ${quote(say.failed)}
  exit 1
fi
`;
}

export interface BackendFacts {
  docker: 'missing' | 'stopped' | 'running';
  /** The container bound to the webhook's port, if any. */
  container?: BackendContainer;
  /** The container runs the packaged backend, so the plugin can manage it. */
  bundled: boolean;
  /** Version tag of the packaged image the container was created from; '' when unknown. */
  imageVersion: string;
}

export async function backendFacts(run: RunCommand, port: number): Promise<BackendFacts> {
  const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: 6000,
  });
  if (info.notFound) return { docker: 'missing', bundled: false, imageVersion: '' };
  if (info.code !== 0) return { docker: 'stopped', bundled: false, imageVersion: '' };
  const container = (await locateContainer(run, port)) ?? undefined;
  const image = container?.image ?? '';
  return {
    docker: 'running',
    container,
    bundled: isBundledImage(image),
    imageVersion: bundledImageVersion(image),
  };
}

/** true when the running backend was made from an older image than this plugin version expects. */
export function backendOutdated(
  facts: BackendFacts,
  pluginVersion: string,
  override = '',
): boolean {
  if (!facts.bundled || !facts.container) return false;
  if (override.trim()) return facts.container.image !== override.trim();
  return !!facts.imageVersion && facts.imageVersion !== pluginVersion;
}

export type ApplyResult =
  | { ok: true }
  /** 'old-backend': the image predates settings-driven keys. */
  | { ok: false; reason: 'old-backend' | 'rejected' | 'failed'; detail?: string };

/**
 * Hands the model and keys to the backend container on standard input, so they
 * appear in no command line, no HTTP request and no n8n execution record, then
 * restarts the container so n8n loads them.
 */
export async function applyModelConfig(
  run: RunCommand,
  containerId: string,
  config: BackendModelConfig,
): Promise<ApplyResult> {
  const applied = await run(
    'docker',
    ['exec', '-i', containerId, 'node', '/opt/video-summary/init/configure.mjs', 'apply'],
    { timeoutMs: 30_000, input: JSON.stringify(config) },
  );
  if (applied.code !== 0) {
    const detail = applied.stderr
      .split(/\r?\n/)
      .map((line) => line.replace(/^\[video-summary\]\s*/, '').trim())
      .filter(Boolean)
      .pop();
    return {
      ok: false,
      reason: /must be|may contain|expects/.test(detail || '') ? 'rejected' : 'failed',
      detail,
    };
  }
  if (!/"applied":\s*true/.test(applied.stdout)) return { ok: false, reason: 'old-backend' };
  const restarted = await run('docker', ['restart', containerId], { timeoutMs: 60_000 });
  if (restarted.code !== 0) {
    return { ok: false, reason: 'failed', detail: restarted.stderr.trim().split(/\r?\n/).pop() };
  }
  return { ok: true };
}
