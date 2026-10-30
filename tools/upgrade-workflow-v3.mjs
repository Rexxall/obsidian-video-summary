#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACTIVE_AGENT_NAMES,
  BACKEND_WORKFLOW_VERSION,
  CREDENTIALS,
  NODE_NAMES,
  WORKFLOW_IDS,
  applyBackendLayout,
  buildSpeechWorkflow,
} from './backend-workflow.mjs';
import { NOTE_PROMPT_MARKER } from './note-prompt.mjs';
import { applyCanvasLayout, applyNoteStep, renameLegacyNodes } from './workflow-canvas.mjs';

const DEFAULT_WORKFLOW_PATH = fileURLToPath(
  new URL('../backend/workflows/video-summary.json', import.meta.url),
);
const DEFAULT_SPEECH_WORKFLOW_PATH = fileURLToPath(
  new URL('../backend/workflows/video-summary-speech.json', import.meta.url),
);

const ACTIVE_AI_AGENT_NAMES = ACTIVE_AGENT_NAMES;

const VIDEO_URL_SECURITY_MARKER = 'VIDEO_URL_SECURITY_V2';
const PUBLIC_WORKFLOW_VERSION = BACKEND_WORKFLOW_VERSION;
const URL_GLOBAL_LINE = "const URL = globalThis.URL || require('url').URL;";
const ALLOWED_LOCAL_FILE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.pdf',
  '.mp3',
  '.wav',
  '.m4a',
  '.mp4',
  '.webm',
];
const SAFE_LOCAL_FILE_EXPRESSION =
  '={{ (() => { const input = String($json.body.metadata.local_file || ""); const files = input.split(",").map((value) => value.trim()).filter(Boolean); const allowed = new Set([".jpg",".jpeg",".png",".webp",".pdf",".mp3",".wav",".m4a",".mp4",".webm"]); const isSafe = (file) => { const dot = file.lastIndexOf("."); const extension = dot >= 0 ? file.slice(dot).toLowerCase() : ""; return file.length <= 255 && /^[\\p{L}\\p{N}][\\p{L}\\p{N} ._-]*$/u.test(file) && allowed.has(extension); }; if (!files.length || files.some((file) => !isSafe(file))) { throw new Error("local_file must be a supported file name placed directly in the backend uploads folder"); } return files.length === 1 ? "/home/node/uploads/" + files[0] : ""; })() }}';
const TRANSCRIPT_SUBFLOW_NODE_NAMES = [
  'SubFlow: Transcript',
  'SubFlow: Transcript from Local File',
];
/** Traces of the author's own prompt (study-abroad applications, personal examples). */
const PRIVATE_PROFILE_PATTERNS = [
  /\*\*用户画像\*\*/,
  /针对[^\n]{0,80}定制/,
  /我的背景契合度/,
  /结合[^\n|]{0,80}背景分析/,
  /申请状态::/,
  /教育申请/,
  /光遗传学|内诺/,
  /第二大脑数字管家/,
  /导师特征分析/,
];

function functionBody(fn) {
  const source = fn.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim();
}

function buildPrepareDownloadCode() {
  return functionBody(runPrepareDownloadNode).replace(
    "'__MEDIA_RUNNER_PROGRAM__'",
    JSON.stringify(MEDIA_RUNNER_PROGRAM),
  );
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function buildMetadataCommandExpression() {
  const prefix = `node -e ${shellQuote(MEDIA_RUNNER_PROGRAM)} metadata `;
  return `={{ (() => { const token = String($json.video_url_token || ""); const platform = String($json.video_platform || ""); if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token) || !/^(youtube|bilibili|douyin|tiktok|xiaohongshu)$/.test(platform)) { throw new Error("Validated video URL token is missing or invalid"); } return ${JSON.stringify(prefix)} + token + " " + platform; })() }}`;
}

function ensureVideoValidationNode(workflow) {
  const name = 'Code: Validate Video URL';
  let node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    node = {
      parameters: { jsCode: functionBody(runValidateVideoUrlNode) },
      id: '41054a2a-a11a-42ea-a73c-e0b62dcd63e5',
      name,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-2496, 816],
      notesInFlow: true,
      notes:
        'Security boundary: validates HTTPS and the exact supported host allowlist before any command node.',
    };
    workflow.nodes.push(node);
  } else {
    node.parameters.jsCode = functionBody(runValidateVideoUrlNode);
    node.notesInFlow = true;
    node.notes =
      'Security boundary: validates HTTPS and the exact supported host allowlist before any command node.';
  }

  const webhookConnections = workflow.connections.Webhook?.main;
  if (!Array.isArray(webhookConnections)) {
    throw new Error('Webhook main connection is missing');
  }
  const alreadyRouted = webhookConnections.some((branch) =>
    branch.some((edge) => edge.node === name),
  );
  if (!alreadyRouted) {
    workflow.connections[name] = { main: structuredClone(webhookConnections) };
    workflow.connections.Webhook.main = [[{ node: name, type: 'main', index: 0 }]];
  }
}

function stableSegmentId(start, end, text) {
  const startMs = Math.round(start * 1000);
  const input = `${startMs}|${Math.round(end * 1000)}|${text}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `seg-${startMs}-${(hash >>> 0).toString(36)}`;
}

/**
 * Validate all incoming link requests before they can reach an Execute Command
 * node. The normalized URL and an opaque base64url token are carried forward;
 * raw webhook input is never interpolated into a shell command.
 */
export function runValidateVideoUrlNode($input) {
  const items = $input.all();

  // VIDEO_URL_SECURITY_V2
  const hostGroups = {
    youtube: new Set([
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
    ]),
    bilibili: new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv']),
    douyin: new Set([
      'douyin.com',
      'www.douyin.com',
      'v.douyin.com',
      'iesdouyin.com',
      'www.iesdouyin.com',
    ]),
    tiktok: new Set([
      'tiktok.com',
      'www.tiktok.com',
      'm.tiktok.com',
      'vm.tiktok.com',
      'vt.tiktok.com',
    ]),
    xiaohongshu: new Set([
      'xiaohongshu.com',
      'www.xiaohongshu.com',
      'xhslink.com',
      'www.xhslink.com',
      'xhs.cn',
      'www.xhs.cn',
    ]),
  };
  const redirectHosts = new Set([
    'b23.tv',
    'v.douyin.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'xhslink.com',
    'www.xhslink.com',
    'xhs.cn',
    'www.xhs.cn',
  ]);

  function canonicalizePlatformUrl(parsed, platform, hostname) {
    if (redirectHosts.has(hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (
        parts.length < 1 ||
        parts.length > 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]{1,128}$/.test(part))
      ) {
        throw new Error('Video short-link path is invalid');
      }
      return `https://${hostname}/${parts.join('/')}`;
    }

    if (platform === 'youtube') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const id =
        hostname === 'youtu.be'
          ? parts[0]
          : parsed.pathname === '/watch'
            ? parsed.searchParams.get('v')
            : ['shorts', 'live', 'embed'].includes(parts[0])
              ? parts[1]
              : '';
      if (!id || !/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
        throw new Error('YouTube URL does not contain a valid video id');
      }
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }

    if (platform === 'bilibili') {
      const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i);
      if (!match) throw new Error('Bilibili URL must use a BV video path');
      const page = parsed.searchParams.get('p');
      if (page && !/^[1-9]\d{0,3}$/.test(page)) throw new Error('Bilibili page is invalid');
      return `https://www.bilibili.com/video/${match[1]}${page ? `?p=${page}` : ''}`;
    }

    if (platform === 'douyin') {
      const match = parsed.pathname.match(/^\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('Douyin URL must use a video id path');
      return `https://www.douyin.com/video/${match[1]}`;
    }

    if (platform === 'tiktok') {
      const match = parsed.pathname.match(/^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('TikTok URL must use an author/video id path');
      return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    }

    if (platform === 'xiaohongshu') {
      const match = parsed.pathname.match(
        /^\/(?:explore|discovery\/item)\/([A-Fa-f0-9]{8,64})(?:\/|$)/,
      );
      if (!match) throw new Error('Xiaohongshu URL must use an explore/item id path');
      return `https://www.xiaohongshu.com/explore/${match[1]}`;
    }

    throw new Error('Unsupported video platform');
  }

  function validateVideoUrl(value) {
    const raw = String(value ?? '');
    if (
      !raw ||
      raw.length > 2048 ||
      [...raw].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)
    ) {
      throw new Error('Video URL is empty, too long, or contains control characters');
    }

    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      throw new Error('Video URL is invalid');
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      throw new Error('Video URL must use HTTPS without credentials or a custom port');
    }

    const hostname = parsed.hostname.toLowerCase();
    const platform = Object.entries(hostGroups).find(([, hosts]) => hosts.has(hostname))?.[0];
    if (!platform) {
      throw new Error(`Video URL hostname is not allowed: ${hostname || '(empty)'}`);
    }

    return { url: canonicalizePlatformUrl(parsed, platform, hostname), platform };
  }

  for (const item of items) {
    const metadata = item.json?.body?.metadata;
    const rawLink = metadata?.link;
    if (rawLink === undefined || rawLink === null || String(rawLink) === '') continue;

    const validated = validateVideoUrl(rawLink);
    item.json.body.metadata.link = validated.url;
    item.json.validated_video_url = validated.url;
    item.json.video_platform = validated.platform;
    item.json.video_url_token = Buffer.from(validated.url, 'utf8').toString('base64url');
  }

  return items;
}

