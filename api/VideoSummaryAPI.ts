import {
  ProcessingMode,
  SupportedLanguage,
  VideoInput,
  ProcessingResult,
  WebhookHistoryEntry,
  ConnectionTestResult,
  WorkflowHealthInfo,
  ProcessingDepth,
  RequestedContentType,
  WebhookAuthConfig,
  PayloadKeys,
} from '../types';
import { CacheManager } from '../utils/CacheManager';
import { UrlResolver } from '../utils/UrlResolver';
import type { RequestUrlParam, RequestUrlResponse, Vault } from 'obsidian';
import {
  BACKEND_DEFAULT_MODEL_LABEL,
  DEFAULT_WEBHOOK_AUTH_HEADER,
  RECOMMENDED_WORKFLOW,
} from '../constants';
import { normalizeRichProcessingResult } from '../core/KnowledgeModel';
import {
  buildContentRoutingPromptContract,
  CONTENT_ROUTER_CONTRACT_VERSION,
} from '../core/ContentRouter';
import {
  buildArtifactFingerprint,
  type ArtifactFingerprint,
  type VisualFingerprintMode,
} from '../core/ArtifactFingerprint';

import { errorMessage } from '../utils/errors';
import { asRecord, asText, isRecord, type JsonRecord } from '../utils/json';
import { tr } from '../utils/i18n';
const CACHE_ARTIFACT_SCHEMA_VERSION = 3;
const CACHE_PROMPT_VERSION = 'video-note-prompt-v4';

export interface EndpointProbeResult {
  ok: boolean;
  error?: string;
  status?: number;
  bodySnippet?: string;
}

/**
 * 处理进度回调。n8n 是一次性 POST，拿不到中间态；目前只在命中缓存时调用，平时界面只显示计时。
 */
export type ProcessProgressReporter = (progress: {
  stageLabel?: string;
  progress?: number;
  message?: string;
}) => void;

export class VideoSummaryAPI {
  private webhookUrl: string;
  private timeout: number;
  private debugMode: boolean = false;
  private aiModel: string = BACKEND_DEFAULT_MODEL_LABEL;
  private webhookAuth: WebhookAuthConfig = {
    headerName: DEFAULT_WEBHOOK_AUTH_HEADER,
    secret: '',
  };
  private cacheManager: CacheManager;
  private payloadKeys: PayloadKeys;
  private expandShortLinksEnabled: boolean = false;
  private analysisDefaults: {
    processingDepth: ProcessingDepth;
    contentType: RequestedContentType;
    autoRoute: boolean;
    attentionAssessment: boolean;
    generateLearning: boolean;
  } = {
    processingDepth: 'evidence',
    contentType: 'auto',
    autoRoute: true,
    attentionAssessment: true,
    generateLearning: false,
  };

  setAiModel(model: string) {
    this.aiModel = model;
  }
  private lastWebhookResult: {
    result: ProcessingResult;
    input: VideoInput;
    mode: ProcessingMode;
    language: SupportedLanguage;
    timestamp: number;
  } | null = null;
  private webhookHistory: WebhookHistoryEntry[] = [];
  private webhookHistoryLimit = 50;
  private historyListener?: (history: WebhookHistoryEntry[]) => void;
  private controllers: Map<string, AbortController> = new Map();
  private controllerSequence = 0;
  constructor(
    webhookUrl: string,
    vault: Vault,
    pluginDataPath?: string,
    payloadKeys?: PayloadKeys,
    webhookAuth?: Partial<WebhookAuthConfig>,
    timeoutMinutes: number = 30,
  ) {
    this.webhookUrl = webhookUrl;
    const normalizedTimeoutMinutes =
      Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 30;
    this.timeout = normalizedTimeoutMinutes * 60 * 1000;
    this.setWebhookAuth(webhookAuth);
    this.cacheManager = new CacheManager(vault, pluginDataPath);
    this.payloadKeys = payloadKeys || {
      mode: 'mode',
      language: 'language',
      ai: 'ai',
      info_only: 'info_only',
      link: 'link',
      provided_transcript: 'provided_transcript',
      local_file: 'local_file',
    };
  }

  setPayloadKeys(keys: PayloadKeys) {
    this.payloadKeys = keys;
  }

  setEndpoint(url: string, webhookAuth?: Partial<WebhookAuthConfig>) {
    this.webhookUrl = url;
    if (webhookAuth !== undefined) {
      this.setWebhookAuth(webhookAuth);
    }
  }

  setWebhookAuth(auth?: Partial<WebhookAuthConfig>) {
    this.webhookAuth = {
      headerName: auth?.headerName?.trim() || DEFAULT_WEBHOOK_AUTH_HEADER,
      secret: typeof auth?.secret === 'string' ? auth.secret : '',
    };
  }

  private buildN8nHeaders(): Record<string, string> {
    return VideoSummaryAPI.buildN8nHeaders(this.webhookAuth);
  }

