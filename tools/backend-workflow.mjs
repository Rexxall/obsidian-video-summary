/**
 * The packaged backend: one model credential for every AI step, a bundled speech-to-text
 * workflow, a health branch the plugin's setup wizard reads, and a cookie upload branch.
 *
 * Everything here is deterministic so `upgrade-workflow-v3.mjs --check` can verify that the
 * committed workflow files match their generator. Values that differ per install (model names,
 * provider URLs, keys) are written by backend/init/configure.mjs when the container starts.
 */

export const BACKEND_WORKFLOW_VERSION = '3.1.0';

export const WORKFLOW_IDS = {
  main: 'vsMainWorkflow01',
  speech: 'vsSpeechToText01',
};

export const CREDENTIALS = {
  webhook: { id: 'vsWebhookToken01', name: 'Video Summary 口令', type: 'httpHeaderAuth' },
  chat: { id: 'vsChatModel00001', name: 'Video Summary 模型', type: 'openAiApi' },
  speech: { id: 'vsSpeechKey00001', name: 'Video Summary 语音转写', type: 'httpHeaderAuth' },
  vision: { id: 'vsVisionKey00001', name: 'Video Summary 识图', type: 'httpHeaderAuth' },
};

/** Visible defaults in the committed files; configure.mjs replaces them per install. */
export const PLACEHOLDERS = {
  chatModel: '__VS_CHAT_MODEL__',
  chatModelsUrl: '__VS_CHAT_BASE_URL__/models',
  speechUrl: '__VS_SPEECH_BASE_URL__/audio/transcriptions',
  speechModel: '__VS_SPEECH_MODEL__',
  visionUrl: '__VS_VISION_BASE_URL__/chat/completions',
  visionModel: '__VS_VISION_MODEL__',
};

/** The Health Report code carries this marker; configure.mjs swaps in non-secret settings. */
export const BACKEND_CONFIG_MARKER = '/* VS_BACKEND_CONFIG */ null';

export const NODE_NAMES = {
  model: 'Model: Chat',
  healthProbe: 'CMD: Health Probe',
  deepCheck: 'Switch: Deep Check',
  healthModels: 'Health: Chat Models',
  healthSpeech: 'Health: Speech to Text',
  healthReport: 'Code: Health Report',
  testResponse: 'Respond: Health Report',
  cookiePrepare: 'Code: Prepare Cookie File',
  cookieWrite: 'File: Write Cookies',
  cookieResponse: 'Respond: Cookies Saved',
  readDocument: 'File: Read Local Document',
  documentKind: 'Switch: Document Kind',
  pdfText: 'Extract PDF Text',
  documentsMerge: 'Merge: Documents',
  documentRequest: 'Code: Prepare Document Request',
  needsVision: 'Switch: Needs Vision',
  vision: 'Vision: Read Images',
  extractedText: 'Set: Extracted Text',
};

/** Old per-provider model branches, unused nodes and the Gemini-only image path. */
const REMOVED_NODES = [
  'AI Agent',
  'AI Agent2',
  'AI Agent3',
  'AI Agent4',
  'AI Agent5',
  'AI Agent7',
  'AI Agent8',
  'AI Agent9',
  'AI-Studio 3',
  'AI-Studio 3.',
  'AI-Studio 3.0',
  'AI-Studio 3.1',
  'Google Gemini 3',
  'Google Gemini 3.',
  'Google Gemini 3.1',
  'Google Gemini 3.2',
  'Google Gemini 3.3',
  'DeepSeek Chat Model',
  'Switch: Platform',
  'Error: Unsupported Platform',
  'Analyze video',
  'Code: Parse AI JSON Output & Manage Retries1',
  'Switch: AI Parse Retry ??',
  'Gemini Vision',
  'Code: Prepare Gemini Parts',
  'Read Binary File',
];

export const ACTIVE_AGENT_NAMES = ['AI: Write Note'];

export const COOKIE_PLATFORMS = {
  bilibili: ['bilibili.com', 'b23.tv', 'biligame.com', 'hdslb.com'],
  youtube: ['youtube.com', 'google.com', 'youtu.be'],
  douyin: ['douyin.com', 'iesdouyin.com', 'amemv.com'],
  tiktok: ['tiktok.com'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'xhscdn.com'],
};