/**
 * A fixed child program used by every media-related Execute Command node. The
 * only dynamic URL input is a base64url token. The child validates it again and
 * invokes yt-dlp with an argument array (never a constructed shell fragment).
 */
async function mediaCommandRunner() {
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');

  const action = process.argv[1];
  const token = process.argv[2];
  const claimedPlatform = process.argv[3];
  const stem = process.argv[4] || '';

  const hostGroups = {
    youtube: new Set([
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
    ]),
    bilibili: new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv']),
    douyin: new Set([
      'douyin.com',
      'www.douyin.com',
      'v.douyin.com',
      'iesdouyin.com',
      'www.iesdouyin.com',
    ]),
    tiktok: new Set([
      'tiktok.com',
      'www.tiktok.com',
      'm.tiktok.com',
      'vm.tiktok.com',
      'vt.tiktok.com',
    ]),
    xiaohongshu: new Set([
      'xiaohongshu.com',
      'www.xiaohongshu.com',
      'xhslink.com',
      'www.xhslink.com',
      'xhs.cn',
      'www.xhs.cn',
    ]),
  };
  const shortHosts = new Set([
    'b23.tv',
    'v.douyin.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'xhslink.com',
    'www.xhslink.com',
    'xhs.cn',
    'www.xhs.cn',
  ]);
  const cookiePaths = {
    youtube: '/home/node/cookies/youtube_cookies.txt',
    bilibili: '/home/node/cookies/bilibili_cookies.txt',
    douyin: '/home/node/cookies/douyin_cookies.txt',
    tiktok: '/home/node/cookies/tiktok_cookies.txt',
    xiaohongshu: '/home/node/cookies/xiaohongshu_cookies.txt',
  };

  function canonicalizePlatformUrl(parsed, platform, hostname) {
    if (shortHosts.has(hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (
        parts.length < 1 ||
        parts.length > 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]{1,128}$/.test(part))
      ) {
        throw new Error('Video short-link path is invalid');
      }
      return `https://${hostname}/${parts.join('/')}`;
    }

    if (platform === 'youtube') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const id =
        hostname === 'youtu.be'
          ? parts[0]
          : parsed.pathname === '/watch'
            ? parsed.searchParams.get('v')
            : ['shorts', 'live', 'embed'].includes(parts[0])
              ? parts[1]
              : '';
      if (!id || !/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
        throw new Error('YouTube URL does not contain a valid video id');
      }
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }

    if (platform === 'bilibili') {
      const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i);
      if (!match) throw new Error('Bilibili URL must use a BV video path');
      const page = parsed.searchParams.get('p');
      if (page && !/^[1-9]\d{0,3}$/.test(page)) throw new Error('Bilibili page is invalid');
      return `https://www.bilibili.com/video/${match[1]}${page ? `?p=${page}` : ''}`;
    }

    if (platform === 'douyin') {
      const match = parsed.pathname.match(/^\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('Douyin URL must use a video id path');
      return `https://www.douyin.com/video/${match[1]}`;
    }

    if (platform === 'tiktok') {
      const match = parsed.pathname.match(/^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('TikTok URL must use an author/video id path');
      return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    }

    if (platform === 'xiaohongshu') {
      const match = parsed.pathname.match(
        /^\/(?:explore|discovery\/item)\/([A-Fa-f0-9]{8,64})(?:\/|$)/,
      );
      if (!match) throw new Error('Xiaohongshu URL must use an explore/item id path');
      return `https://www.xiaohongshu.com/explore/${match[1]}`;
    }

    throw new Error('Unsupported video platform');
  }

  function validateVideoUrl(value, expectedPlatform = '') {
    const raw = String(value ?? '');
    if (
      !raw ||
      raw.length > 2048 ||
      [...raw].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)
    ) {
      throw new Error('Video URL is empty, too long, or contains control characters');
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      throw new Error('Video URL is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      throw new Error('Video URL must use HTTPS without credentials or a custom port');
    }
    const hostname = parsed.hostname.toLowerCase();
    const platform = Object.entries(hostGroups).find(([, hosts]) => hosts.has(hostname))?.[0];
    if (!platform || (expectedPlatform && platform !== expectedPlatform)) {
      throw new Error(`Video URL hostname is not allowed for ${expectedPlatform || 'media'}`);
    }
    return {
      url: canonicalizePlatformUrl(parsed, platform, hostname),
      platform,
      hostname,
    };
  }

  function decodeToken(value) {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(String(value || ''))) {
      throw new Error('Video URL token is invalid');
    }
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const canonical = Buffer.from(decoded, 'utf8').toString('base64url');
    if (canonical !== value) throw new Error('Video URL token is not canonical');
    return decoded;
  }

  async function resolveRestrictedRedirects(input, platform) {
    let current = validateVideoUrl(input, platform);
    for (let count = 0; count < 5; count += 1) {
      // Canonical links are already final. Following them can loop: Bilibili redirects
      // /video/BV… to /video/BV…/, which canonicalisation turns back into the first URL.
      if (!shortHosts.has(current.hostname)) return current.url;
      const response = await fetch(current.url, {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0',
          range: 'bytes=0-0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      if (response.body) await response.body.cancel().catch(() => {});

      if (response.status < 300 || response.status >= 400) {
        if (shortHosts.has(current.hostname)) {
          throw new Error('Video short link did not resolve to a canonical platform URL');
        }
        return current.url;
      }
      const location = response.headers.get('location');
      if (!location) throw new Error('Short-link redirect did not include a location');
      current = validateVideoUrl(new URL(location, current.url).toString(), platform);
    }
    throw new Error('Short-link redirect limit exceeded');
  }

  function run(binary, args, options = {}) {
    const result = spawnSync(binary, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      timeout: options.timeout || 5 * 60 * 1000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
      const detail = String(result.stderr || result.stdout || '')
        .trim()
        .slice(0, 4000);
      throw new Error(`${binary} failed with exit code ${result.status}: ${detail}`);
    }
    return result;
  }

  function platformArgs(platform) {
    const args = [];
    const cookiePath = cookiePaths[platform];
    if (cookiePath && fs.existsSync(cookiePath) && fs.statSync(cookiePath).size > 0) {
      args.push('--cookies', cookiePath);
    }
    if (platform === 'bilibili') {
      args.push(
        '--user-agent',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        '--referer',
        'https://www.bilibili.com/',
        '--add-header',
        'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      );
    }
    return args;
  }

  function cleanLine(value) {
    return String(value ?? '')
      .split(String.fromCharCode(0))
      .join(' ')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }

  async function bilibiliMetadata(link) {
    let match = link.match(/BV[0-9A-Za-z]+/i);
    if (!match) throw new Error('Bilibili video id not found after restricted redirect resolution');
    const bvid = match[0];
    const endpoint = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const response = await fetch(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        referer: 'https://www.bilibili.com/',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Bilibili metadata HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== 0 || !payload.data) {
      throw new Error(payload.message || 'Bilibili metadata request failed');
    }
    const data = payload.data;
    process.stdout.write(
      [
        cleanLine(data.title),
        cleanLine(data.owner?.name),
        cleanLine(data.duration),
        cleanLine(data.pic).replace(/^http:/, 'https:'),
        'BiliBili',
      ].join('\n') + '\n',
    );
  }

  function normalizeLanguage(code) {
    return String(code || '')
      .trim()
      .replace(/_/g, '-')
      .replace(/^zh-hans$/i, 'zh-CN')
      .replace(/^zh-hant$/i, 'zh-TW');
  }

  function languageBase(code) {
    const normalized = normalizeLanguage(code).toLowerCase();
    if (normalized.startsWith('zh')) return 'zh';
    if (normalized.startsWith('ja') || normalized === 'jp') return 'ja';
    if (normalized.startsWith('en')) return 'en';
    return normalized.split('-')[0] || '';
  }

  // Bilibili: uploader subtitles first, then Bilibili's own AI subtitles (ai-zh and other ai-*,
  // which need a logged-in cookie). Danmaku is not a transcript. Returns one exact track name.
  function selectBilibiliSubtitle(info) {
    const tracks = Object.keys(info.subtitles || {}).filter(
      (key) => key && key !== 'danmaku' && key !== 'live_chat',
    );
    const rank = (key) => {
      const lower = key.toLowerCase();
      if (!lower.startsWith('ai-') && lower.startsWith('zh')) return 0;
      if (lower === 'ai-zh') return 1;
      if (lower.startsWith('ai-')) return 3;
      return 2;
    };
    return tracks.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] || '';
  }

  function selectSubtitleLanguages(info) {
    if (validated.platform === 'bilibili') return selectBilibiliSubtitle(info);
    const keys = (object) => Object.keys(object || {}).filter((key) => key && key !== 'live_chat');
    const manual = keys(info.subtitles);
    const automatic = keys(info.automatic_captions);
    const all = [...manual, ...automatic];
    const hints = [];
    const addHint = (value) => {
      const normalized = normalizeLanguage(value);
      if (normalized && !hints.includes(normalized)) hints.push(normalized);
    };
    [
      info.language,
      info.original_language,
      info.audio_language,
      info.default_audio_language,
      info.track_language,
    ].forEach(addHint);
    for (const format of info.formats || []) {
      if (format?.language && (format.vcodec === 'none' || format.acodec !== 'none')) {
        addHint(format.language);
      }
    }
    const patternsFor = (language) => {
      const base = languageBase(language);
      if (base === 'zh') return ['zh', 'zh-CN', 'zh-TW', 'zh-Hans', 'zh-Hant', 'zh.*'];
      if (base === 'ja') return ['ja', 'ja.*'];
      if (base === 'en') return ['en', 'en.*'];
      const normalized = normalizeLanguage(language);
      return [normalized, base ? `${base}.*` : ''].filter(Boolean);
    };
    const availableFor = (hint) =>
      all.filter(
        (key) =>
          normalizeLanguage(key).toLowerCase() === normalizeLanguage(hint).toLowerCase() ||
          languageBase(key) === languageBase(hint),
      );
    for (const hint of hints) {
      if (availableFor(hint).length > 0) return patternsFor(hint).join(',');
    }
    const allBases = [...new Set(all.map(languageBase).filter(Boolean))];
    if (allBases.length === 1) return patternsFor(allBases[0]).join(',');
    const manualBases = [...new Set(manual.map(languageBase).filter(Boolean))];
    if (manual.length > 0 && manualBases.length === 1) {
      return patternsFor(manualBases[0]).join(',');
    }
    return '';
  }

  if (!['metadata', 'audio', 'subtitles'].includes(action)) {
    throw new Error('Unsupported media action');
  }
  if (!hostGroups[claimedPlatform]) throw new Error('Claimed media platform is invalid');
  if (action !== 'metadata' && !/^[A-Za-z0-9_-]{1,96}$/.test(stem)) {
    throw new Error('Media output stem is invalid');
  }

  // Downloaded audio and subtitles are only needed during their own job; drop day-old ones.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync('/home/node/files')) {
    if (!/^(?:audio|subtitle)_[A-Za-z0-9_-]+\.[A-Za-z0-9.-]+$/.test(name)) continue;
    const file = `/home/node/files/${name}`;
    try {
      if (fs.statSync(file).mtimeMs < dayAgo) fs.rmSync(file, { force: true });
    } catch {
      // another job may have removed it already
    }
  }

  const decoded = decodeToken(token);
  const validated = validateVideoUrl(decoded, claimedPlatform);
  const link = await resolveRestrictedRedirects(validated.url, validated.platform);
  const commonArgs = [
    '--ignore-config',
    // YouTube needs a JavaScript runtime for its player challenges; node is in the image.
    '--js-runtimes',
    'node',
    '--no-playlist',
    '--socket-timeout',
    '20',
    ...platformArgs(validated.platform),
  ];

  if (action === 'metadata') {
    if (validated.platform === 'bilibili') {
      try {
        await bilibiliMetadata(link);
        return;
      } catch {
        // The public view API answers 412 to unsigned requests at times; yt-dlp signs its own.
      }
    }
    const result = run(
      'yt-dlp',
      [
        ...commonArgs,
        '--print',
        '%(title)s',
        '--print',
        '%(uploader)s',
        '--print',
        '%(duration_string)s',
        '--print',
        '%(thumbnail)s',
        '--print',
        '%(extractor_key)s',
        link,
      ],
      { timeout: 2 * 60 * 1000 },
    );
    process.stdout.write(result.stdout);
    return;
  }

  if (action === 'audio') {
    const outputTemplate = `/home/node/files/${stem}.%(ext)s`;
    const result = run(
      'yt-dlp',
      [
        ...commonArgs,
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '64K',
        '--force-overwrites',
        '--output',
        outputTemplate,
        link,
      ],
      { timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout || `/home/node/files/${stem}.mp3\n`);
    return;
  }

  if (!['youtube', 'bilibili'].includes(validated.platform)) {
    process.stdout.write(`__NATIVE_SUBTITLE_SKIPPED__=${validated.platform}\n`);
    return;
  }

  for (const name of fs.readdirSync('/home/node/files')) {
    if (name.startsWith(`${stem}.`) && /\.(?:srt|vtt|json3)$/i.test(name)) {
      fs.rmSync(`/home/node/files/${name}`, { force: true });
    }
  }
  const metadataResult = run(
    'yt-dlp',
    // Bilibili lists subtitles only when they are asked for; the flags write nothing here.
    [
      ...commonArgs,
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--dump-single-json',
      link,
    ],
    { allowFailure: true, timeout: 2 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (metadataResult.status !== 0) {
    process.stdout.write('__NATIVE_SUBTITLE_UNCERTAIN_ORIGINAL_LANGUAGE__=1\n');
    process.stdout.write(String(metadataResult.stderr || '').slice(0, 4000));
    return;
  }

  let info;
  try {
    info = JSON.parse(metadataResult.stdout);
  } catch (_error) {
    process.stdout.write('__NATIVE_SUBTITLE_UNCERTAIN_ORIGINAL_LANGUAGE__=1\n');
    return;
  }
  const languages = selectSubtitleLanguages(info);
  if (!languages) {
    process.stdout.write('__NATIVE_SUBTITLE_UNCERTAIN_ORIGINAL_LANGUAGE__=1\n');
    return;
  }
  process.stdout.write(`__NATIVE_SUBTITLE_LANGS__=${languages}\n`);

  const subtitleResult = run(
    'yt-dlp',
    [
      ...commonArgs,
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      languages,
      '--sub-format',
      'srt/vtt/best',
      '--convert-subs',
      'srt',
      '--output',
      `/home/node/files/${stem}.%(ext)s`,
      link,
    ],
    { allowFailure: true, timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
  );
  const subtitleName = fs
    .readdirSync('/home/node/files')
    .filter((name) => name.startsWith(`${stem}.`) && /\.(?:srt|vtt)$/i.test(name))
    .sort()[0];
  if (!subtitleName) {
    process.stdout.write('__NATIVE_SUBTITLE_MISSING__=1\n');
    process.stdout.write(String(subtitleResult.stderr || '').slice(0, 4000));
    return;
  }
  const subtitlePath = `/home/node/files/${subtitleName}`;
  process.stdout.write(`__NATIVE_SUBTITLE_FILE__=${subtitlePath}\n`);
  process.stdout.write(fs.readFileSync(subtitlePath, 'utf8'));
}

const MEDIA_RUNNER_PROGRAM = `(${mediaCommandRunner.toString()})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });`;

/**
 * Prepare fixed runner commands for the download and native-subtitle branches.
 * User-controlled URL text is represented only by a validated base64url token.
 */
export function runPrepareDownloadNode($input) {
  const items = $input.all();
  const newItems = [];
  const mediaRunnerProgram = '__MEDIA_RUNNER_PROGRAM__';

  // VIDEO_URL_SECURITY_V2
  const hostGroups = {
    youtube: new Set([
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
    ]),
    bilibili: new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv']),
    douyin: new Set([
      'douyin.com',
      'www.douyin.com',
      'v.douyin.com',
      'iesdouyin.com',
      'www.iesdouyin.com',
    ]),
    tiktok: new Set([
      'tiktok.com',
      'www.tiktok.com',
      'm.tiktok.com',
      'vm.tiktok.com',
      'vt.tiktok.com',
    ]),
    xiaohongshu: new Set([
      'xiaohongshu.com',
      'www.xiaohongshu.com',
      'xhslink.com',
      'www.xhslink.com',
      'xhs.cn',
      'www.xhs.cn',
    ]),
  };
  const redirectHosts = new Set([
    'b23.tv',
    'v.douyin.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'xhslink.com',
    'www.xhslink.com',
    'xhs.cn',
    'www.xhs.cn',
  ]);

  function canonicalizePlatformUrl(parsed, platform, hostname) {
    if (redirectHosts.has(hostname)) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (
        parts.length < 1 ||
        parts.length > 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]{1,128}$/.test(part))
      ) {
        throw new Error('Video short-link path is invalid');
      }
      return `https://${hostname}/${parts.join('/')}`;
    }

    if (platform === 'youtube') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const id =
        hostname === 'youtu.be'
          ? parts[0]
          : parsed.pathname === '/watch'
            ? parsed.searchParams.get('v')
            : ['shorts', 'live', 'embed'].includes(parts[0])
              ? parts[1]
              : '';
      if (!id || !/^[A-Za-z0-9_-]{6,32}$/.test(id)) {
        throw new Error('YouTube URL does not contain a valid video id');
      }
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }

    if (platform === 'bilibili') {
      const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i);
      if (!match) throw new Error('Bilibili URL must use a BV video path');
      const page = parsed.searchParams.get('p');
      if (page && !/^[1-9]\d{0,3}$/.test(page)) throw new Error('Bilibili page is invalid');
      return `https://www.bilibili.com/video/${match[1]}${page ? `?p=${page}` : ''}`;
    }

    if (platform === 'douyin') {
      const match = parsed.pathname.match(/^\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('Douyin URL must use a video id path');
      return `https://www.douyin.com/video/${match[1]}`;
    }

    if (platform === 'tiktok') {
      const match = parsed.pathname.match(/^\/@([A-Za-z0-9._-]{1,64})\/video\/(\d{8,32})(?:\/|$)/);
      if (!match) throw new Error('TikTok URL must use an author/video id path');
      return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    }

    if (platform === 'xiaohongshu') {
      const match = parsed.pathname.match(
        /^\/(?:explore|discovery\/item)\/([A-Fa-f0-9]{8,64})(?:\/|$)/,
      );
      if (!match) throw new Error('Xiaohongshu URL must use an explore/item id path');
      return `https://www.xiaohongshu.com/explore/${match[1]}`;
    }

    throw new Error('Unsupported video platform');
  }

  function validateVideoUrl(value) {
    const raw = String(value ?? '');
    if (
      !raw ||
      raw.length > 2048 ||
      [...raw].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)
    ) {
      throw new Error('Video URL is empty, too long, or contains control characters');
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      throw new Error('Video URL is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      throw new Error('Video URL must use HTTPS without credentials or a custom port');
    }
    const hostname = parsed.hostname.toLowerCase();
    const platform = Object.entries(hostGroups).find(([, hosts]) => hosts.has(hostname))?.[0];
    if (!platform) throw new Error(`Video URL hostname is not allowed: ${hostname}`);
    return { url: canonicalizePlatformUrl(parsed, platform, hostname), platform };
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function buildCommand(action, token, platform, stem) {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token)) throw new Error('Invalid URL token');
    if (!/^[a-z]+$/.test(platform)) throw new Error('Invalid platform token');
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(stem)) throw new Error('Invalid media stem');
    return ['node', '-e', shellQuote(mediaRunnerProgram), action, token, platform, stem].join(' ');
  }

  for (const item of items) {
    const validated = validateVideoUrl(item.json.video_link);
    const token = Buffer.from(validated.url, 'utf8').toString('base64url');
    const videoId = `${Date.now()}${Math.random().toString(36).slice(2, 15)}`;
    const audioStem = `audio_${videoId}`;
    const subtitleStem = `subtitle_${videoId}`;

    item.json.video_link = validated.url;
    item.json.platform = validated.platform;
    item.json.video_url_token = token;
    item.json.ytdlp_command = buildCommand('audio', token, validated.platform, audioStem);
    item.json.native_subtitle_command = buildCommand(
      'subtitles',
      token,
      validated.platform,
      subtitleStem,
    );
    item.json.expected_audio_file_path = `/home/node/files/${audioStem}.mp3`;
    item.json.video_id_for_filename = videoId;
    newItems.push(item);
  }

  return newItems;
}

