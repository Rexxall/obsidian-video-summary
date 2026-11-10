// Runs inside the container before n8n starts.
//
// Reads the mounted .env, writes the four n8n credentials, fills the per-install values into the
// bundled workflows, imports them and publishes them. Keys reach the n8n CLI through a temporary
// file that only the node user can read and that is deleted straight after the import; they are
// never printed. When nothing changed since the last start, the import is skipped.
//
// `configure.mjs apply` is how the Obsidian plugin hands over the model and keys chosen in its
// settings: it reads one JSON object from standard input and stores it next to n8n's own data,
// readable only by the node user. Values stored that way win over .env at the next start; .env
// stays the fallback, so a backend set up with the start script keeps working unchanged.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The two locations can be moved for tests; the image never sets these variables.
const CONFIG_FILE = process.env.VS_CONFIG_FILE || '/run/video-summary/config.env';
const WORKFLOW_DIR = '/opt/video-summary/workflows';
const STATE_DIR = process.env.VS_STATE_DIR || '/home/node/.n8n/video-summary';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const OVERRIDES_FILE = path.join(STATE_DIR, 'overrides.json');

const IDS = {
  main: 'vsMainWorkflow01',
  speech: 'vsSpeechToText01',
  webhook: 'vsWebhookToken01',
  chat: 'vsChatModel00001',
  speechKey: 'vsSpeechKey00001',
  visionKey: 'vsVisionKey00001',
};

export const DEFAULTS = {
  VS_CHAT_BASE_URL: 'https://api.deepseek.com',
  VS_CHAT_MODEL: 'deepseek-flash',
  VS_SPEECH_BASE_URL: 'https://api.siliconflow.cn/v1',
  VS_SPEECH_MODEL: 'FunAudioLLM/SenseVoiceSmall',
  VS_VISION_MODEL: 'Qwen/Qwen3-VL-8B-Instruct',
};

class ConfigError extends Error {}

function log(message) {
  process.stdout.write(`[video-summary] ${message}\n`);
}

export function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

function baseUrl(name, value) {
  const trimmed = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/.test(trimmed)) {
    throw new ConfigError(`${name} must be an http(s) address without spaces or quotes`);
  }
  return trimmed;
}

function modelName(name, value) {
  const trimmed = String(value || '').trim();
  if (!/^[A-Za-z0-9._:/@+-]{1,128}$/.test(trimmed)) {
    throw new ConfigError(`${name} may contain only letters, digits and . _ : / @ + -`);
  }
  return trimmed;
}

function apiKey(name, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed) || trimmed.length > 512) {
    throw new ConfigError(`${name} must be one line without spaces`);
  }
  return trimmed;
}

export function resolveConfig(env) {
  const token = String(env.VS_WEBHOOK_TOKEN || '').trim();
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
    throw new ConfigError(
      'VS_WEBHOOK_TOKEN is missing or too short. Start the backend with the start script, which creates it.',
    );
  }
  const speechBase = baseUrl(
    'VS_SPEECH_BASE_URL',
    env.VS_SPEECH_BASE_URL || DEFAULTS.VS_SPEECH_BASE_URL,
  );
  const speechKey = apiKey('VS_SPEECH_API_KEY', env.VS_SPEECH_API_KEY);
  return {
    token,
    chat: {
      base: baseUrl('VS_CHAT_BASE_URL', env.VS_CHAT_BASE_URL || DEFAULTS.VS_CHAT_BASE_URL),
      key: apiKey('VS_CHAT_API_KEY', env.VS_CHAT_API_KEY),
      model: modelName('VS_CHAT_MODEL', env.VS_CHAT_MODEL || DEFAULTS.VS_CHAT_MODEL),
    },
    speech: {
      base: speechBase,
      key: speechKey,
      model: modelName('VS_SPEECH_MODEL', env.VS_SPEECH_MODEL || DEFAULTS.VS_SPEECH_MODEL),
    },
    vision: {
      base: baseUrl('VS_VISION_BASE_URL', env.VS_VISION_BASE_URL || speechBase),
      key: apiKey('VS_VISION_API_KEY', env.VS_VISION_API_KEY) || speechKey,
      model: modelName('VS_VISION_MODEL', env.VS_VISION_MODEL || DEFAULTS.VS_VISION_MODEL),
    },
  };
}

const OVERRIDE_KEYS = {
  chat: { base: 'VS_CHAT_BASE_URL', model: 'VS_CHAT_MODEL', key: 'VS_CHAT_API_KEY' },
  speech: { base: 'VS_SPEECH_BASE_URL', model: 'VS_SPEECH_MODEL', key: 'VS_SPEECH_API_KEY' },
  vision: { base: 'VS_VISION_BASE_URL', model: 'VS_VISION_MODEL', key: 'VS_VISION_API_KEY' },
};

/**
 * Keeps only the fields the plugin may set, as non-empty strings. Anything else in the input
 * is dropped, so the stored file never holds more than base, model and key per service.
 */
export function cleanOverrides(input) {
  const clean = {};
  if (!input || typeof input !== 'object') return clean;
  for (const [part, fields] of Object.entries(OVERRIDE_KEYS)) {
    const source = input[part];
    if (!source || typeof source !== 'object') continue;
    for (const field of Object.keys(fields)) {
      const value = typeof source[field] === 'string' ? source[field].trim() : '';
      if (value) (clean[part] ??= {})[field] = value;
    }
  }
  return clean;
}