function stableId(name) {
  // Deterministic UUID-shaped id so regeneration does not churn the file.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const char of `vs-backend:${name}`) {
    const code = char.codePointAt(0);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ (code + 0x9e37), 0x85ebca6b) >>> 0;
  }
  const hex = (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function functionBody(fn) {
  const source = fn.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim();
}

function program(fn) {
  return `(${fn.toString()})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });`;
}

function findNode(workflow, name) {
  return workflow.nodes.find((node) => node.name === name);
}

function requireNode(workflow, name) {
  const node = findNode(workflow, name);
  if (!node) throw new Error(`Workflow node not found: ${name}`);
  return node;
}

function upsertNode(workflow, node) {
  const index = workflow.nodes.findIndex((candidate) => candidate.name === node.name);
  const full = { id: stableId(node.name), ...node };
  if (index >= 0) {
    workflow.nodes[index] = { ...full, id: workflow.nodes[index].id || full.id };
  } else {
    workflow.nodes.push(full);
  }
}

function removeNode(workflow, name) {
  workflow.nodes = workflow.nodes.filter((node) => node.name !== name);
  delete workflow.connections[name];
  for (const kinds of Object.values(workflow.connections)) {
    for (const branches of Object.values(kinds)) {
      for (let index = 0; index < branches.length; index += 1) {
        branches[index] = (branches[index] || []).filter((edge) => edge.node !== name);
      }
    }
  }
}

function connect(workflow, from, outputs, kind = 'main') {
  workflow.connections[from] = workflow.connections[from] || {};
  workflow.connections[from][kind] = outputs.map((targets) =>
    targets.map((target) => {
      const [node, index = 0] = Array.isArray(target) ? target : [target, 0];
      return { node, type: kind, index };
    }),
  );
}

function stringRule(outputKey, leftValue, operation, rightValue = '') {
  const condition = {
    id: stableId(`rule:${outputKey}:${leftValue}`),
    leftValue,
    rightValue,
    operator:
      operation === 'equals'
        ? { type: 'string', operation: 'equals', name: 'filter.operator.equals' }
        : operation === 'regex'
          ? { type: 'string', operation: 'regex' }
          : { type: 'string', operation: 'notEmpty', singleValue: true },
  };
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [condition],
      combinator: 'and',
    },
    renameOutput: true,
    outputKey,
  };
}

/* ---------------------------------------------------------------- health probe (container) */

async function healthProbeProgram() {
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const deep = process.argv[1] === 'deep';

  const version = (binary, args) => {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 20000 });
    if (result.error || result.status !== 0) return '';
    return String(result.stdout || '')
      .split('\n')[0]
      .trim()
      .slice(0, 120);
  };
  const cookieState = (platform) => {
    const path = `/home/node/cookies/${platform}_cookies.txt`;
    try {
      const stat = fs.statSync(path);
      if (!stat.isFile() || stat.size === 0) return { present: false };
      const text = fs.readFileSync(path, 'utf8');
      const loginNames = {
        bilibili: 'SESSDATA',
        youtube: 'LOGIN_INFO',
        douyin: 'sessionid',
        tiktok: 'sessionid',
        xiaohongshu: 'web_session',
      };
      const lines = text.split('\n').filter((line) => line && !line.startsWith('#'));
      const loggedIn = lines.some((line) => line.split('\t')[5] === loginNames[platform]);
      return { present: true, cookies: lines.length, loggedIn, updated: stat.mtime.toISOString() };
    } catch {
      return { present: false };
    }
  };
  const writable = (dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const report = {
    tools: {
      ytDlp: version('yt-dlp', ['--version']),
      ffmpeg: version('ffmpeg', ['-hide_banner', '-version'])
        .replace(/^ffmpeg version\s*/, '')
        .split(' ')[0],
      node: process.version,
    },
    folders: {
      uploads: writable('/home/node/uploads'),
      cookies: writable('/home/node/cookies'),
      work: writable('/home/node/files'),
    },
    cookies: Object.fromEntries(
      ['bilibili', 'youtube', 'douyin', 'tiktok', 'xiaohongshu'].map((name) => [
        name,
        cookieState(name),
      ]),
    ),
    sample: '',
  };

  if (deep) {
    fs.mkdirSync('/home/node/files/health', { recursive: true });
    const sample = '/home/node/files/health/sample.mp3';
    const result = spawnSync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-ac',
        '1',
        '-ar',
        '16000',
        sample,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    report.sample = result.status === 0 ? sample : '';
    if (result.status !== 0) report.sampleError = String(result.stderr || '').slice(0, 300);
  }
  process.stdout.write(JSON.stringify(report));
}