/**
 * This function body is copied verbatim into the n8n Code node. Keep it
 * dependency-free so the same implementation can run in both n8n and tests.
 */
export function runNativeSubtitleNode($input, $) {
  const items = $input.all();

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  function cleanCueText(lines) {
    const cleaned = [];
    for (const line of lines) {
      const text = decodeEntities(line)
        .replace(/<[^>]+>/g, '')
        .replace(/\{\\[^}]+\}/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || cleaned[cleaned.length - 1] === text) continue;
      cleaned.push(text);
    }
    return cleaned.join(' ').trim();
  }

  function parseTimestamp(value) {
    const parts = String(value || '')
      .replace(',', '.')
      .split(':')
      .map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return null;
  }

  function makeSegmentId(start, end, text) {
    const startMs = Math.round(start * 1000);
    const input = `${startMs}|${Math.round(end * 1000)}|${text}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `seg-${startMs}-${(hash >>> 0).toString(36)}`;
  }

  function formatTimestamp(seconds) {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainingSeconds = wholeSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  function parseTimedSubtitles(raw) {
    const normalized = String(raw || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '');
    const marker = normalized.match(/^__NATIVE_SUBTITLE_FILE__=(.+)$/m);
    if (!marker || marker.index === undefined) return [];

    const markerEnd = normalized.indexOf('\n', marker.index);
    const subtitleText = markerEnd >= 0 ? normalized.slice(markerEnd + 1) : '';
    const blocks = subtitleText.split(/\n{2,}/);
    const segments = [];
    const timePattern =
      /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{3})/;

    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0 || /^NOTE(?:\s|$)/i.test(lines[0])) continue;

      const timingIndex = lines.findIndex((line) => timePattern.test(line));
      if (timingIndex < 0) continue;
      const timingMatch = lines[timingIndex].match(timePattern);
      if (!timingMatch) continue;

      const start = parseTimestamp(timingMatch[1]);
      const end = parseTimestamp(timingMatch[2]);
      const text = cleanCueText(lines.slice(timingIndex + 1));
      if (start === null || end === null || end < start || !text) continue;

      segments.push({
        id: makeSegmentId(start, end, text),
        start,
        end,
        text,
        source: 'speech',
        timing_quality: 'exact',
      });
    }
    return segments;
  }

  for (const item of items) {
    let base = {};
    try {
      base = $('Code: Detect Platform & Prepare Download').item.json || {};
    } catch (_error) {
      base = {};
    }

    const stdout = item.json.stdout || '';
    const fileMatch = String(stdout).match(/^__NATIVE_SUBTITLE_FILE__=(.+)$/m);
    const languageMatch = String(stdout).match(/^__NATIVE_SUBTITLE_LANGS__=(.+)$/m);
    const segments = parseTimedSubtitles(stdout);
    const transcript = segments
      .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`)
      .join('\n');
    const hasTimedTranscript = segments.length > 0;

    item.json = {
      ...base,
      ...item.json,
      native_subtitle_file: fileMatch ? fileMatch[1].trim() : '',
      native_subtitle_langs: languageMatch ? languageMatch[1].trim() : '',
      transcript_source: hasTimedTranscript ? 'native_subtitle' : 'asr_fallback',
      timing_quality: hasTimedTranscript ? 'exact' : 'none',
      video_segments: hasTimedTranscript ? segments : [],
      video_transcript: hasTimedTranscript ? transcript : '',
    };
  }

  return items;
}