  private static buildN8nHeaders(auth?: Partial<WebhookAuthConfig>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const secret = typeof auth?.secret === 'string' ? auth.secret : '';
    if (!secret) return headers;

    const headerName = auth?.headerName?.trim() || DEFAULT_WEBHOOK_AUTH_HEADER;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
      throw new Error('Webhook 鉴权 Header 名称无效。');
    }
    if (/[\0\r\n]/.test(secret)) {
      throw new Error('Webhook 鉴权 Secret 不能包含换行符或空字符。');
    }
    headers[headerName] = secret;
    return headers;
  }

  private redactWebhookSecret(value: string): string {
    const secret = this.webhookAuth.secret;
    return secret && value.includes(secret) ? value.split(secret).join('[REDACTED]') : value;
  }

  /** 是否在发送前自动展开短链 */
  setExpandShortLinks(enabled: boolean) {
    this.expandShortLinksEnabled = enabled;
  }

  setAnalysisDefaults(defaults: Partial<typeof this.analysisDefaults>) {
    this.analysisDefaults = { ...this.analysisDefaults, ...defaults };
  }

  /**
   * 短链展开（fail-open）：失败时原样返回 input。
   * 在缓存检查之前调用，保证缓存 key 用的是展开后的最终链接。
   */
  private async resolveInputUrl(input: VideoInput): Promise<VideoInput> {
    if (!this.expandShortLinksEnabled || !input.url || !UrlResolver.isShortLink(input.url)) {
      return input;
    }
    try {
      const expanded = await UrlResolver.expandShortUrl(input.url);
      if (expanded && expanded !== input.url) {
        return { ...input, url: expanded };
      }
    } catch {
      if (this.debugMode) {
        console.warn('[VideoSummaryAPI] 短链展开失败，使用原链接');
      }
    }
    return input;
  }

  /**
   * 设置调试模式
   */
  setDebug(debug: boolean) {
    this.debugMode = debug;
  }

  /**
   * 处理单个视频
   */
  async processVideo(
    noteName: string,
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage = 'zh',
    useCache: boolean = true,
    onProgress?: ProcessProgressReporter,
    timeoutMinutes?: number,
  ): Promise<ProcessingResult> {
    input = this.withAnalysisDefaults(input);
    // 短链先展开再处理（缓存 key 也用展开后的链接）
    input = await this.resolveInputUrl(input);
    const cacheFingerprint = this.buildCacheFingerprint(input, mode, language);

    // 富结果只按完整指纹读取，不回退到无法验证 provenance 的旧 URL key。
    if (useCache) {
      const cachedResult = await this.cacheManager.getByFingerprint(cacheFingerprint);
      if (cachedResult) {
        if (this.debugMode) {
          console.debug(`[VideoSummaryAPI] 使用指纹缓存: ${cacheFingerprint.key}`);
        }
        onProgress?.({
          stageLabel: tr('命中缓存', 'From cache'),
          progress: 1,
          message: tr('命中缓存，未请求后端', 'From cache; the backend was not called'),
        });
        return cachedResult;
      }
    }

    // 构建请求负载
    const payload = this.buildPayload(noteName, input, mode, language);
    const requestTimeoutMs = this.resolveTimeoutMs(timeoutMinutes);

    // 创建并注册中止控制器（同名任务仅允许一个并行请求）
    const controller = new AbortController();
    const existingController = this.controllers.get(noteName);
    if (existingController) {
      existingController.abort();
    }
    this.controllers.set(noteName, controller);

    // n8n 路径以前建了 AbortController 却从不超时，挂起请求会永久卡住；这里挂上真正的超时
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify(payload),
        requestTimeoutMs + 1000,
        controller.signal,
      );

      if (!response.ok) {
        throw new Error(await this.formatHttpError(response));
      }

      const data = await this.readJsonResponse(response);
      const result = this.withCacheFingerprint(
        this.parseSummaryResponse(data, input),
        cacheFingerprint,
      );

      this.recordWebhookResult(result, input, mode, language);

      // 存储最近一次webhook调用的结果
      this.lastWebhookResult = {
        result,
        input,
        mode,
        language,
        timestamp: Date.now(),
      };

      // 将结果存入缓存
      if (useCache) {
        await this.cacheManager.setByFingerprint(
          cacheFingerprint,
          result,
          this.cacheSourceLabel(input),
        );
      }

      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(
          timedOut
            ? `请求超时（超过 ${Math.round(requestTimeoutMs / 60000)} 分钟未响应）`
            : '请求被取消',
        );
      }
      throw new Error(this.formatUserFacingError(error));
    } finally {
      window.clearTimeout(timeoutId);
      const activeController = this.controllers.get(noteName);
      if (activeController === controller) {
        this.controllers.delete(noteName);
      }
    }
  }

  /**
   * 简单处理视频（不更新笔记）
   */
  async processVideoSimple(
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage = 'zh',
    useCache: boolean = true,
    timeoutMinutes?: number,
  ): Promise<ProcessingResult> {
    input = this.withAnalysisDefaults(input);
    // 短链先展开再处理（缓存 key 也用展开后的链接）
    input = await this.resolveInputUrl(input);
    const cacheFingerprint = this.buildCacheFingerprint(input, mode, language);

    if (useCache) {
      const cachedResult = await this.cacheManager.getByFingerprint(cacheFingerprint);
      if (cachedResult) {
        if (this.debugMode) {
          console.debug(`[VideoSummaryAPI] 使用指纹缓存: ${cacheFingerprint.key}`);
        }
        return cachedResult;
      }
    }

    // 构建请求负载
    const payload = this.buildPayload('temp', input, mode, language);
    const requestTimeoutMs = this.resolveTimeoutMs(timeoutMinutes);

    // 此方法的 n8n 路径以前完全没有超时控制，挂起会永久阻塞；补上 AbortController + 超时
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      // 发送请求
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify(payload),
        requestTimeoutMs + 1000,
        controller.signal,
      );

      if (!response.ok) {
        throw new Error(await this.formatHttpError(response));
      }

      const data = await this.readJsonResponse(response);
      const result = this.withCacheFingerprint(
        this.parseSummaryResponse(data, input),
        cacheFingerprint,
      );

      this.recordWebhookResult(result, input, mode, language);

      // 存储最近一次webhook调用的结果
      this.lastWebhookResult = {
        result,
        input,
        mode,
        language,
        timestamp: Date.now(),
      };

      // 将结果存入缓存
      if (useCache) {
        await this.cacheManager.setByFingerprint(
          cacheFingerprint,
          result,
          this.cacheSourceLabel(input),
        );
      }

      return result;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(
          timedOut
            ? `请求超时（超过 ${Math.round(requestTimeoutMs / 60000)} 分钟未响应）`
            : '请求被取消',
        );
      }
      throw new Error(this.formatUserFacingError(error));
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  /**
   * 获取上次webhook调用的结果
   */
  getLastWebhookResult(): {
    result: ProcessingResult;
    input: VideoInput;
    mode: ProcessingMode;
    language: SupportedLanguage;
    timestamp: number;
  } | null {
    return this.lastWebhookResult;
  }

  getWebhookHistory(limit: number = this.webhookHistoryLimit) {
    return this.webhookHistory.slice(0, limit).map((entry) => ({ ...entry }));
  }

  normalizeWebhookPayload(data: unknown): ProcessingResult {
    return this.parseSummaryResponse(data);
  }

  setWebhookHistory(history: WebhookHistoryEntry[]) {
    this.webhookHistory = Array.isArray(history) ? [...history] : [];
    this.lastWebhookResult = this.webhookHistory[0] ?? null;
  }

  onWebhookHistoryChange(listener: (history: WebhookHistoryEntry[]) => void) {
    this.historyListener = listener;
  }

  // 取消指定笔记的请求。
  async cancelByNoteName(noteName: string): Promise<void> {
    const controller = this.controllers.get(noteName);
    if (!controller) return;

    controller.abort();
    this.controllers.delete(noteName);
  }

  // 缓存管理方法
  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    return this.cacheManager.getStats();
  }

  /**
   * 清空缓存
   */
  clearCache() {
    void this.cacheManager.clear();
  }

  /**
   * 清理过期缓存
   */
  cleanupCache() {
    void this.cacheManager.cleanup();
  }

  /**
   * 设置缓存配置
   */
  setCacheConfig(maxSize: number, expiryDays: number) {
    this.cacheManager.setConfig(maxSize, expiryDays);
  }

  /**
   * 启用或禁用缓存
   */
  setCacheEnabled(enabled: boolean) {
    this.cacheManager.setEnabled(enabled);
    // 如果禁用缓存，清空现有缓存
    if (!enabled) {
      this.cacheManager
        .clear()
        .catch((error) => console.error('[VideoSummaryAPI] 清空缓存失败:', error));
    }
  }

  /**
   * 检查URL是否有缓存
   */
  hasCache(url: string, mode: ProcessingMode, language: SupportedLanguage): boolean {
    return this.cacheManager.has(url, mode, language);
  }

  /**
   * 获取所有缓存项（用于预览）
   */
  async getAllCacheItems() {
    return await this.cacheManager.getAllItems();
  }

  /**
   * 删除单个缓存项
   */
  async removeCacheItem(url: string, mode: ProcessingMode, language: SupportedLanguage) {
    return await this.cacheManager.remove(url, mode, language);
  }

  /**
   * 获取单个缓存项内容（用于预览）
   */
  async getCacheItemContent(url: string, mode: ProcessingMode, language: SupportedLanguage) {
    return await this.cacheManager.getItemContent(url, mode, language);
  }

  /**
   * 直接设置缓存项（用于测试和管理）
   */
  async setCacheItem(
    url: string,
    mode: ProcessingMode,
    language: SupportedLanguage,
    result: ProcessingResult,
  ) {
    return await this.cacheManager.set(url, mode, language, result);
  }

  // 取消所有正在进行的请求
  async cancelAll(): Promise<void> {
    for (const [key, controller] of this.controllers.entries()) {
      controller.abort();
      this.controllers.delete(key);
    }
    await Promise.resolve();
  }

  private buildPayload(
    noteName: string,
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ) {
    const keys = this.payloadKeys;
    const metadata: JsonRecord = {};
    metadata[keys.mode] = mode;
    metadata[keys.language] = language;
    metadata[keys.ai] = this.aiModel;

    if (mode === 'info-only') {
      metadata[keys.info_only] = true;
    }

    // 添加输入数据
    if (input.url && !input.skipSourceFetch) {
      metadata[keys.link] = input.url;
    }
    if (input.transcript) {
      metadata[keys.provided_transcript] = input.transcript;
    }
    if (input.localFile && !input.skipSourceFetch) {
      metadata[keys.local_file] = input.localFile;
    }
    this.addAnalysisMetadata(metadata, input);

    return {
      name: noteName,
      metadata,
      content: '', // 正文内容
    };
  }

  private withAnalysisDefaults(input: VideoInput): VideoInput {
    const requestedDepth = input.processingDepth || this.analysisDefaults.processingDepth;
    return {
      ...input,
      processingDepth: requestedDepth === 'deep-visual' ? 'evidence' : requestedDepth,
      contentType: input.contentType || this.analysisDefaults.contentType,
      autoRoute: input.autoRoute ?? this.analysisDefaults.autoRoute,
      attentionAssessment: input.attentionAssessment ?? this.analysisDefaults.attentionAssessment,
      generateLearning: input.generateLearning ?? this.analysisDefaults.generateLearning,
    };
  }

  private buildCacheFingerprint(
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ): ArtifactFingerprint {
    const processingDepth = input.processingDepth || this.analysisDefaults.processingDepth;
    let visual: VisualFingerprintMode = 'keyframes';
    if (processingDepth === 'quick') visual = 'off';
    if (processingDepth === 'deep-visual') visual = 'deep';

    return buildArtifactFingerprint({
      input,
      mode,
      language,
      model: this.aiModel,
      backend: 'n8n',
      schemaVersion: CACHE_ARTIFACT_SCHEMA_VERSION,
      processingDepth,
      requestedContentType: input.contentType || this.analysisDefaults.contentType,
      autoRoute: input.autoRoute ?? this.analysisDefaults.autoRoute,
      visual,
      attention: input.attentionAssessment ?? this.analysisDefaults.attentionAssessment,
      learning: input.generateLearning ?? this.analysisDefaults.generateLearning,
      promptVersion: CACHE_PROMPT_VERSION,
    });
  }

  private withCacheFingerprint(
    result: ProcessingResult,
    fingerprint: ArtifactFingerprint,
  ): ProcessingResult {
    return {
      ...result,
      artifact: {
        ...(result.artifact || {}),
        schema_version: fingerprint.run.schema_version,
        source_hash: fingerprint.source.source_hash,
        transcript_hash: fingerprint.source.transcript_hash || result.artifact?.transcript_hash,
        backend: fingerprint.run.backend,
        model: fingerprint.run.model,
        prompt_version: fingerprint.run.prompt_version,
        processing_depth: fingerprint.run.processing_depth,
        fingerprint_version: fingerprint.version,
        fingerprint: fingerprint.key,
        fingerprint_digest: fingerprint.digest,
        run_hash: fingerprint.run_hash,
      },
    };
  }

  private cacheSourceLabel(input: VideoInput): string {
    return (
      input.url ||
      input.sourceUrl ||
      input.localFile ||
      input.localFiles?.filter(Boolean).join(', ') ||
      (input.transcript ? 'provided-transcript' : '')
    );
  }

  private addAnalysisMetadata(metadata: JsonRecord, input: VideoInput) {
    const contentType = input.contentType || this.analysisDefaults.contentType;
    const autoRoute = input.autoRoute ?? this.analysisDefaults.autoRoute;
    const contract = buildContentRoutingPromptContract(contentType, autoRoute);
    metadata.artifact_schema_version = CACHE_ARTIFACT_SCHEMA_VERSION;
    metadata.prompt_version = CACHE_PROMPT_VERSION;
    metadata.processing_depth = input.processingDepth || this.analysisDefaults.processingDepth;
    metadata.content_type = contentType;
    metadata.auto_route = autoRoute;
    metadata.content_router_contract = contract;
    metadata.prompt_profile =
      contentType === 'auto' ? CONTENT_ROUTER_CONTRACT_VERSION : contract.profiles[0]?.id;
    metadata.attention_assessment =
      input.attentionAssessment ?? this.analysisDefaults.attentionAssessment;
    metadata.generate_learning = input.generateLearning ?? this.analysisDefaults.generateLearning;
    if (input.skipSourceFetch) {
      metadata.skip_source_fetch = true;
      if (input.sourceUrl) metadata.source_url_for_citation = input.sourceUrl;
      if (input.persistedSegments?.length) {
        metadata.persisted_video_segments = input.persistedSegments;
      }
      if (input.persistedEvidenceClaims?.length) {
        metadata.persisted_evidence_claims = input.persistedEvidenceClaims;
      }
      if (input.persistedVisualEvidence?.length) {
        metadata.persisted_visual_evidence = input.persistedVisualEvidence;
      }
      if (input.persistedRun) metadata.persisted_run = input.persistedRun;
    }
    if (input.artifactId) metadata.artifact_id = input.artifactId;
    if (input.highlightedSegmentIds?.length) {
      metadata.highlighted_segment_ids = Array.from(new Set(input.highlightedSegmentIds));
    }
    metadata.requested_capabilities = [
      'artifact-v3',
      'timestamped-segments',
      'evidence-claims',
      ...(metadata.processing_depth === 'quick' ? [] : ['visual-evidence']),
      ...(metadata.attention_assessment ? ['attention-assessment'] : []),
      ...(metadata.generate_learning ? ['learning-package'] : []),
    ];
  }

  private recordWebhookResult(
    result: ProcessingResult,
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ) {
    const entry = {
      result,
      input,
      mode,
      language,
      timestamp: Date.now(),
    };
    this.lastWebhookResult = entry;
    this.webhookHistory.unshift(entry);
    if (this.webhookHistory.length > this.webhookHistoryLimit) {
      this.webhookHistory = this.webhookHistory.slice(0, this.webhookHistoryLimit);
    }
    if (this.historyListener) {
      this.historyListener(this.webhookHistory.map((item) => ({ ...item })));
    }
  }

  private truncateError(value: string, max: number): string {
    if (!value || value.length <= max) return value || '';
    return `${value.slice(0, max)}...`;
  }

  private nextControllerKey(prefix: string): string {
    this.controllerSequence += 1;
    return `${prefix}:${Date.now().toString(36)}:${this.controllerSequence.toString(36)}`;
  }

  private resolveTimeoutMs(timeoutMinutes?: number): number {
    const normalizedMinutes = Number(timeoutMinutes);
    if (!Number.isFinite(normalizedMinutes) || normalizedMinutes <= 0) {
      return this.timeout;
    }
    return normalizedMinutes * 60 * 1000;
  }

  private static isSuccessfulStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }

  /** Network layer for webhook calls; Obsidian's requestUrl by default, replaceable in tests. */
  static transport: (request: RequestUrlParam) => Promise<RequestUrlResponse> = (request) =>
    import('obsidian').then(({ requestUrl }) => requestUrl(request));

  /**
   * n8n webhook calls go through Obsidian's native request layer (no browser fetch, no CORS),
   * wrapped as a Response so the existing error and JSON readers keep working.
   */
  private static async webhookRequest(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await VideoSummaryAPI.nativeRequest(
      { url, method: 'POST', contentType: 'application/json', headers, body },
      timeoutMs,
      signal,
    );
    if (response.status < 200 || response.status > 599) {
      throw new Error(`HTTP ${response.status}`);
    }
    const emptyBody = [204, 205, 304].includes(response.status);
    return new Response(emptyBody ? null : response.text, { status: response.status });
  }

  private static async nativeRequest(
    request: RequestUrlParam,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RequestUrlResponse> {
    const safeTimeoutMs = Math.max(1, Math.floor(Number(timeoutMs) || 1));
    let timeoutId: number | undefined;
    let onAbort: (() => void) | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(() => {
        const error = new Error(`${safeTimeoutMs}ms 内无响应（服务可能未启动）`);
        error.name = 'TimeoutError';
        reject(error);
      }, safeTimeoutMs);
    });
    const requests: Array<Promise<RequestUrlResponse> | Promise<never>> = [
      VideoSummaryAPI.transport({ ...request, throw: false }),
      timeoutPromise,
    ];

    if (signal) {
      requests.push(
        new Promise<never>((_, reject) => {
          onAbort = () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      );
    }

    try {
      return await Promise.race(requests);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private parseSummaryResponse(data: unknown, input: VideoInput = {}): ProcessingResult {
    // n8n 可能返回数组，需要合并所有对象的数据
    const preserveKeys = new Set(['summary', 'note', 'video_transcript']);
    let merged: unknown = data;

    if (Array.isArray(data)) {
      const combined: JsonRecord = {};
      for (const item of data) {
        if (!isRecord(item)) continue;
        for (const [key, value] of Object.entries(item)) {
          if (value === undefined || value === null) continue;
          if (preserveKeys.has(key)) {
            if (combined[key] === undefined || combined[key] === null || combined[key] === '') {
              combined[key] = value;
            }
            continue;
          }
          combined[key] = value;
        }
      }
      merged = combined;
    }

    const unwrapped = this.unwrapResponsePayload(merged);

    // 检查是否是错误响应
    if (isRecord(unwrapped) && unwrapped.error) {
      throw new Error(asText(unwrapped.error) ?? JSON.stringify(unwrapped.error));
    }

    // 检查数据是否为空或无效
    if (!isRecord(unwrapped)) {
      throw new Error('服务器返回无效的数据格式');
    }
    const payload = unwrapped;

    // 兼容 info-only/summary 混合数据的字段命名（支持嵌套结构）
    const infoSources: unknown[] = [
      payload,
      payload.info,
      payload.videoInfo,
      payload.video_info,
      payload.metadata,
    ];

    const pickField = (aliases: string[]): string | undefined => {
      for (const source of infoSources) {
        if (!isRecord(source)) continue;
        for (const key of aliases) {
          const value = source[key];
          if (typeof value === 'string' && value.trim()) {
            return value.trim();
          }
        }
      }
      return undefined;
    };

    const normalizedTitle = pickField(['video_title', 'title', 'name']);
    if (normalizedTitle) {
      payload.video_title = normalizedTitle;
    }

    const normalizedAuthor = pickField([
      'video_author',
      'author',
      'channel',
      'creator',
      'uploader',
      'up',
    ]);
    if (normalizedAuthor) {
      payload.video_author = normalizedAuthor;
    }

    const normalizedDuration = pickField(['video_duration', 'duration']);
    if (normalizedDuration) {
      payload.video_duration = normalizedDuration;
    }

    const normalizedCover = pickField([
      'video_cover',
      'cover',
      'thumbnail',
      'thumbnail_url',
      'thumbnailUrl',
    ]);
    if (normalizedCover) {
      payload.video_cover = normalizedCover;
    }

    // 解析成功响应
    const result: ProcessingResult = {};

    if (payload.summary && typeof payload.summary === 'string') {
      result.summary = payload.summary;
    }
    if (payload.note && typeof payload.note === 'string') {
      // 处理换行符
      result.note = payload.note.replace(/\\n/g, '\n');
    }
    if (payload.video_transcript && typeof payload.video_transcript === 'string') {
      result.video_transcript = payload.video_transcript;
    }
    if (payload.video_title && typeof payload.video_title === 'string') {
      result.video_title = payload.video_title;
    }
    if (payload.video_author && typeof payload.video_author === 'string') {
      result.video_author = payload.video_author;
    }
    if (payload.video_duration && typeof payload.video_duration === 'string') {
      result.video_duration = payload.video_duration;
    }
    if (payload.video_cover && typeof payload.video_cover === 'string') {
      result.video_cover = payload.video_cover;
    }

    const hasRichPayload = [
      payload.video_segments,
      payload.evidence_claims,
      payload.visual_evidence,
      payload.attention,
      payload.learning,
      payload.artifact,
    ].some((value) => value !== undefined && value !== null);
    if (Object.keys(result).length === 0 && !hasRichPayload) {
      throw new Error('服务器返回的数据中没有有效内容');
    }

    return normalizeRichProcessingResult(result, payload, {
      sourceUrl: input.sourceUrl || input.url,
      backend: 'n8n',
      model: this.aiModel,
      processingDepth: input.processingDepth,
      promptVersion: CACHE_PROMPT_VERSION,
      requestedContentType: input.contentType,
      autoRoute: input.autoRoute,
    });
  }

  private unwrapResponsePayload(payload: unknown): unknown {
    if (!isRecord(payload)) {
      return payload;
    }

    const candidateKeys = ['data', 'result', 'output', 'response'];
    for (const key of candidateKeys) {
      const candidate = payload[key];
      if (isRecord(candidate)) {
        const hasResultField = [
          'summary',
          'note',
          'video_transcript',
          'video_title',
          'video_author',
          'video_duration',
          'video_cover',
          'video_segments',
          'evidence_claims',
          'visual_evidence',
          'content_type',
          'content_routing',
          'attention',
          'learning',
          'artifact',
          'cover',
          'thumbnail',
          'metadata',
          'info',
        ].some((field) => candidate[field] !== undefined);
        if (hasResultField) {
          return candidate;
        }
      }
    }

    return payload;
  }

  // 批量处理API - 支持实时回调
  async batchProcess(
    requests: Array<{
      noteName: string;
      input: VideoInput;
      mode: ProcessingMode;
      language: SupportedLanguage;
    }>,
    concurrency: number = 3,
    onProgress?: (result: {
      success: boolean;
      result?: ProcessingResult;
      error?: string;
      noteName: string;
      index: number;
    }) => void | Promise<void>,
    useCache: boolean = true,
  ): Promise<
    Array<{ success: boolean; result?: ProcessingResult; error?: string; noteName: string }>
  > {
    const results: Array<{
      success: boolean;
      result?: ProcessingResult;
      error?: string;
      noteName: string;
    }> = [];
    const chunks = this.chunkArray(requests, concurrency);

    for (const chunk of chunks) {
      const chunkPromises = chunk.map(async (request, chunkIndex) => {
        const globalIndex = results.length + chunkIndex;
        try {
          const result = await this.processVideo(
            request.noteName,
            request.input,
            request.mode,
            request.language,
            useCache,
          );

          const resultObj = {
            success: true,
            result,
            noteName: request.noteName,
          };

          // 实时回调
          if (onProgress) {
            await onProgress({ ...resultObj, index: globalIndex });
          }

          return resultObj;
        } catch (error) {
          const errorObj = {
            success: false,
            error: errorMessage(error),
            noteName: request.noteName,
          };

          // 实时回调
          if (onProgress) {
            await onProgress({ ...errorObj, index: globalIndex });
          }

          return errorObj;
        }
      });

      const chunkResults = await Promise.all(chunkPromises);
      results.push(...chunkResults);
    }

    return results;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    const safeSize = Math.max(1, Math.floor(Number(size) || 1));
    for (let i = 0; i < array.length; i += safeSize) {
      chunks.push(array.slice(i, i + safeSize));
    }
    return chunks;
  }

  /**
   * 轻量健康自检：只判断"服务是否可达/webhook 是否存在"，不做完整诊断。
   * 用于处理前 preflight，几秒内返回。
   */
  async quickHealthCheck(timeoutMs = 4000): Promise<EndpointProbeResult> {
    return VideoSummaryAPI.probeEndpoint(
      this.webhookUrl,
      timeoutMs,
      this.buildConnectionTestPayload(),
      this.webhookAuth,
    );
  }

  /** 向 n8n 端点 POST 测试 payload，只有 2xx 算可用。 */
  static async probeEndpoint(
    url: string,
    timeoutMs = 4000,
    n8nBody?: unknown,
    n8nAuth?: Partial<WebhookAuthConfig>,
  ): Promise<EndpointProbeResult> {
    if (!url || !url.trim()) {
      return { ok: false, error: tr('服务 URL 未配置', 'Service URL not set') };
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = n8nBody ?? {
        name: 'preflight-check',
        metadata: { mode: 'transcript-only', language: 'zh', ai: '' },
        content: '',
      };
      const response = await VideoSummaryAPI.webhookRequest(
        url,
        VideoSummaryAPI.buildN8nHeaders(n8nAuth),
        JSON.stringify(body),
        timeoutMs + 1000,
        controller.signal,
      );
      if (response.status === 404) {
        return {
          ok: false,
          error: tr(
            'HTTP 404 — webhook 不存在或 workflow 未激活',
            'HTTP 404 — the webhook does not exist or the workflow is not active',
          ),
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: tr(
            `HTTP ${response.status} — webhook 健康检查失败`,
            `HTTP ${response.status} — webhook health check failed`,
          ),
        };
      }
      return { ok: true };
    } catch (error) {
      const message =
        (error as Error)?.name === 'AbortError'
          ? tr(
              `${timeoutMs}ms 内无响应（服务可能未启动）`,
              `No answer within ${timeoutMs}ms (the service may not be running)`,
            )
          : (error as Error)?.message || String(error);
      return { ok: false, error: message };
    } finally {
      window.clearTimeout(timer);
    }
  }

  // 测试连接（返回耗时、响应片段和下一步建议，便于诊断）
  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();

    try {
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify(this.buildConnectionTestPayload()),
        this.resolveTimeoutMs(),
      );

      const durationMs = Date.now() - started;
      const text = await response.text();
      const snippet = this.redactWebhookSecret((text || '').slice(0, 180));

      if (!response.ok) {
        const error = await this.formatHttpError(response, text);
        return {
          success: false,
          durationMs,
          status: response.status,
          bodySnippet: snippet,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      if (!text || text.trim() === '') {
        const error = tr('服务器返回空响应', 'The server returned an empty response');
        return {
          success: false,
          durationMs,
          status: response.status,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      const parsed = this.tryParseJson(text);
      if (!parsed) {
        if (this.isConnectionTestSuccessText(text)) {
          return {
            success: true,
            durationMs,
            status: response.status,
            bodySnippet: snippet,
            warnings: [
              tr(
                '当前工作流测试分支未返回版本信息。建议重新导入仓库内最新 workflow。',
                "This workflow's test branch returned no version. Import the latest workflow from the repository again.",
              ),
            ],
          };
        }

        const error = tr('服务器返回的不是 JSON', 'The server did not return JSON');
        return {
          success: false,
          durationMs,
          status: response.status,
          bodySnippet: snippet,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      if (isRecord(parsed) && parsed.error) {
        const error = this.redactWebhookSecret(this.errorToString(parsed.error));
        return {
          success: false,
          durationMs,
          status: response.status,
          bodySnippet: snippet,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      const workflow = this.extractWorkflowHealthInfo(parsed);
      return {
        success: true,
        durationMs,
        status: response.status,
        bodySnippet: snippet,
        workflow,
        warnings: this.getWorkflowCompatibilityWarnings(workflow),
      };
    } catch (error) {
      const message = this.formatUserFacingError(error);
      return {
        success: false,
        durationMs: Date.now() - started,
        error: message,
        hint: this.getConnectionHint(message),
      };
    }
  }

  /**
   * Ask the packaged backend for its health report. `deep` also lists the model provider's models
   * and transcribes a one-second sample, which proves both keys work.
   */
  async checkBackend(
    deep: boolean,
  ): Promise<{ status?: number; error?: string; report?: unknown }> {
    try {
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify({ name: 'test', metadata: deep ? { check: 'deep' } : {}, content: '' }),
        deep ? 120_000 : 15_000,
      );
      const text = await response.text();
      return { status: response.status, report: this.tryParseJson(text) ?? undefined };
    } catch (error) {
      return { error: this.redactWebhookSecret(this.errorToString(error)) };
    }
  }

  /** Save a Netscape cookies.txt for one platform into the backend's cookies folder. */
  async uploadCookies(
    platform: string,
    cookies: string,
  ): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify({ name: 'save-cookies', metadata: { platform, cookies }, content: '' }),
        30_000,
      );
      const parsed = this.tryParseJson(await response.text());
      if (response.ok && isRecord(parsed) && parsed.ok === true) {
        return {
          ok: true,
          message: tr(
            `已保存 ${String(parsed.cookies)} 条 cookie。`,
            `Saved ${String(parsed.cookies)} cookies.`,
          ),
        };
      }
      return {
        ok: false,
        message:
          response.status === 500
            ? tr(
                '后端没接受这段内容：需要浏览器扩展导出的 cookies.txt（每行用 Tab 分隔的 7 列），并且包含这个网站的 cookie。',
                "The backend did not accept this: it needs a cookies.txt exported by a browser extension (7 tab-separated columns per line) that contains this site's cookies.",
              )
            : this.formatUserFacingError(new Error(`HTTP ${response.status}`)),
      };
    } catch (error) {
      return { ok: false, message: this.formatUserFacingError(error) };
    }
  }

  /** Summarise a short built-in text end to end; proves the model really answers. */
  async trialRun(
    sample: string,
    language: SupportedLanguage = 'zh',
  ): Promise<{ ok: boolean; durationMs: number; message: string }> {
    const started = Date.now();
    try {
      const response = await VideoSummaryAPI.webhookRequest(
        this.webhookUrl,
        this.buildN8nHeaders(),
        JSON.stringify(
          this.buildPayload(
            tr('首次配置试运行', 'First-run trial'),
            { transcript: sample },
            'summary',
            language,
          ),
        ),
        180_000,
      );
      const parsed = this.tryParseJson(await response.text());
      const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
      const summary = isRecord(first) ? this.readString(first.summary) || '' : '';
      const durationMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          durationMs,
          message: this.formatUserFacingError(new Error(`HTTP ${response.status}`)),
        };
      }
      if (!summary || summary.startsWith('Error')) {
        return {
          ok: false,
          durationMs,
          message:
            summary.replace(/^Error:\s*/, '') ||
            tr('后端没有返回总结。', 'The backend returned no summary.'),
        };
      }
      // The summary is one or two sentences; cut only a runaway reply, and say that it was cut.
      const message = summary.length > 400 ? `${summary.slice(0, 400)}…` : summary;
      return { ok: true, durationMs, message };
    } catch (error) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        message: this.formatUserFacingError(error),
      };
    }
  }

  private buildConnectionTestPayload() {
    return this.buildPayload('test', {}, 'transcript-only', 'zh');
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private isConnectionTestSuccessText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return ['测试成功', '测试成功！', 'ok', 'success'].includes(normalized);
  }

  private extractWorkflowHealthInfo(payload: unknown): WorkflowHealthInfo | undefined {
    const source = asRecord(payload);
    const candidate =
      source.workflow || source.videoSummaryWorkflow || asRecord(source.health).workflow;
    if (!isRecord(candidate)) {
      return undefined;
    }
    const workflow = candidate;

    return {
      name: this.readString(workflow.name),
      version: this.readString(workflow.version),
      variant: this.readString(workflow.variant),
      webhookPath: this.readString(workflow.webhookPath || workflow.webhook_path),
      models: this.readStringArray(workflow.models),
      requiredTools: this.readStringArray(workflow.requiredTools || workflow.required_tools),
      uploadsPath: this.readString(workflow.uploadsPath || workflow.uploads_path),
    };
  }

  private getWorkflowCompatibilityWarnings(workflow?: WorkflowHealthInfo): string[] {
    if (!workflow) {
      return [
        tr(
          '当前工作流未返回版本信息。建议重新导入仓库内最新 workflow 后再运行诊断。',
          'This workflow returned no version. Import the latest workflow from the repository, then run diagnostics again.',
        ),
      ];
    }

    const warnings: string[] = [];
    if (workflow.version && workflow.version !== RECOMMENDED_WORKFLOW.version) {
      warnings.push(
        tr(
          `当前 workflow 版本是 ${workflow.version}，推荐版本是 ${RECOMMENDED_WORKFLOW.version}。`,
          `This workflow is version ${workflow.version}; the recommended version is ${RECOMMENDED_WORKFLOW.version}.`,
        ),
      );
    }
    if (!workflow.version) {
      warnings.push(
        tr(
          `workflow 未声明版本。推荐版本是 ${RECOMMENDED_WORKFLOW.version}。`,
          `The workflow declares no version. The recommended version is ${RECOMMENDED_WORKFLOW.version}.`,
        ),
      );
    }
    if (workflow.webhookPath && workflow.webhookPath !== RECOMMENDED_WORKFLOW.webhookPath) {
      warnings.push(
        tr(
          `当前 webhook path 是 ${workflow.webhookPath}，推荐 path 是 ${RECOMMENDED_WORKFLOW.webhookPath}。`,
          `This webhook path is ${workflow.webhookPath}; the recommended path is ${RECOMMENDED_WORKFLOW.webhookPath}.`,
        ),
      );
    }
    const models = workflow.models || [];
    const missingModels = RECOMMENDED_WORKFLOW.models.filter((model) => !models.includes(model));
    if (models.length > 0 && missingModels.length > 0) {
      warnings.push(
        tr(
          `workflow 未声明推荐模型标签: ${missingModels.join(', ')}。`,
          `The workflow does not declare the recommended model tags: ${missingModels.join(', ')}.`,
        ),
      );
    }
    const tools = workflow.requiredTools || [];
    const missingTools = RECOMMENDED_WORKFLOW.requiredTools.filter((tool) => !tools.includes(tool));
    if (tools.length > 0 && missingTools.length > 0) {
      warnings.push(
        tr(
          `workflow 未声明推荐媒体工具: ${missingTools.join(', ')}。`,
          `The workflow does not declare the recommended media tools: ${missingTools.join(', ')}.`,
        ),
      );
    }

    return warnings;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values = (value as unknown[]).filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '',
    );
    return values.length > 0 ? values.map((item) => item.trim()) : undefined;
  }

  private async readJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text || text.trim() === '') {
      throw new Error('服务器返回空响应');
    }

    const parsed = this.tryParseJson(text);
    if (!parsed) {
      throw new Error(
        `服务器返回的不是 JSON。响应片段: ${this.redactWebhookSecret(this.truncateError(text, 180))}`,
      );
    }

    return parsed;
  }

  private async formatHttpError(response: Response, bodyText?: string): Promise<string> {
    let text = bodyText;
    if (text === undefined) {
      try {
        text = await response.text();
      } catch {
        text = '';
      }
    }

    const snippet = text
      ? `。响应片段: ${this.redactWebhookSecret(this.truncateError(text, 180))}`
      : '';
    return `HTTP ${response.status} ${response.statusText}${snippet}`;
  }

  formatUserFacingError(error: unknown): string {
    const message = this.redactWebhookSecret(this.errorToString(error));
    const lower = message.toLowerCase();

    if (message.includes('请求被取消')) {
      return tr('请求已取消。', 'Request cancelled.');
    }

    if (message.includes('HTTP 404')) {
      return tr(
        `后端还没准备好，或者地址不对。第一次启动要等一分钟左右；如果一直这样，确认连接码里的端口和启动脚本显示的一致。当前地址: ${this.webhookUrl}`,
        `The backend is not ready yet, or the address is wrong. The first start takes about a minute; if it stays like this, check that the port in the connection code matches the start script. Current address: ${this.webhookUrl}`,
      );
    }

    if (message.includes('HTTP 401') || message.includes('HTTP 403')) {
      return tr(
        '后端拒绝了这个连接码。在后端文件夹运行 vs-backend code，把连接码重新粘贴到设置的“首次配置”。',
        'The backend rejected this connection code. Run vs-backend code in the backend folder and paste the code again into first-run setup.',
      );
    }

    if (
      lower.includes('bilibili') &&
      (lower.includes('http error 412') || lower.includes('precondition failed'))
    ) {
      return tr(
        'B 站拒绝了下载请求。先在首次配置里扫码登录 B 站；仍失败时换新版后端，新版带新的下载器。',
        'Bilibili refused the download. Log in to Bilibili in first-run setup; if it still fails, install the newest backend, which comes with a newer downloader.',
      );
    }

    if (lower.includes('yt-dlp') && lower.includes('not found')) {
      return tr(
        '后端缺少 yt-dlp。请用后端安装包里的启动脚本启动，不要用官方 n8n 镜像。',
        'The backend has no yt-dlp. Start it with the start script from the backend package, not the official n8n image.',
      );
    }

    if (lower.includes('ffmpeg') && lower.includes('not found')) {
      return tr(
        '后端缺少 ffmpeg。请用后端安装包里的启动脚本启动，不要用官方 n8n 镜像。',
        'The backend has no ffmpeg. Start it with the start script from the backend package, not the official n8n image.',
      );
    }

    if (
      message.includes('HTTP 500') ||
      message.includes('HTTP 502') ||
      message.includes('HTTP 503')
    ) {
      return tr(
        `后端处理时出错。在后端文件夹运行 vs-backend logs 查看日志。原始错误: ${message}`,
        `The backend failed while processing. Run vs-backend logs in the backend folder. Original error: ${message}`,
      );
    }

    if (
      lower.includes('failed to fetch') ||
      lower.includes('load failed') ||
      lower.includes('networkerror') ||
      lower.includes('connection refused')
    ) {
      return tr(
        `无法连接后端。先打开 Docker，再在后端文件夹运行启动脚本。当前地址: ${this.webhookUrl}`,
        `Cannot reach the backend. Open Docker, then run the start script in the backend folder. Current address: ${this.webhookUrl}`,
      );
    }

    if (message.includes('服务器返回空响应')) {
      return tr(
        '服务器返回空响应。请确认 n8n workflow 已激活，并且 Respond to Webhook 节点已连到测试/处理分支。',
        'The server returned an empty response. Check that the n8n workflow is active and the Respond to Webhook node is connected.',
      );
    }

    if (message.includes('服务器返回的不是 JSON')) {
      return tr(
        `${message}。请确认 URL 指向 n8n Webhook，而不是 n8n 登录页、反向代理错误页或普通网页。`,
        `${message}. Make sure the URL points at the n8n webhook, not the n8n login page, a proxy error page or a normal web page.`,
      );
    }

    if (message.includes('服务器返回的数据中没有有效内容')) {
      return tr(
        '处理服务已响应，但没有返回 summary、note、video_transcript 或视频信息字段。请检查 n8n 最后的 Respond to Webhook 输出。',
        'The backend answered without summary, note, video_transcript or video info fields. Check the last Respond: Result node in n8n.',
      );
    }

    return (
      message ||
      tr(
        '未知错误。请打开调试模式后重试，并查看 Obsidian 开发者控制台。',
        "Unknown error. Turn on debug mode, try again and check Obsidian's developer console.",
      )
    );
  }

  private getConnectionHint(message: string): string {
    if (/Webhook 不存在|HTTP 404|后端还没准备好|not ready yet/.test(message)) {
      return tr(
        '等一分钟再试；仍不行就重新运行启动脚本，并重新粘贴它显示的连接码。',
        'Wait a minute and try again; if it still fails, run the start script again and paste the connection code it shows.',
      );
    }

    if (/无法连接处理服务|无法连接后端|Cannot reach the backend/.test(message)) {
      return tr(
        '先打开 Docker，再在后端文件夹运行启动脚本（macOS 双击 start-mac.command，Windows 双击 start-windows.cmd）。',
        'Open Docker, then run the start script in the backend folder (macOS: double-click start-mac.command; Windows: double-click start-windows.cmd).',
      );
    }

    if (/Bilibili 拒绝|B 站拒绝|Bilibili refused/.test(message)) {
      return tr(
        '先在首次配置里扫码登录 B 站；仍失败时换新版后端。',
        'Log in to Bilibili in first-run setup; if it still fails, install the newest backend.',
      );
    }

    if (/空响应|empty response/.test(message)) {
      return tr(
        '检查 Respond: Health Report 节点是否仍连接在测试分支上。',
        'Check that the Respond: Health Report node is still connected to the test branch.',
      );
    }

    if (/不是 JSON|没有有效内容|not JSON|without summary/.test(message)) {
      return tr(
        '检查最后一个 Respond: Result 节点，确保返回 JSON，且包含 note、summary、video_transcript 或 video_title。',
        'Check the last Respond: Result node: it must return JSON with note, summary, video_transcript or video_title.',
      );
    }

    if (/拒绝访问|refused access|rejected this connection code/.test(message)) {
      return tr(
        '如果你使用远程 n8n，请检查登录、反向代理和 CORS/鉴权配置。',
        'If you use a remote n8n, check login, reverse proxy and CORS/auth settings.',
      );
    }

    return tr(
      '打开 Obsidian 设置里的调试模式，然后查看 n8n Execution 日志定位失败节点。',
      'Turn on debug mode in Obsidian settings, then read the n8n execution log to find the failing node.',
    );
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return errorMessage(error);
    }
    if (typeof error === 'string') {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