export const HEALTH_PROBE_PROGRAM = program(healthProbeProgram);

/* ------------------------------------------------------------------ health report (Code) */

export function runHealthReportNode($input, $) {
  const backendConfig = /* VS_BACKEND_CONFIG */ null;
  const workflowMeta = '__VS_WORKFLOW_META__';
  const config = backendConfig || {
    chat: { configured: false, model: '', host: '' },
    speech: { configured: false, model: '', host: '' },
    vision: { configured: false, model: '', host: '' },
  };

  let probe = {};
  try {
    probe = JSON.parse(String($input.first().json.stdout || '{}'));
  } catch {
    probe = { error: 'health probe output was not JSON' };
  }

  const executed = (name) => {
    try {
      return $(name).isExecuted;
    } catch {
      return false;
    }
  };
  const describeHttpError = (item) => {
    const error = item?.json?.error;
    if (!error) return '';
    const raw = typeof error === 'string' ? error : error.message || JSON.stringify(error);
    return String(raw).slice(0, 300);
  };

  const chat = { ...config.chat, checked: false, ok: null, status: 0, error: '', available: [] };
  if (executed('Health: Chat Models')) {
    chat.checked = true;
    const item = $('Health: Chat Models').first();
    const status = Number(item.json.statusCode || 0);
    chat.status = status;
    const body = item.json.body && typeof item.json.body === 'object' ? item.json.body : item.json;
    const ids = Array.isArray(body?.data) ? body.data.map((model) => String(model.id || '')) : [];
    if (status >= 200 && status < 300) {
      chat.ok = true;
      chat.modelListed = ids.length === 0 ? null : ids.includes(config.chat.model);
      chat.available = ids.slice(0, 30);
    } else {
      chat.ok = false;
      chat.error = describeHttpError(item) || `HTTP ${status}`;
    }
  }

  const speech = { ...config.speech, checked: false, ok: null, error: '' };
  if (executed('Health: Speech to Text')) {
    speech.checked = true;
    const item = $('Health: Speech to Text').first();
    if (item.json.error) {
      speech.ok = false;
      speech.error = describeHttpError(item);
    } else {
      speech.ok = typeof item.json.full_transcript === 'string';
    }
  }

  return [
    {
      json: {
        ok: true,
        workflow: workflowMeta,
        backend: {
          tools: probe.tools || {},
          folders: probe.folders || {},
          cookies: probe.cookies || {},
          chat,
          speech,
          vision: { ...config.vision },
          sampleError: probe.sampleError || '',
        },
      },
    },
  ];
}

/* ---------------------------------------------------------------- cookie upload (Code) */

export function runPrepareCookieNode($input) {
  const domains = '__VS_COOKIE_DOMAINS__';
  const body = $input.first().json.body || {};
  const metadata = body.metadata || {};
  const platform = String(metadata.platform || '');
  if (!Object.prototype.hasOwnProperty.call(domains, platform)) {
    throw new Error('Unsupported cookie platform');
  }
  const text = String(metadata.cookies || '');
  if (!text || text.length > 512 * 1024) {
    throw new Error('Cookie text is empty or too large');
  }
  const allowed = domains[platform];
  const matchesPlatform = (domain) => {
    const bare = domain
      .replace(/^#HttpOnly_/, '')
      .replace(/^\./, '')
      .toLowerCase();
    return allowed.some((suffix) => bare === suffix || bare.endsWith(`.${suffix}`));
  };
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || (raw.startsWith('#') && !raw.startsWith('#HttpOnly_'))) continue;
    const fields = raw.split('\t');
    if (fields.length !== 7) throw new Error('Cookie text is not in Netscape cookies.txt format');
    const [domain, includeSubdomains, path, secure, expires, name, value] = fields;
    if (!matchesPlatform(domain)) continue;
    if (
      !/^(TRUE|FALSE)$/.test(includeSubdomains) ||
      !/^(TRUE|FALSE)$/.test(secure) ||
      !/^\d{1,12}$/.test(expires) ||
      !/^\/[\x21-\x7e]*$/.test(path) ||
      !/^[\x21-\x7e]{1,256}$/.test(name) ||
      !/^[\x20-\x7e]{0,4096}$/.test(value)
    ) {
      throw new Error('Cookie text contains an invalid line');
    }
    lines.push([domain, includeSubdomains, path, secure, expires, name, value].join('\t'));
  }
  if (lines.length === 0) throw new Error(`No ${platform} cookies were found in the upload`);
  const content = ['# Netscape HTTP Cookie File', ...lines, ''].join('\n');
  return [
    {
      json: {
        platform,
        count: lines.length,
        fileName: `/home/node/cookies/${platform}_cookies.txt`,
      },
      binary: {
        data: {
          data: Buffer.from(content, 'utf8').toString('base64'),
          mimeType: 'text/plain',
          fileName: `${platform}_cookies.txt`,
        },
      },
    },
  ];
}