/**
 * Build upload paths without allowing an incoming webhook body to escape the
 * mounted /home/node/uploads directory. This body is embedded into n8n.
 */
export function runSplitLocalFilesNode($input) {
  const items = $input.all();
  const newItems = [];
  const allowedExtensions = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.pdf',
    '.mp3',
    '.wav',
    '.m4a',
    '.mp4',
    '.webm',
  ]);

  function safeUploadPath(value) {
    const fileName = String(value || '').trim();
    const dot = fileName.lastIndexOf('.');
    const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
    if (
      !fileName ||
      fileName.length > 255 ||
      !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(fileName) ||
      !allowedExtensions.has(extension)
    ) {
      throw new Error(
        'local_file must be a supported file name placed directly in the backend uploads folder',
      );
    }
    return `/home/node/uploads/${fileName}`;
  }

  for (const item of items) {
    const rawLocalFile = item.json.body.metadata.local_file;
    if (!rawLocalFile) continue;
    const files = String(rawLocalFile)
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean);
    for (const file of files) {
      const newItem = { json: JSON.parse(JSON.stringify(item.json)) };
      newItem.json.audio_file_path_for_subflow = safeUploadPath(file);
      newItems.push(newItem);
    }
  }
  return newItems;
}

/**
 * This body is parameterized with the retry switch node name and then embedded
 * into both active n8n parser nodes.
 */