/** .env values with the plugin's choices laid over them; an empty choice leaves .env in place. */
export function mergeOverrides(env, overrides) {
  const merged = { ...env };
  const clean = cleanOverrides(overrides);
  for (const [part, fields] of Object.entries(OVERRIDE_KEYS)) {
    for (const [field, name] of Object.entries(fields)) {
      if (clean[part]?.[field]) merged[name] = clean[part][field];
    }
  }
  return merged;
}

function readOverrides() {
  try {
    return cleanOverrides(JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')));
  } catch {
    return {};
  }
}

function readMountedEnv() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new ConfigError(
      'The .env file is not mounted. Run the start script in the backend folder.',
    );
  }
  return parseEnv(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/**
 * `configure.mjs apply`: validates the JSON on standard input together with .env and stores it.
 * Prints one line of JSON without any key in it. The new values take effect at the next start
 * of the container, which the plugin triggers.
 */
function apply() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    throw new ConfigError('apply expects one JSON object on standard input');
  }
  const overrides = cleanOverrides(input);
  const config = resolveConfig(mergeOverrides(readMountedEnv(), overrides));
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${OVERRIDES_FILE}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(overrides), { mode: 0o600 });
  fs.renameSync(temp, OVERRIDES_FILE);
  process.stdout.write(`${JSON.stringify({ applied: true, ...publicStatus(config) })}\n`);
}

export function publicStatus(config) {
  const describe = (part) => ({
    configured: Boolean(part.key),
    model: part.model,
    host: new URL(part.base).host,
  });
  return {
    chat: describe(config.chat),
    speech: describe(config.speech),
    vision: describe(config.vision),
  };
}

export function fillWorkflow(workflow, config) {
  const replacements = [
    ['__VS_CHAT_BASE_URL__', config.chat.base],
    ['__VS_CHAT_MODEL__', config.chat.model],
    ['__VS_SPEECH_BASE_URL__', config.speech.base],
    ['__VS_SPEECH_MODEL__', config.speech.model],
    ['__VS_VISION_BASE_URL__', config.vision.base],
    ['__VS_VISION_MODEL__', config.vision.model],
    ['/* VS_BACKEND_CONFIG */ null', JSON.stringify(publicStatus(config))],
  ];
  const visit = (value) => {
    if (typeof value === 'string') {
      return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    }
    return value;
  };
  const filled = visit(workflow);
  filled.active = false;
  return filled;
}

export function buildCredentials(config) {
  // A missing key still gets a credential so the workflow imports cleanly; the setup check
  // then reports which key to add.
  const placeholder = 'not-configured';
  return [
    {
      id: IDS.webhook,
      name: 'Video Summary 口令',
      type: 'httpHeaderAuth',
      data: { name: 'X-Video-Summary-Token', value: config.token },
    },
    {
      id: IDS.chat,
      name: 'Video Summary 模型',
      type: 'openAiApi',
      data: { apiKey: config.chat.key || placeholder, url: config.chat.base },
    },
    {
      id: IDS.speechKey,
      name: 'Video Summary 语音转写',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${config.speech.key || placeholder}` },
    },
    {
      id: IDS.visionKey,
      name: 'Video Summary 识图',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: `Bearer ${config.vision.key || placeholder}` },
    },
  ];
}

function n8n(args) {
  const started = Date.now();
  const result = spawnSync('n8n', args, {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    env: { ...process.env, N8N_LOG_LEVEL: 'warn' },
  });
  log(`n8n ${args[0]} took ${Math.round((Date.now() - started) / 1000)}s`);
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`
      .trim()
      .split('\n')
      .slice(-12)
      .join('\n');
    throw new Error(`n8n ${args[0]} failed:\n${detail}`);
  }
}

function main() {
  const config = resolveConfig(mergeOverrides(readMountedEnv(), readOverrides()));
  const workflows = ['video-summary-speech.json', 'video-summary.json'].map((name) =>
    JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, name), 'utf8')),
  );

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ config, workflows }))
    .digest('hex');
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const previous = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  if (previous.fingerprint === fingerprint) {
    log('workflows and keys unchanged since the last start');
    return;
  }

  const status = publicStatus(config);
  for (const [label, part] of [
    ['model', status.chat],
    ['speech-to-text', status.speech],
    ['image reading', status.vision],
  ]) {
    log(`${label}: ${part.model} at ${part.host}${part.configured ? '' : ' (API key not set)'}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  try {
    const credentialFile = path.join(temp, 'credentials.json');
    fs.writeFileSync(credentialFile, JSON.stringify(buildCredentials(config)), { mode: 0o600 });
    // Importing over a published workflow queues the old version for re-publication, which then
    // answers webhooks for the first seconds after start. Unpublish first so only the new one runs.
    n8n(['unpublish:workflow', '--all']);
    n8n(['import:credentials', `--input=${credentialFile}`]);
    fs.rmSync(credentialFile, { force: true });

    const workflowFile = path.join(temp, 'workflows.json');
    fs.writeFileSync(
      workflowFile,
      JSON.stringify(workflows.map((workflow) => fillWorkflow(workflow, config))),
      { mode: 0o600 },
    );
    n8n(['import:workflow', `--input=${workflowFile}`]);
    for (const id of [IDS.speech, IDS.main]) n8n(['publish:workflow', `--id=${id}`]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ fingerprint, at: new Date().toISOString() }), {
    mode: 0o600,
  });
  log('credentials and workflows imported and published');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'apply') apply();
    else main();
  } catch (error) {
    process.stderr.write(
      `[video-summary] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