/* ------------------------------------------------------- local images and PDFs (Code) */

/** Runs as an n8n Code node: `this.helpers` reads binary data stored on disk (n8n 2.x). */
export async function runPrepareDocumentRequestNode($input) {
  const visionModel = '__VS_VISION_MODEL__';
  const texts = [];
  const images = [];
  const items = $input.all();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item.json.text === 'string' && item.json.text.trim()) {
      texts.push(item.json.text.trim());
      continue;
    }
    const binary = item.binary?.data;
    if (binary && /^image\//.test(binary.mimeType || '')) {
      const buffer = await this.helpers.getBinaryDataBuffer(index, 'data');
      images.push({
        type: 'image_url',
        image_url: { url: `data:${binary.mimeType};base64,${buffer.toString('base64')}` },
      });
    }
  }
  if (texts.length === 0 && images.length === 0) {
    throw new Error(
      'No text was found in the file. A scanned PDF has no text layer: export its pages as images and send those instead.',
    );
  }
  const request = images.length
    ? {
        model: visionModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe all text in these images verbatim, in reading order. Do not add commentary.',
              },
              ...images,
            ],
          },
        ],
      }
    : null;
  return [{ json: { document_text: texts.join('\n\n'), vision_request: request } }];
}

/* ------------------------------------------------------------ speech-to-text workflow */