export function runAiParserNode($input, $, switchNodeName) {
  const switchContextNode = switchNodeName;
  const items = $input.all();
  const MAX_AI_RETRIES = 3;

  function nodeJson(name) {
    try {
      return $(name).item.json || {};
    } catch (_error) {
      return {};
    }
  }

  function describeModelError(text) {
    if (
      /Authorization failed|\b401\b|invalid[^.]{0,40}api[ _-]?key|incorrect api key|unauthori[sz]ed/i.test(
        text,
      )
    ) {
      return '模型密钥无效或没有填写。检查后端 .env 里的 VS_CHAT_API_KEY，改完重新运行启动脚本。';
    }
    if (/\b402\b|payment required|insufficient[_ ]?(balance|quota)|余额不足|quota/i.test(text)) {
      return '模型服务商账户余额不足或额度用完，请到服务商控制台充值或换一个密钥。';
    }
    if (/model[^.]{0,40}(not exist|not found|does not exist|invalid)|\b404\b/i.test(text)) {
      return '服务商找不到这个模型名。检查 .env 里的 VS_CHAT_MODEL，名称以服务商文档为准。';
    }
    return '';
  }

  const finalTranscriptContext = nodeJson('Set: Final Transcript for AI');
  const retryContext = nodeJson(switchContextNode);

  for (const item of items) {
    const originalVideoTranscript =
      item.json.video_transcript ||
      finalTranscriptContext.video_transcript ||
      retryContext.video_transcript ||
      '';
    const videoSegments = Array.isArray(item.json.video_segments)
      ? item.json.video_segments
      : Array.isArray(finalTranscriptContext.video_segments)
        ? finalTranscriptContext.video_segments
        : Array.isArray(retryContext.video_segments)
          ? retryContext.video_segments
          : [];
    const timingQuality =
      item.json.timing_quality ||
      finalTranscriptContext.timing_quality ||
      retryContext.timing_quality ||
      'none';
    const transcriptSource =
      item.json.transcript_source ||
      finalTranscriptContext.transcript_source ||
      retryContext.transcript_source ||
      'unknown';

    const priorRetryCount = item.json.ai_retry_count ?? retryContext.ai_retry_count ?? 0;
    item.json.ai_retry_count = Number.isFinite(Number(priorRetryCount))
      ? Number(priorRetryCount)
      : 0;
    item.json.trigger_ai_retry = false;
    item.json.max_ai_retries_for_prompt = MAX_AI_RETRIES;
    item.json.parsing_error_details = null;

    let parsedDataForNextNode = {
      summary: 'Error: AI output processing did not complete as expected.',
      note: 'Error: AI output processing did not complete as expected.',
    };

    if (item.json.error) {
      const upstream = String(item.json.error);
      const fatal = describeModelError(upstream);
      if (fatal) {
        // A wrong key or model name fails the same way every time; say so instead of retrying.
        item.json.parsing_error_details = `模型调用失败：${fatal}`;
        parsedDataForNextNode = {
          summary: `Error: 模型调用失败。${fatal}`,
          note: `Error: 模型调用失败。${fatal}\n\n服务商原话：${upstream.slice(0, 300)}`,
        };
        delete item.json.error;
      } else if (item.json.ai_retry_count < MAX_AI_RETRIES) {
        item.json.ai_retry_count += 1;
        item.json.trigger_ai_retry = true;
        item.json.parsing_error_details = `上游错误，第${item.json.ai_retry_count}次重试: ${upstream}`;
        delete item.json.error;
      } else {
        item.json.parsing_error_details = `上游错误，已达最大重试次数: ${upstream}`;
        parsedDataForNextNode = {
          summary: `Error: 模型多次调用失败。${upstream.slice(0, 300)}`,
          note: `Error: 模型多次调用失败。${upstream.slice(0, 300)}`,
        };
      }
    } else {
      const rawOutput = item.json.output;
      let parsedJson = null;

      if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
        parsedJson = rawOutput;
      } else if (typeof rawOutput === 'string') {
        let textToParse = rawOutput
          .replace(/<think>[\s\S]*?<\/think>/gs, '')
          .replace(/^>\s*思考中\s*\.*([\r\n]+|$)/m, '')
          .trim();
        const fencedJsonMatch = textToParse.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
        if (fencedJsonMatch && fencedJsonMatch[1]) {
          textToParse = fencedJsonMatch[1].trim();
        }
        try {
          parsedJson = JSON.parse(textToParse);
        } catch (error) {
          item.json.parsing_error_details = `JSON解析失败: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        item.json.parsing_error_details = 'AI输出不是对象、字符串或缺失';
      }

      if (
        parsedJson &&
        typeof parsedJson.summary === 'string' &&
        typeof parsedJson.note === 'string'
      ) {
        // Preserve the complete rich object. Downstream normalization validates
        // optional fields; this parser must not discard them.
        parsedDataForNextNode = parsedJson;
        item.json.ai_retry_count = 0;
      } else if (!item.json.parsing_error_details) {
        item.json.parsing_error_details = '解析的JSON缺少必要的summary和note字段';
      }

      if (item.json.parsing_error_details) {
        if (item.json.ai_retry_count < MAX_AI_RETRIES) {
          item.json.ai_retry_count += 1;
          item.json.trigger_ai_retry = true;
          item.json.parsing_error_details = `${item.json.parsing_error_details}，第${item.json.ai_retry_count}次重试`;
        } else {
          item.json.parsing_error_details = `${item.json.parsing_error_details}，已达最大重试次数`;
        }
      }
    }

    item.json.output = parsedDataForNextNode;
    item.json.video_transcript = originalVideoTranscript;
    item.json.video_segments = videoSegments;
    item.json.timing_quality = timingQuality;
    item.json.transcript_source = transcriptSource;
  }

  return items;
}

export function executeNodeCode(code, inputItems, nodeContexts = {}) {
  const $input = { all: () => inputItems };
  const $ = (name) => ({
    item: {
      json: nodeContexts[name] || {},
    },
  });
  const run = vm.runInThisContext(`(function ($input, $) {\n${code}\n})`);
  return run($input, $);
}

function buildAiParserCode(switchNodeName) {
  return functionBody(runAiParserNode).replace(
    'const switchContextNode = switchNodeName;',
    `const switchContextNode = ${JSON.stringify(switchNodeName)};`,
  );
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node) {
    throw new Error(`Workflow node not found: ${name}`);
  }
  return node;
}

function upsertAssignment(node, assignment) {
  const assignments = node.parameters.assignments?.assignments;
  if (!Array.isArray(assignments)) {
    throw new Error(`Node has no assignment list: ${node.name}`);
  }
  const index = assignments.findIndex((candidate) => candidate.name === assignment.name);
  if (index >= 0) {
    assignments[index] = {
      ...assignments[index],
      ...assignment,
    };
  } else {
    assignments.push(assignment);
  }
}

export function upgradeWorkflow(workflow) {
  const upgraded = structuredClone(workflow);
  renameLegacyNodes(upgraded);

  upgraded.version = PUBLIC_WORKFLOW_VERSION;
  if (!upgraded.meta?.videoSummaryWorkflow) {
    throw new Error('Public workflow metadata is missing');
  }
  applyBackendLayout(upgraded);
  upgraded.version = PUBLIC_WORKFLOW_VERSION;

  ensureVideoValidationNode(upgraded);

  const videoLinkInput = getNode(upgraded, 'Set: Video Link from Input');
  const videoLinkAssignment = videoLinkInput.parameters.assignments.assignments.find(
    (assignment) => assignment.name === 'video_link',
  );
  if (!videoLinkAssignment) throw new Error('Video link assignment is missing');
  videoLinkAssignment.value = '={{ $json.validated_video_url }}';

  getNode(upgraded, 'Code: Detect Platform & Prepare Download').parameters.jsCode =
    buildPrepareDownloadCode();
  getNode(upgraded, 'CMD: Get Video Metadata').parameters.command =
    buildMetadataCommandExpression();

  const parseMetadata = getNode(upgraded, 'Code: Parse Metadata');
  parseMetadata.parameters.jsCode = parseMetadata.parameters.jsCode.replace(
    "const link = $('Webhook').item.json.body.metadata.link;",
    "const link = $('Code: Validate Video URL').item.json.validated_video_url;",
  );

  const localAudioPath = getNode(upgraded, 'Set: Local Audio File Path');
  upsertAssignment(localAudioPath, {
    id: 'd9313039-9566-4dd6-8971-fe28da940b33',
    name: 'audio_file_path_for_subflow',
    value: SAFE_LOCAL_FILE_EXPRESSION,
    type: 'string',
  });
  getNode(upgraded, 'Code: Split Files').parameters.jsCode = functionBody(runSplitLocalFilesNode);

  getNode(upgraded, 'Code: Parse Native Subtitles').parameters.jsCode =
    functionBody(runNativeSubtitleNode);

  const finalTranscript = getNode(upgraded, 'Set: Final Transcript for AI');
  finalTranscript.parameters.includeOtherFields = true;
  upsertAssignment(finalTranscript, {
    id: 'v3-video-transcript',
    name: 'video_transcript',
    value: '={{ $json.video_transcript || $json.full_transcript || "" }}',
    type: 'string',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-video-segments',
    name: 'video_segments',
    value:
      '={{ Array.isArray($json.video_segments) ? $json.video_segments : (Array.isArray($json.segments) ? $json.segments : []) }}',
    type: 'array',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-timing-quality',
    name: 'timing_quality',
    value:
      '={{ $json.timing_quality || ((Array.isArray($json.video_segments) && $json.video_segments.length) || (Array.isArray($json.segments) && $json.segments.length) ? "aligned" : "none") }}',
    type: 'string',
  });
  upsertAssignment(finalTranscript, {
    id: 'v3-transcript-source',
    name: 'transcript_source',
    value:
      '={{ $json.transcript_source || ($json.full_transcript ? "asr" : ($json.video_transcript ? "provided_transcript" : "none")) }}',
    type: 'string',
  });

  getNode(upgraded, 'Code: Parse Note JSON').parameters.jsCode =
    buildAiParserCode('Switch: Retry Note?');

  const summary = getNode(upgraded, 'Set: Summary');
  summary.parameters.includeOtherFields = false;
  upsertAssignment(summary, {
    id: 'v3-summary-video-transcript',
    name: 'video_transcript',
    value: "={{ $('Set: Final Transcript for AI').item.json.video_transcript || '' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-video-segments',
    name: 'video_segments',
    value:
      "={{ Array.isArray($('Set: Final Transcript for AI').item.json.video_segments) ? $('Set: Final Transcript for AI').item.json.video_segments : [] }}",
    type: 'array',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-timing-quality',
    name: 'timing_quality',
    value: "={{ $('Set: Final Transcript for AI').item.json.timing_quality || 'none' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-transcript-source',
    name: 'transcript_source',
    value: "={{ $('Set: Final Transcript for AI').item.json.transcript_source || 'unknown' }}",
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-content-type',
    name: 'content_type',
    value: '={{ $json.output.content_type || "" }}',
    type: 'string',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-evidence-claims',
    name: 'evidence_claims',
    value: '={{ Array.isArray($json.output.evidence_claims) ? $json.output.evidence_claims : [] }}',
    type: 'array',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-attention',
    name: 'attention',
    value:
      '={{ $json.output.attention && typeof $json.output.attention === "object" ? $json.output.attention : {} }}',
    type: 'object',
  });
  upsertAssignment(summary, {
    id: 'v3-summary-learning',
    name: 'learning',
    value:
      '={{ $json.output.learning && typeof $json.output.learning === "object" ? $json.output.learning : {} }}',
    type: 'object',
  });

  applyNoteStep(upgraded);

  // n8n 2.x Code nodes run in a sandbox without the URL global; the url builtin is allowed in
  // compose.yaml (NODE_FUNCTION_ALLOW_BUILTIN=url).
  for (const name of ['Code: Validate Video URL', 'Code: Detect Platform & Prepare Download']) {
    const node = getNode(upgraded, name);
    if (!node.parameters.jsCode.startsWith(URL_GLOBAL_LINE)) {
      node.parameters.jsCode = `${URL_GLOBAL_LINE}\n${node.parameters.jsCode}`;
    }
  }

  applyCanvasLayout(upgraded);
  return upgraded;
}

function hasConnection(workflow, from, to, kind = 'main') {
  const branches = workflow.connections[from]?.[kind] || [];
  return branches.some((branch) => branch.some((edge) => edge.node === to));
}

export function validateWorkflow(workflow) {
  const errors = [];

  try {
    const serializedWorkflow = JSON.stringify(workflow);
    if (
      workflow.version !== PUBLIC_WORKFLOW_VERSION ||
      workflow.meta?.videoSummaryWorkflow?.version !== PUBLIC_WORKFLOW_VERSION
    ) {
      errors.push(`Public workflow version must be ${PUBLIC_WORKFLOW_VERSION}.`);
    }
    const healthReport = getNode(workflow, NODE_NAMES.healthReport).parameters.jsCode;
    if (!healthReport.includes(`"version":"${PUBLIC_WORKFLOW_VERSION}"`)) {
      errors.push(`Health report version must be ${PUBLIC_WORKFLOW_VERSION}.`);
    }
    if (!hasConnection(workflow, NODE_NAMES.healthReport, NODE_NAMES.testResponse)) {
      errors.push('Health report does not answer the test request.');
    }
    for (const pattern of PRIVATE_PROFILE_PATTERNS) {
      if (pattern.test(serializedWorkflow)) {
        errors.push(`Workflow contains a private profile pattern: ${pattern.source}`);
      }
    }

    if (serializedWorkflow.includes('--no-check-certificate')) {
      errors.push('Workflow disables TLS certificate verification.');
    }

    const urlValidation = getNode(workflow, 'Code: Validate Video URL');
    if (!urlValidation.parameters.jsCode.includes(VIDEO_URL_SECURITY_MARKER)) {
      errors.push('Video URL validation boundary is missing.');
    }
    if (!hasConnection(workflow, 'Webhook', 'Code: Validate Video URL')) {
      errors.push('Webhook does not pass through video URL validation.');
    }
    if (!hasConnection(workflow, 'Code: Validate Video URL', 'Switch: Input Type')) {
      errors.push('Video URL validation does not lead to the input router.');
    }

    const webhook = getNode(workflow, 'Webhook');
    if (
      webhook.parameters.authentication !== 'headerAuth' ||
      webhook.credentials?.httpHeaderAuth?.id !== CREDENTIALS.webhook.id
    ) {
      errors.push('Webhook must require the packaged Header Auth credential.');
    }
    if (!/127\.0\.0\.1/.test(webhook.notes || '')) {
      errors.push('Webhook does not document its local-only boundary.');
    }

    for (const node of workflow.nodes) {
      for (const [type, reference] of Object.entries(node.credentials || {})) {
        const known = Object.values(CREDENTIALS).some(
          (credential) => credential.id === reference.id && credential.type === type,
        );
        if (!known) errors.push(`${node.name} uses a credential outside the packaged set.`);
      }
    }
    if (
      /YOUR_GEMINI_API_KEY|[?&]key=|Bearer\s+[A-Za-z0-9]|sk-[A-Za-z0-9]{8}/i.test(
        serializedWorkflow,
      )
    ) {
      errors.push('Workflow contains an inline API key.');
    }
    const modelNodes = workflow.nodes.filter((node) => /\.lmChat/.test(node.type));
    if (modelNodes.length !== 1 || modelNodes[0].name !== NODE_NAMES.model) {
      errors.push('Every AI step must share the single packaged chat model.');
    }

    for (const node of workflow.nodes.filter(
      (candidate) => candidate.type === 'n8n-nodes-base.executeCommand',
    )) {
      const command = String(node.parameters.command || '');
      if (/metadata\.link|\$\('Webhook'\).*link/.test(command)) {
        errors.push(`${node.name} interpolates the raw webhook link into a command.`);
      }
      if (command.includes('--no-check-certificate')) {
        errors.push(`${node.name} disables TLS certificate verification.`);
      }
    }

    const metadataCommand = getNode(workflow, 'CMD: Get Video Metadata').parameters.command;
    if (
      !metadataCommand.includes('$json.video_url_token') ||
      !metadataCommand.includes('spawnSync') ||
      metadataCommand.includes('metadata.link')
    ) {
      errors.push('Metadata command does not use the validated token and argument-array runner.');
    }

    const downloadPreparation = getNode(workflow, 'Code: Detect Platform & Prepare Download')
      .parameters.jsCode;
    if (
      !downloadPreparation.includes(VIDEO_URL_SECURITY_MARKER) ||
      !downloadPreparation.includes("toString('base64url')") ||
      downloadPreparation.includes('--no-check-certificate')
    ) {
      errors.push('Download preparation does not use the hardened URL token runner.');
    }

    const nativeParser = getNode(workflow, 'Code: Parse Native Subtitles');
    if (!nativeParser.parameters.jsCode.includes("timing_quality: 'exact'")) {
      errors.push('Native subtitle parser does not emit exact timing quality.');
    }
    if (!nativeParser.parameters.jsCode.includes('video_segments')) {
      errors.push('Native subtitle parser does not emit video_segments.');
    }

    const finalTranscript = getNode(workflow, 'Set: Final Transcript for AI');
    const finalNames = new Set(
      finalTranscript.parameters.assignments.assignments.map((item) => item.name),
    );
    for (const field of [
      'video_transcript',
      'video_segments',
      'timing_quality',
      'transcript_source',
    ]) {
      if (!finalNames.has(field)) {
        errors.push(`Final Transcript is missing ${field}.`);
      }
    }

    for (const parserName of ['Code: Parse Note JSON']) {
      const parser = getNode(workflow, parserName);
      if (!parser.parameters.jsCode.includes('parsedDataForNextNode = parsedJson')) {
        errors.push(`${parserName} does not preserve the complete rich output.`);
      }
      for (const field of ['video_segments', 'timing_quality', 'transcript_source']) {
        if (!parser.parameters.jsCode.includes(`item.json.${field}`)) {
          errors.push(`${parserName} does not restore ${field}.`);
        }
      }
    }

    const summary = getNode(workflow, 'Set: Summary');
    const summaryNames = new Set(
      summary.parameters.assignments.assignments.map((item) => item.name),
    );
    for (const field of [
      'video_transcript',
      'video_segments',
      'timing_quality',
      'transcript_source',
      'content_type',
      'evidence_claims',
      'attention',
      'learning',
    ]) {
      if (!summaryNames.has(field)) {
        errors.push(`Summary is missing ${field}.`);
      }
    }

    for (const name of ACTIVE_AI_AGENT_NAMES) {
      const agent = getNode(workflow, name);
      if (
        !agent.parameters.text.startsWith('={{') ||
        !agent.parameters.text.includes(NOTE_PROMPT_MARKER)
      ) {
        errors.push(`${name} must build its prompt with the note-prompt expression.`);
      }
      if (!agent.parameters.text.includes('does not receive video frames')) {
        errors.push(`${name} does not disclose the visual-understanding limit.`);
      }
    }
    if (!hasConnection(workflow, 'Switch: Retry Note?', ACTIVE_AI_AGENT_NAMES[0])) {
      errors.push('A failed parse does not loop back to the AI step.');
    }

    for (const name of TRANSCRIPT_SUBFLOW_NODE_NAMES) {
      const workflowId = getNode(workflow, name).parameters.workflowId;
      if (workflowId?.value !== WORKFLOW_IDS.speech || workflowId?.mode !== 'id') {
        errors.push(`${name} does not call the bundled speech-to-text workflow.`);
      }
    }

    const localAudioPath = getNode(workflow, 'Set: Local Audio File Path');
    const localAudioAssignment = localAudioPath.parameters.assignments.assignments.find(
      (assignment) => assignment.name === 'audio_file_path_for_subflow',
    );
    if (localAudioAssignment?.value !== SAFE_LOCAL_FILE_EXPRESSION) {
      errors.push('Local audio path does not enforce the uploads-directory boundary.');
    }
    const splitFiles = getNode(workflow, 'Code: Split Files');
    if (
      !splitFiles.parameters.jsCode.includes('safeUploadPath') ||
      !splitFiles.parameters.jsCode.includes('allowedExtensions') ||
      !splitFiles.parameters.jsCode.includes('\\p{L}') ||
      !splitFiles.parameters.jsCode.includes('backend uploads folder')
    ) {
      errors.push('Local files do not enforce the uploads-root basename boundary.');
    }
    for (const extension of ALLOWED_LOCAL_FILE_EXTENSIONS) {
      if (!splitFiles.parameters.jsCode.includes(`'${extension}'`)) {
        errors.push(`Local-file allowlist is missing ${extension}.`);
      }
    }

    if (
      workflow.nodes.some(
        (node) => node.name === 'Analyze video' || /googleGemini/i.test(node.type),
      )
    ) {
      errors.push('Gemini-only nodes must not remain in the packaged workflow.');
    }

    const requiredEdges = [
      ['Code: Parse Native Subtitles', 'Switch: Native Transcript Found'],
      ['Merge: Transcript Sources', 'Set: Final Transcript for AI'],
      ['Set: Final Transcript for AI', 'Switch: Operation Mode'],
      ['Set: Summary', 'Merge: Result'],
    ];
    for (const [from, to] of requiredEdges) {
      if (!hasConnection(workflow, from, to)) {
        errors.push(`Required workflow edge is missing: ${from} -> ${to}.`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return errors;
}

function parseArgs(argv) {
  const args = {
    check: false,
    workflowPath: DEFAULT_WORKFLOW_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') {
      args.check = true;
    } else if (value === '--workflow') {
      args.workflowPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const originalText = readFileSync(args.workflowPath, 'utf8');
  const workflow = JSON.parse(originalText);
  const upgraded = upgradeWorkflow(workflow);
  const errors = validateWorkflow(upgraded);
  if (errors.length > 0) {
    throw new Error(`Workflow v3 validation failed:\n- ${errors.join('\n- ')}`);
  }

  const outputs = [
    [args.workflowPath, originalText, `${JSON.stringify(upgraded, null, 2)}\n`],
    [
      DEFAULT_SPEECH_WORKFLOW_PATH,
      existsSync(DEFAULT_SPEECH_WORKFLOW_PATH)
        ? readFileSync(DEFAULT_SPEECH_WORKFLOW_PATH, 'utf8')
        : '',
      `${JSON.stringify(buildSpeechWorkflow(), null, 2)}\n`,
    ],
  ];
  if (args.check) {
    for (const [path, current, expected] of outputs) {
      if (current !== expected) {
        throw new Error(
          `${path} is not current or not deterministically formatted. Run tools/upgrade-workflow-v3.mjs.`,
        );
      }
    }
    process.stdout.write('Workflow check passed.\n');
    return;
  }

  for (const [path, current, expected] of outputs) {
    if (current !== expected) {
      writeFileSync(path, expected, 'utf8');
      process.stdout.write(`Updated workflow: ${path}\n`);
    } else {
      process.stdout.write(`Workflow already current: ${path}\n`);
    }
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  DEFAULT_SPEECH_WORKFLOW_PATH,
  DEFAULT_WORKFLOW_PATH,
  MEDIA_RUNNER_PROGRAM,
  NOTE_PROMPT_MARKER,
  PUBLIC_WORKFLOW_VERSION,
  VIDEO_URL_SECURITY_MARKER,
  stableSegmentId,
};
