(function attachVideoCaptureUtils(global) {
  // Shared single-source core (vendored from @video-summary/shared), loaded via
  // vendor/shared.global.js BEFORE this file. Platform detection + URL canonicalization
  // are delegated to it so the logic lives in exactly one place.
  const SHARED = global.VideoSummaryShared;
  if (!SHARED) {
    console.error('[VideoCapture] vendor/shared.global.js must be loaded before utils.js');
  }

  const DEFAULT_SETTINGS = Object.freeze({
    vaultName: '',
    folder: '',
    appendPath: '',
    obsidianRestProtocol: 'https',
    obsidianRestPort: 27123,
    obsidianRestToken: '',
    n8nWebhookUrl: 'http://127.0.0.1:5678/webhook/obsidian-video-summary',
    n8nToken: '',
    webhookFormat: 'unified',
    defaultMode: 'summary',
    defaultLanguage: 'zh',
    quickAction: 'create-pending-note',
    autoClose: false,
    // Send the captions YouTube's player loaded on the page, so Obsidian can write the note
    // without a backend (the plugin's light tier).
    sendCaptions: true,
  });

  // Unified host list from the shared source (previously a local 5-host subset).
  const VIDEO_HOST_PATTERNS = SHARED
    ? SHARED.SUPPORTED_PLATFORMS
    : ['youtube.com', 'youtu.be', 'bilibili.com', 'douyin.com', 'tiktok.com'];

  function sanitizeFilename(title) {
    const clean = (title || 'Untitled Video')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return clean || 'Untitled Video';
  }

  function cleanTitle(title) {
    return (
      (title || 'Untitled Video')
        .replace(/ - YouTube$/, '')
        .replace(/_哔哩哔哩_bilibili$/, '')
        .replace(/^\(\d+\)\s*/, '')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled Video'
    );
  }

  function detectPlatform(url) {
    return SHARED.detectPlatform(url);
  }

  function isVideoUrl(url) {
    return SHARED.isVideoUrl(url);
  }

  function stripTimestamp(url) {
    return SHARED.stripTimestamp(url);
  }

  function appendTimestamp(url, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return url;
    try {
      const parsed = new URL(url);
      if (
        parsed.hostname.includes('youtube') ||
        parsed.hostname.includes('youtu.be') ||
        parsed.hostname.includes('bilibili')
      ) {
        parsed.searchParams.set('t', String(Math.floor(seconds)));
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function cleanVideoUrl(url, options = {}) {
    // Delegate to the shared canonicalizer. The extension keeps the Bilibili part (?p=) and,
    // by default, the timestamp (unless keepTimestamp === false). The shared implementation
    // is the superset that also handles YouTube /shorts/ and Douyin/TikTok.
    return SHARED.canonicalizeVideoUrl(url, {
      keepP: true,
      keepTimestamp: options.keepTimestamp !== false,
    });
  }

  function formatTimestamp(seconds) {
    if (!Number.isFinite(seconds)) return '--:--';
    const safe = Math.max(0, Math.floor(seconds));
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function clockText(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  /**
   * YouTube's json3 captions → one "[mm:ss] text" line per passage of about 20 seconds,
   * ending at a sentence when there is one. Automatic captions repeat a line as it
   * scrolls; exact repeats are dropped. '' when there is nothing to read.
   */
  function captionTranscriptFromJson3(text, maxSeconds = 20, minSeconds = 8) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return '';
    }
    const events = data && Array.isArray(data.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      if (!event || !Array.isArray(event.segs)) continue;
      const line = event.segs
        .map((seg) => String((seg && seg.utf8) || ''))
        .join('')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const start = Number(event.tStartMs) / 1000;
      if (!line || !Number.isFinite(start)) continue;
      const duration = Number(event.dDurationMs) / 1000;
      cues.push({ start, end: start + (Number.isFinite(duration) ? duration : 0), text: line });
    }
    const sentenceEnd = /[.!?。！？…]["'」』）)]?$/;
    const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
    const passages = [];
    let current = null;
    let last = '';
    for (const cue of cues) {
      if (cue.text === last) continue;
      last = cue.text;
      if (!current) {
        current = { ...cue };
        continue;
      }
      const atSentence = sentenceEnd.test(current.text) && cue.start - current.start >= minSeconds;
      if (cue.end - current.start > maxSeconds || atSentence) {
        passages.push(current);
        current = { ...cue };
      } else {
        const joiner = cjk.test(current.text.slice(-1)) || cjk.test(cue.text[0]) ? '' : ' ';
        current.text = `${current.text}${joiner}${cue.text}`;
        current.end = Math.max(current.end, cue.end);
      }
    }
    if (current) passages.push(current);
    return passages.map((p) => `[${clockText(p.start)}] ${p.text}`).join('\n');
  }

  /** A duration the way yt-dlp's duration_string writes it: 9:46, 1:56:20. */
  function durationString(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  /** A YAML block scalar, safe for any text. */
  function yamlBlock(value) {
    return `|-\n${String(value)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}`;
  }

  function encodeObsidianParam(value) {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16)}`,
    );
  }

  function yamlQuote(value) {
    return JSON.stringify(String(value || ''));
  }

  function buildMarkdownLink(item) {
    const timestamp = Number.isFinite(item.timestamp) ? ` ${formatTimestamp(item.timestamp)}` : '';
    return `[${cleanTitle(item.title)}${timestamp}](${item.timestampUrl || item.url})`;
  }

  function buildPendingNoteContent(item, settings) {
    const title = cleanTitle(item.title);
    const baseUrl = cleanVideoUrl(item.url, { keepTimestamp: false });
    const timestampUrl = item.timestampUrl || item.url;
    const platform = detectPlatform(baseUrl);
    const capturedAt = new Date().toISOString();
    const timestampLines = Number.isFinite(item.timestamp)
      ? `video_timestamp: ${Math.floor(item.timestamp)}\ntimestamp_link: ${yamlQuote(timestampUrl)}\n`
      : '';

    const transcriptLines = item.transcript
      ? [
          item.videoAuthor ? `video_author: ${yamlQuote(item.videoAuthor)}\n` : '',
          item.videoDuration ? `video_duration: ${yamlQuote(item.videoDuration)}\n` : '',
          item.videoCover ? `video_cover: ${yamlQuote(item.videoCover)}\n` : '',
          `provided_transcript: ${yamlBlock(item.transcript)}\n`,
        ].join('')
      : '';

    return `---\nlink: ${yamlQuote(baseUrl)}\nstatus: pending\nsource: browser-extension\ncapture_route: ${yamlQuote(settings.quickAction || 'create-pending-note')}\nvideo_title: ${yamlQuote(title)}\nvideo_platform: ${yamlQuote(platform)}\n${timestampLines}${transcriptLines}captured_at: ${yamlQuote(capturedAt)}\n---\n# ${title}\n\n${buildMarkdownLink({ ...item, title, url: baseUrl, timestampUrl })}\n`;
  }

  function buildObsidianNewUri(vaultName, folder, item, settings) {
    const title = sanitizeFilename(cleanTitle(item.title));
    const content = buildPendingNoteContent(item, settings);
    const filePath = buildObsidianFilePath(folder, title);
    return `obsidian://new?vault=${encodeObsidianParam(vaultName)}&file=${encodeObsidianParam(filePath)}&content=${encodeObsidianParam(content)}`;
  }

  function buildObsidianFilePath(folder, title) {
    const cleanFolder = (folder || '').trim().replace(/^\/+|\/+$/g, '');
    return cleanFolder ? `${cleanFolder}/${title}` : title;
  }

  function buildObsidianAppendUri(vaultName, appendPath, item) {
    const content = `\n- ${buildMarkdownLink(item)}`;
    return `obsidian://new?vault=${encodeObsidianParam(vaultName)}&file=${encodeObsidianParam(appendPath)}&content=${encodeObsidianParam(content)}&append=true`;
  }
  // 直连 Obsidian 插件的自定义协议：一步完成"建笔记 + 触发处理"，
  // 由 video-summary 插件的 registerObsidianProtocolHandler('video-summary') 接收。
  function buildObsidianProcessUri(vaultName, item, settings) {
    const title = cleanTitle(item.title);
    const baseUrl = cleanVideoUrl(item.url, { keepTimestamp: false });
    const timestampUrl = item.timestampUrl || '';
    const mode = item.mode || settings.defaultMode || 'summary';
    const params = [
      `vault=${encodeObsidianParam(vaultName)}`,
      `url=${encodeObsidianParam(baseUrl)}`,
      `title=${encodeObsidianParam(title)}`,
      `mode=${encodeObsidianParam(mode)}`,
    ];
    if (settings.folder) params.push(`folder=${encodeObsidianParam(settings.folder)}`);
    if (timestampUrl && timestampUrl !== baseUrl) {
      params.push(`timestamp_link=${encodeObsidianParam(timestampUrl)}`);
    }
    if (item.transcript) {
      if (item.videoAuthor) params.push(`author=${encodeObsidianParam(item.videoAuthor)}`);
      if (item.videoDuration) params.push(`duration=${encodeObsidianParam(item.videoDuration)}`);
      if (item.videoCover) params.push(`cover=${encodeObsidianParam(item.videoCover)}`);
      params.push(`transcript=${encodeObsidianParam(item.transcript)}`);
    }
    return `obsidian://video-summary?${params.join('&')}`;
  }

  function buildUnifiedPayload(item, settings, action) {
    const title = cleanTitle(item.title);
    const baseUrl = cleanVideoUrl(item.url, { keepTimestamp: false });
    const timestampUrl = item.timestampUrl || item.url;
    const mode = item.mode || settings.defaultMode || 'summary';
    const language = item.language || settings.defaultLanguage || 'zh';

    return {
      source: 'browser-extension',
      action,
      name: title,
      metadata: {
        mode,
        language,
        link: baseUrl,
        timestamp_link: timestampUrl,
        timestamp: Number.isFinite(item.timestamp) ? Math.floor(item.timestamp) : null,
        title,
        platform: detectPlatform(baseUrl),
        folder: settings.folder || '',
        appendPath: settings.appendPath || '',
        captured_at: new Date().toISOString(),
      },
      content: '',
    };
  }

  function buildLegacyBridgePayload(item, settings, action) {
    return {
      action: action === 'append-link' ? 'append' : 'new',
      title: cleanTitle(item.title),
      url: item.timestampUrl || item.url,
      vault: settings.vaultName || '',
      folder: settings.folder || '',
      appendPath: settings.appendPath || '',
    };
  }

  /** The backend start script's connection code: `<webhook URL>#token=<token>`. */
  function parseConnectionCode(raw) {
    const text = String(raw || '').trim();
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const token = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('token') || '';
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return null;
    parsed.hash = '';
    return { url: parsed.toString(), token };
  }

  /** chrome.cookies results as a Netscape cookies.txt, the format yt-dlp reads. */
  function buildNetscapeCookies(cookies) {
    const lines = ['# Netscape HTTP Cookie File'];
    for (const cookie of cookies || []) {
      if (
        !cookie ||
        !cookie.domain ||
        !cookie.name ||
        /[\t\r\n]/.test(`${cookie.name}${cookie.value}`)
      ) {
        continue;
      }
      const domain = cookie.hostOnly ? cookie.domain : `.${cookie.domain.replace(/^\./, '')}`;
      lines.push(
        [
          cookie.httpOnly ? `#HttpOnly_${domain}` : domain,
          cookie.hostOnly ? 'FALSE' : 'TRUE',
          cookie.path || '/',
          cookie.secure ? 'TRUE' : 'FALSE',
          String(Math.floor(cookie.expirationDate || 0)),
          cookie.name,
          cookie.value || '',
        ].join('\t'),
      );
    }
    return `${lines.join('\n')}\n`;
  }

  global.VideoCaptureUtils = {
    DEFAULT_SETTINGS,
    VIDEO_HOST_PATTERNS,
    appendTimestamp,
    buildLegacyBridgePayload,
    buildMarkdownLink,
    buildNetscapeCookies,
    buildObsidianFilePath,
    buildObsidianAppendUri,
    buildObsidianNewUri,
    buildObsidianProcessUri,
    captionTranscriptFromJson3,
    durationString,
    buildPendingNoteContent,
    buildUnifiedPayload,
    cleanTitle,
    cleanVideoUrl,
    detectPlatform,
    formatTimestamp,
    isVideoUrl,
    parseConnectionCode,
    sanitizeFilename,
    stripTimestamp,
  };
})(typeof self !== 'undefined' ? self : window);