async function splitAudioProgram() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');

  const token = String(process.argv[1] || '');
  if (!/^[A-Za-z0-9._~%-]{1,4096}$/.test(token)) throw new Error('Audio path token is invalid');
  const requested = decodeURIComponent(token);
  if (!requested.startsWith('/') || /[\0\r\n]/.test(requested)) {
    throw new Error('Audio path must be absolute');
  }
  const roots = ['/home/node/files/', '/home/node/uploads/'];
  const real = fs.realpathSync(requested);
  const link = fs.lstatSync(requested);
  if (
    link.isSymbolicLink() ||
    !fs.statSync(real).isFile() ||
    !roots.some((root) => real.startsWith(root))
  ) {
    throw new Error('Audio file must be a regular file under the uploads or working folder');
  }

  const now = Date.now();
  for (const name of fs.readdirSync('/home/node/files')) {
    if (!/^stt-[a-f0-9]{12}$/.test(name)) continue;
    const dir = path.join('/home/node/files', name);
    if (now - fs.statSync(dir).mtimeMs > 6 * 60 * 60 * 1000)
      fs.rmSync(dir, { recursive: true, force: true });
  }

  const workdir = `/home/node/files/stt-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(workdir);
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', real],
    { encoding: 'utf8', timeout: 60000 },
  );
  const duration = Number.parseFloat(String(probe.stdout || '').trim()) || 0;
  const chunkSeconds = 600;
  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      real,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '48k',
      '-f',
      'segment',
      '-segment_time',
      String(chunkSeconds),
      '-reset_timestamps',
      '1',
      path.join(workdir, 'part-%03d.mp3'),
    ],
    { encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    fs.rmSync(workdir, { recursive: true, force: true });
    throw new Error(
      `ffmpeg could not read the audio: ${String(result.stderr || '').slice(0, 500)}`,
    );
  }
  const parts = fs
    .readdirSync(workdir)
    .filter((name) => /^part-\d{3}\.mp3$/.test(name))
    .sort()
    .map((name, index) => {
      const file = path.join(workdir, name);
      const size = fs.statSync(file).size;
      if (size > 45 * 1024 * 1024)
        throw new Error('An audio chunk exceeded the 45 MB upload limit');
      const start = index * chunkSeconds;
      const end = duration ? Math.min(duration, start + chunkSeconds) : start + chunkSeconds;
      return { path: file, index, start, end };
    });
  if (parts.length === 0) {
    fs.rmSync(workdir, { recursive: true, force: true });
    throw new Error('The file has no audio track');
  }
  process.stdout.write(JSON.stringify({ workdir, duration, parts }));
}

async function cleanUpProgram() {
  const fs = await import('node:fs');
  const dir = String(process.argv[1] || '');
  if (!/^\/home\/node\/files\/stt-[a-f0-9]{12}$/.test(dir))
    throw new Error('Refusing to remove that path');
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write('removed');
}

export const SPLIT_AUDIO_PROGRAM = program(splitAudioProgram);
export const CLEAN_UP_PROGRAM = program(cleanUpProgram);

export function runAudioPartsNode($input) {
  const parsed = JSON.parse(String($input.first().json.stdout || '{}'));
  if (!Array.isArray(parsed.parts) || parsed.parts.length === 0) {
    throw new Error('Audio splitting returned no parts');
  }
  return parsed.parts.map((part) => ({
    json: { ...part, workdir: parsed.workdir, duration: parsed.duration },
  }));
}

export function runJoinTranscriptNode($input, $) {
  const parts = $('Code: Audio Parts').all();
  const results = $input.all();
  const clean = (value) =>
    String(value || '')
      .replace(/<\|[^|>]*\|>/g, '')
      .replace(/\s+\n/g, '\n')
      .trim();
  const segments = results.map((item, index) => {
    const part = parts[index]?.json || {};
    const text = clean(item.json.text);
    return {
      id: `stt-${String(index + 1).padStart(3, '0')}`,
      start: Number(part.start) || 0,
      end: Number(part.end) || 0,
      text,
    };
  });
  return [
    {
      json: {
        workdir: parts[0]?.json.workdir || '',
        full_transcript: segments
          .map((segment) => segment.text)
          .filter(Boolean)
          .join('\n'),
        video_segments: segments.filter((segment) => segment.text),
        timing_quality: 'estimated',
        transcript_source: 'asr',
      },
    },
  ];
}

const splitCommand = `={{ (() => { const file = String($json.audio_file_path || ""); if (!file.startsWith("/home/node/")) { throw new Error("audio_file_path must be inside the container"); } const token = encodeURIComponent(file).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); return ${JSON.stringify(`node -e ${shellQuote(SPLIT_AUDIO_PROGRAM)} `)} + token; })() }}`;
const cleanUpCommand = `={{ (() => { const dir = String($json.workdir || ""); if (!/^\\/home\\/node\\/files\\/stt-[a-f0-9]{12}$/.test(dir)) { throw new Error("Unexpected working folder"); } return ${JSON.stringify(`node -e ${shellQuote(CLEAN_UP_PROGRAM)} `)} + dir; })() }}`;

export function buildSpeechWorkflow() {
  const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
    id: stableId(`speech:${name}`),
    name,
    type,
    typeVersion,
    position,
    parameters,
    ...extra,
  });
  const nodes = [
    node('Start', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 0], {
      workflowInputs: { values: [{ name: 'audio_file_path' }] },
    }),
    node('CMD: Split Audio', 'n8n-nodes-base.executeCommand', 1, [220, 0], {
      command: splitCommand,
    }),
    node('Code: Audio Parts', 'n8n-nodes-base.code', 2, [440, 0], {
      jsCode: functionBody(runAudioPartsNode),
    }),
    node('Read Audio Part', 'n8n-nodes-base.readWriteFile', 1, [660, 0], {
      fileSelector: '={{ $json.path }}',
      options: { dataPropertyName: 'data' },
    }),
    node(
      'Speech to Text',
      'n8n-nodes-base.httpRequest',
      4.2,
      [880, 0],
      {
        method: 'POST',
        url: PLACEHOLDERS.speechUrl,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [
            { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' },
            { name: 'model', value: PLACEHOLDERS.speechModel },
          ],
        },
        options: {
          batching: { batch: { batchSize: 1, batchInterval: 500 } },
          timeout: 300000,
        },
      },
      {
        credentials: {
          httpHeaderAuth: { id: CREDENTIALS.speech.id, name: CREDENTIALS.speech.name },
        },
        retryOnFail: true,
        maxTries: 3,
        waitBetweenTries: 3000,
      },
    ),
    node('Code: Join Transcript', 'n8n-nodes-base.code', 2, [1100, 0], {
      jsCode: functionBody(runJoinTranscriptNode),
    }),
    node('CMD: Clean Up', 'n8n-nodes-base.executeCommand', 1, [1320, 0], {
      command: cleanUpCommand,
    }),
    node('Set: Result', 'n8n-nodes-base.set', 3.4, [1540, 0], {
      assignments: {
        assignments: [
          ['full_transcript', 'string'],
          ['video_segments', 'array'],
          ['timing_quality', 'string'],
          ['transcript_source', 'string'],
        ].map(([name, type]) => ({
          id: stableId(`speech-result:${name}`),
          name,
          value: `={{ $('Code: Join Transcript').item.json.${name} }}`,
          type,
        })),
      },
      options: {},
    }),
  ];
  const chain = nodes.map((item) => item.name);
  const connections = {};
  for (let index = 0; index < chain.length - 1; index += 1) {
    connections[chain[index]] = { main: [[{ node: chain[index + 1], type: 'main', index: 0 }]] };
  }
  return {
    id: WORKFLOW_IDS.speech,
    name: 'Video Summary 语音转写',
    nodes,
    connections,
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
    meta: {
      videoSummaryWorkflow: {
        name: 'Video Summary 语音转写',
        version: BACKEND_WORKFLOW_VERSION,
        role: 'speech-to-text',
        chunkSeconds: 600,
      },
    },
    active: false,
  };
}

/* ------------------------------------------------------------------- main workflow */

export function workflowMeta() {
  return {
    name: 'Video Summary',
    version: BACKEND_WORKFLOW_VERSION,
    variant: 'packaged',
    webhookPath: 'obsidian-video-summary',
    models: [],
    requiredTools: ['yt-dlp', 'ffmpeg'],
    uploadsPath: '/home/node/uploads',
  };
}

/** Idempotent: applying it to its own output changes nothing. */
export function applyBackendLayout(workflow) {
  workflow.id = WORKFLOW_IDS.main;
  workflow.name = 'Video Summary';
  workflow.meta.videoSummaryWorkflow = {
    ...workflowMeta(),
    speechWorkflowId: WORKFLOW_IDS.speech,
  };

  for (const name of REMOVED_NODES) removeNode(workflow, name);

  // One model for every AI step.
  upsertNode(workflow, {
    name: NODE_NAMES.model,
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    typeVersion: 1.2,
    position: [-160, 560],
    parameters: {
      model: { __rl: true, mode: 'id', value: PLACEHOLDERS.chatModel },
      options: { temperature: 0.4, timeout: 600000, maxRetries: 2 },
    },
    credentials: { openAiApi: { id: CREDENTIALS.chat.id, name: CREDENTIALS.chat.name } },
  });
  connect(workflow, NODE_NAMES.model, [ACTIVE_AGENT_NAMES], 'ai_languageModel');

  // Model labels no longer pick a branch: transcript-only skips the model, everything else uses it.
  const operation = requireNode(workflow, 'Switch: Operation Mode');
  operation.parameters = {
    rules: {
      values: [
        stringRule(
          'Transcript',
          "={{ $('Webhook').item.json.body.metadata.mode }}",
          'equals',
          'transcript-only',
        ),
      ],
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'Summarize' },
  };
  connect(workflow, 'Switch: Operation Mode', [[['Merge: Result', 1]], ['AI: Write Note']]);

  const webhook = requireNode(workflow, 'Webhook');
  webhook.parameters.authentication = 'headerAuth';
  webhook.credentials = {
    httpHeaderAuth: { id: CREDENTIALS.webhook.id, name: CREDENTIALS.webhook.name },
  };
  webhook.notesInFlow = true;
  webhook.notes =
    'The backend package creates this Header Auth credential from VS_WEBHOOK_TOKEN in .env. Keep the port bound to 127.0.0.1.';

  for (const name of ['SubFlow: Transcript', 'SubFlow: Transcript from Local File']) {
    const subflow = requireNode(workflow, name);
    subflow.parameters.workflowId = {
      __rl: true,
      value: WORKFLOW_IDS.speech,
      mode: 'id',
      cachedResultName: 'Video Summary 语音转写',
    };
    subflow.parameters.options = { waitForSubWorkflow: true };
  }

  applyInputRouter(workflow);
  applyHealthBranch(workflow);
  applyCookieBranch(workflow);
  applyDocumentBranch(workflow);
  return workflow;
}

function applyInputRouter(workflow) {
  const router = requireNode(workflow, 'Switch: Input Type');
  const rules = router.parameters.rules.values;
  if (!rules.some((rule) => rule.outputKey === 'Cookies')) {
    rules.splice(1, 0, stringRule('Cookies', '={{ $json.body.name }}', 'equals', 'save-cookies'));
    workflow.connections['Switch: Input Type'].main.splice(1, 0, []);
  }
  const branches = workflow.connections['Switch: Input Type'].main;
  branches[0] = [{ node: NODE_NAMES.healthProbe, type: 'main', index: 0 }];
  branches[1] = [{ node: NODE_NAMES.cookiePrepare, type: 'main', index: 0 }];
}

function applyHealthBranch(workflow) {
  const probePrefix = `node -e ${shellQuote(HEALTH_PROBE_PROGRAM)} `;
  upsertNode(workflow, {
    name: NODE_NAMES.healthProbe,
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    position: [-2160, 160],
    parameters: {
      command: `={{ ${JSON.stringify(probePrefix)} + ($('Webhook').item.json.body.metadata?.check === "deep" ? "deep" : "basic") }}`,
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.deepCheck,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [-1940, 160],
    parameters: {
      rules: {
        values: [
          stringRule(
            'Deep',
            "={{ $('Webhook').item.json.body.metadata?.check || '' }}",
            'equals',
            'deep',
          ),
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Basic' },
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.healthModels,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [-1720, 80],
    parameters: {
      method: 'GET',
      url: PLACEHOLDERS.chatModelsUrl,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      options: {
        response: { response: { fullResponse: true, neverError: true } },
        timeout: 20000,
      },
    },
    credentials: { openAiApi: { id: CREDENTIALS.chat.id, name: CREDENTIALS.chat.name } },
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
  });
  upsertNode(workflow, {
    name: NODE_NAMES.healthSpeech,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position: [-1500, 80],
    parameters: {
      workflowId: {
        __rl: true,
        value: WORKFLOW_IDS.speech,
        mode: 'id',
        cachedResultName: 'Video Summary 语音转写',
      },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          audio_file_path: `={{ JSON.parse($('${NODE_NAMES.healthProbe}').item.json.stdout || '{}').sample || '' }}`,
        },
        matchingColumns: ['audio_file_path'],
        schema: [
          {
            id: 'audio_file_path',
            displayName: 'audio_file_path',
            required: false,
            defaultMatch: false,
            display: true,
            canBeUsedToMatch: true,
            type: 'string',
            removed: false,
          },
        ],
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: { waitForSubWorkflow: true },
    },
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
  });
  upsertNode(workflow, {
    name: NODE_NAMES.healthReport,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-1280, 160],
    parameters: {
      jsCode: functionBody(runHealthReportNode)
        .replace("'__VS_WORKFLOW_META__'", JSON.stringify(workflowMeta()))
        .replace(
          'probe = JSON.parse(String($input.first().json.stdout',
          `probe = JSON.parse(String($('${NODE_NAMES.healthProbe}').first().json.stdout`,
        ),
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.testResponse,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.2,
    position: [-1060, 160],
    parameters: { respondWith: 'firstIncomingItem', options: {} },
  });
  connect(workflow, NODE_NAMES.healthProbe, [[NODE_NAMES.deepCheck]]);
  connect(workflow, NODE_NAMES.deepCheck, [[NODE_NAMES.healthModels], [NODE_NAMES.healthReport]]);
  connect(workflow, NODE_NAMES.healthModels, [[NODE_NAMES.healthSpeech]]);
  connect(workflow, NODE_NAMES.healthSpeech, [[NODE_NAMES.healthReport]]);
  connect(workflow, NODE_NAMES.healthReport, [[NODE_NAMES.testResponse]]);
}

function applyCookieBranch(workflow) {
  upsertNode(workflow, {
    name: NODE_NAMES.cookiePrepare,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-2160, 400],
    parameters: {
      jsCode: functionBody(runPrepareCookieNode).replace(
        "'__VS_COOKIE_DOMAINS__'",
        JSON.stringify(COOKIE_PLATFORMS),
      ),
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.cookieWrite,
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1,
    position: [-1940, 400],
    parameters: {
      operation: 'write',
      fileName:
        '={{ "/home/node/cookies/" + ({ bilibili: "bilibili", youtube: "youtube", douyin: "douyin", tiktok: "tiktok", xiaohongshu: "xiaohongshu" })[$json.platform] + "_cookies.txt" }}',
      dataPropertyName: 'data',
      options: {},
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.cookieResponse,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.2,
    position: [-1720, 400],
    parameters: {
      respondWith: 'json',
      responseBody: `={{ JSON.stringify({ ok: true, platform: $('${NODE_NAMES.cookiePrepare}').item.json.platform, cookies: $('${NODE_NAMES.cookiePrepare}').item.json.count }) }}`,
      options: {},
    },
  });
  connect(workflow, NODE_NAMES.cookiePrepare, [[NODE_NAMES.cookieWrite]]);
  connect(workflow, NODE_NAMES.cookieWrite, [[NODE_NAMES.cookieResponse]]);
}

function applyDocumentBranch(workflow) {
  upsertNode(workflow, {
    name: NODE_NAMES.readDocument,
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1,
    position: [-1360, 432],
    parameters: {
      fileSelector: '={{ $json.audio_file_path_for_subflow }}',
      options: { dataPropertyName: 'data' },
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.documentKind,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [-1140, 432],
    parameters: {
      rules: {
        values: [
          stringRule(
            'PDF',
            '={{ String($json.fileExtension || "").toLowerCase() }}',
            'equals',
            'pdf',
          ),
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Image' },
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.pdfText,
    type: 'n8n-nodes-base.extractFromFile',
    typeVersion: 1,
    position: [-920, 352],
    parameters: { operation: 'pdf', binaryPropertyName: 'data', options: {} },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.documentsMerge,
    type: 'n8n-nodes-base.merge',
    typeVersion: 3.1,
    position: [-700, 432],
    parameters: {},
  });
  upsertNode(workflow, {
    name: NODE_NAMES.documentRequest,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-480, 432],
    parameters: { jsCode: functionBody(runPrepareDocumentRequestNode) },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.needsVision,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3.2,
    position: [-260, 432],
    parameters: {
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
              conditions: [
                {
                  id: stableId('rule:needs-vision'),
                  leftValue: '={{ $json.vision_request }}',
                  rightValue: '',
                  operator: { type: 'object', operation: 'notEmpty', singleValue: true },
                },
              ],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'Images',
          },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'Text only' },
    },
  });
  upsertNode(workflow, {
    name: NODE_NAMES.vision,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [-40, 352],
    parameters: {
      method: 'POST',
      url: PLACEHOLDERS.visionUrl,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ $json.vision_request }}',
      // Reasoning models can stall for minutes on an image; fail early with a clear error.
      options: { timeout: 120000 },
    },
    credentials: { httpHeaderAuth: { id: CREDENTIALS.vision.id, name: CREDENTIALS.vision.name } },
  });
  const extracted = requireNode(workflow, NODE_NAMES.extractedText);
  extracted.position = [180, 432];
  extracted.parameters = {
    assignments: {
      assignments: [
        {
          id: stableId('extracted:video_transcript'),
          name: 'video_transcript',
          value: `={{ [$('${NODE_NAMES.documentRequest}').item.json.document_text, $json.choices?.[0]?.message?.content].filter(Boolean).join("\\n\\n") }}`,
          type: 'string',
        },
        {
          id: stableId('extracted:transcript_source'),
          name: 'transcript_source',
          value: 'document',
          type: 'string',
        },
      ],
    },
    options: {},
  };
  connect(workflow, 'Code: Split Files', [[NODE_NAMES.readDocument]]);
  connect(workflow, NODE_NAMES.readDocument, [[NODE_NAMES.documentKind]]);
  connect(workflow, NODE_NAMES.documentKind, [
    [NODE_NAMES.pdfText],
    [[NODE_NAMES.documentsMerge, 1]],
  ]);
  connect(workflow, NODE_NAMES.pdfText, [[[NODE_NAMES.documentsMerge, 0]]]);
  connect(workflow, NODE_NAMES.documentsMerge, [[NODE_NAMES.documentRequest]]);
  connect(workflow, NODE_NAMES.documentRequest, [[NODE_NAMES.needsVision]]);
  connect(workflow, NODE_NAMES.needsVision, [[NODE_NAMES.vision], [NODE_NAMES.extractedText]]);
  connect(workflow, NODE_NAMES.vision, [[NODE_NAMES.extractedText]]);
}
