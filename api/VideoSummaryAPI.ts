// agent: codex (2026-05-21)
// agent: claude (2026-07-02) — 短链自动展开 + quickHealthCheck/probeEndpoint
import {
  ProcessingBackend,
  ProcessingMode,
  SupportedLanguage,
  VideoInput,
  ProcessingResult,
  WebhookHistoryEntry,
  ConnectionTestResult,
  WorkflowHealthInfo,
  ProcessingDepth,
  RequestedContentType,
} from '../types';
import { CacheManager } from '../utils/CacheManager';
import { UrlResolver } from '../utils/UrlResolver';
import type { Vault } from 'obsidian';
import { RECOMMENDED_WORKFLOW } from '../constants';
import { normalizeRichProcessingResult } from '../core/KnowledgeModel';
import {
  buildArtifactFingerprint,
  type ArtifactFingerprint,
  type VisualFingerprintMode,
} from '../core/ArtifactFingerprint';

const CACHE_ARTIFACT_SCHEMA_VERSION = 3;
const CACHE_PROMPT_VERSION = 'video-knowledge-v3';

export interface EndpointProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * 处理进度回调。只有会轮询任务状态的后端（codex-worker）能上报阶段；
 * n8n 是一次性 POST，拿不到中间态，此时回调不会被调用，界面只显示计时。
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
  private aiModel: string = 'Gemini 3.1';
  private backend: ProcessingBackend = 'n8n';
  private cacheManager: CacheManager;
  private payloadKeys: any;
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
  constructor(
    webhookUrl: string,
    vault: Vault,
    pluginDataPath?: string,
    payloadKeys?: any,
    backend?: ProcessingBackend,
  ) {
    this.webhookUrl = webhookUrl;
    this.timeout = 10 * 60 * 1000; // Codex Worker 需要等待下载字幕/总结，默认 10 分钟
    this.backend = backend || 'n8n';
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

  setPayloadKeys(keys: any) {
    this.payloadKeys = keys;
  }

  setEndpoint(url: string, backend: ProcessingBackend = this.backend) {
    this.webhookUrl = url;
    this.backend = backend;
  }

  setBackend(backend: ProcessingBackend) {
    this.backend = backend;
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
        if (this.debugMode) {
          console.log(`[VideoSummaryAPI] 短链已展开: ${input.url} -> ${expanded}`);
        }
        return { ...input, url: expanded };
      }
    } catch (error) {
      if (this.debugMode) {
        console.warn('[VideoSummaryAPI] 短链展开失败，使用原链接', error);
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
          console.log(`[VideoSummaryAPI] 使用指纹缓存: ${cacheFingerprint.key}`);
        }
        onProgress?.({ stageLabel: '命中缓存', progress: 1, message: '命中缓存，未请求后端' });
        return cachedResult;
      }
    }

    // 构建请求负载
    const payload = this.buildPayload(noteName, input, mode, language);

    if (this.backend === 'codex-worker') {
      try {
        const result = this.withCacheFingerprint(
          await this.processCodexWorkerJob(payload, onProgress),
          cacheFingerprint,
        );
        this.recordWebhookResult(result, input, mode, language);

        this.lastWebhookResult = {
          result,
          input,
          mode,
          language,
          timestamp: Date.now(),
        };

        if (useCache) {
          await this.cacheManager.setByFingerprint(
            cacheFingerprint,
            result,
            this.cacheSourceLabel(input),
          );
        }

        return result;
      } catch (error) {
        throw new Error(this.formatUserFacingError(error));
      }
    }

    // 创建并注册中止控制器（同名任务仅允许一个并行请求）
    const controller = new AbortController();
    const existingController = this.controllers.get(noteName);
    if (existingController) {
      existingController.abort();
    }
    this.controllers.set(noteName, controller);

    // n8n 路径以前建了 AbortController 却从不超时，挂起请求会永久卡住；这里挂上真正的超时
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

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
            ? `请求超时（超过 ${Math.round(this.timeout / 60000)} 分钟未响应）`
            : '请求被取消',
        );
      }
      throw new Error(this.formatUserFacingError(error));
    } finally {
      clearTimeout(timeoutId);
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
  ): Promise<ProcessingResult> {
    input = this.withAnalysisDefaults(input);
    // 短链先展开再处理（缓存 key 也用展开后的链接）
    input = await this.resolveInputUrl(input);
    const cacheFingerprint = this.buildCacheFingerprint(input, mode, language);

    if (useCache) {
      const cachedResult = await this.cacheManager.getByFingerprint(cacheFingerprint);
      if (cachedResult) {
        if (this.debugMode) {
          console.log(`[VideoSummaryAPI] 使用指纹缓存: ${cacheFingerprint.key}`);
        }
        return cachedResult;
      }
    }

    // 构建请求负载
    const payload = this.buildPayload('temp', input, mode, language);

    if (this.backend === 'codex-worker') {
      try {
        const result = this.withCacheFingerprint(
          await this.processCodexWorkerJob(payload),
          cacheFingerprint,
        );
        this.recordWebhookResult(result, input, mode, language);

        this.lastWebhookResult = {
          result,
          input,
          mode,
          language,
          timestamp: Date.now(),
        };

        if (useCache) {
          await this.cacheManager.setByFingerprint(
            cacheFingerprint,
            result,
            this.cacheSourceLabel(input),
          );
        }

        return result;
      } catch (error) {
        throw new Error(this.formatUserFacingError(error));
      }
    }

    // 此方法的 n8n 路径以前完全没有超时控制，挂起会永久阻塞；补上 AbortController + 超时
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);

    try {
      // 发送请求
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

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
            ? `请求超时（超过 ${Math.round(this.timeout / 60000)} 分钟未响应）`
            : '请求被取消',
        );
      }
      throw new Error(this.formatUserFacingError(error));
    } finally {
      clearTimeout(timeoutId);
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

  normalizeWebhookPayload(data: any): ProcessingResult {
    return this.parseSummaryResponse(data);
  }

  setWebhookHistory(history: WebhookHistoryEntry[]) {
    this.webhookHistory = Array.isArray(history) ? [...history] : [];
    this.lastWebhookResult = this.webhookHistory[0] ?? null;
  }

  onWebhookHistoryChange(listener: (history: WebhookHistoryEntry[]) => void) {
    this.historyListener = listener;
  }

  // 取消指定笔记的请求
  cancelByNoteName(noteName: string) {
    const controller = this.controllers.get(noteName);
    if (controller) {
      controller.abort();
      this.controllers.delete(noteName);
    }
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
    this.cacheManager.clear();
  }

  /**
   * 清理过期缓存
   */
  cleanupCache() {
    this.cacheManager.cleanup();
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
  cancelAll() {
    for (const [key, controller] of this.controllers.entries()) {
      controller.abort();
      this.controllers.delete(key);
    }
  }

  private buildPayload(
    noteName: string,
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ) {
    if (this.backend === 'codex-worker') {
      return this.buildCodexWorkerPayload(noteName, input, mode, language);
    }

    const keys = this.payloadKeys;
    const metadata: any = {};
    metadata[keys.mode] = mode;
    metadata[keys.language] = language;
    metadata[keys.ai] = this.aiModel;

    if (mode === 'info-only') {
      metadata[keys.info_only] = true;
    }

    // 添加输入数据
    if (input.url) {
      metadata[keys.link] = input.url;
    }
    if (input.transcript) {
      metadata[keys.provided_transcript] = input.transcript;
    }
    if (input.localFile) {
      metadata[keys.local_file] = input.localFile;
    }
    this.addAnalysisMetadata(metadata, input);

    return {
      name: noteName,
      metadata,
      content: '', // 正文内容
    };
  }

  private buildCodexWorkerPayload(
    noteName: string,
    input: VideoInput,
    mode: ProcessingMode,
    language: SupportedLanguage,
  ) {
    const metadata: any = {
      mode,
      language,
      ai: this.aiModel,
      title: noteName,
      captured_at: new Date().toISOString(),
    };

    if (mode === 'info-only') {
      metadata.info_only = true;
    }
    if (input.url) {
      metadata.link = input.url;
    }
    if (input.transcript) {
      metadata.provided_transcript = input.transcript;
    }
    if (input.localFile) {
      metadata.local_file = input.localFile;
    }
    if (Array.isArray(input.localFiles) && input.localFiles.length > 0) {
      metadata.local_files = input.localFiles;
    }
    if (input.merge !== undefined) {
      metadata.merge = input.merge;
    }
    this.addAnalysisMetadata(metadata, input);

    return {
      source: 'obsidian-plugin',
      action: 'process',
      name: noteName,
      metadata,
      content: '',
    };
  }

  private withAnalysisDefaults(input: VideoInput): VideoInput {
    return {
      ...input,
      processingDepth: input.processingDepth || this.analysisDefaults.processingDepth,
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
      backend: this.backend,
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
      input.localFile ||
      input.localFiles?.filter(Boolean).join(', ') ||
      (input.transcript ? 'provided-transcript' : '')
    );
  }

  private addAnalysisMetadata(metadata: Record<string, any>, input: VideoInput) {
    metadata.artifact_schema_version = CACHE_ARTIFACT_SCHEMA_VERSION;
    metadata.prompt_version = CACHE_PROMPT_VERSION;
    metadata.processing_depth = input.processingDepth || this.analysisDefaults.processingDepth;
    metadata.content_type = input.contentType || this.analysisDefaults.contentType;
    metadata.auto_route = input.autoRoute ?? this.analysisDefaults.autoRoute;
    metadata.attention_assessment =
      input.attentionAssessment ?? this.analysisDefaults.attentionAssessment;
    metadata.generate_learning = input.generateLearning ?? this.analysisDefaults.generateLearning;
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

  private async processCodexWorkerJob(
    payload: any,
    onProgress?: ProcessProgressReporter,
  ): Promise<ProcessingResult> {
    const jobsUrl = this.getCodexWorkerJobsUrl();
    const response = await fetch(jobsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Codex Worker HTTP ${response.status}: ${text || response.statusText}`);
    }

    const createdJob = await response.json();
    if (!createdJob?.id) {
      throw new Error('Codex Worker 没有返回任务 ID');
    }

    const statusUrl = this.getCodexWorkerJobStatusUrl(jobsUrl, createdJob);
    const started = Date.now();
    let latestJob = createdJob;

    while (Date.now() - started < this.timeout) {
      await this.sleep(1000);
      const statusResponse = await fetch(statusUrl);
      if (!statusResponse.ok) {
        const text = await statusResponse.text();
        throw new Error(
          `Codex Worker job 状态读取失败: HTTP ${statusResponse.status} ${text || statusResponse.statusText}`,
        );
      }

      latestJob = await statusResponse.json();
      if (onProgress) {
        const stageLabel = pickString(latestJob, ['stage', 'step', 'phase', 'status']);
        const message = pickString(latestJob, ['message', 'detail', 'lastLog']);
        const progress = pickRatio(latestJob, ['progress', 'percent', 'percentage']);
        if (stageLabel || message || progress !== undefined) {
          onProgress({ stageLabel, message, progress });
        }
      }
      if (latestJob.status === 'success') {
        return this.parseSummaryResponse(latestJob.result, {
          url: payload?.metadata?.link,
          processingDepth: payload?.metadata?.processing_depth,
          contentType: payload?.metadata?.content_type,
          autoRoute: payload?.metadata?.auto_route,
          attentionAssessment: payload?.metadata?.attention_assessment,
          generateLearning: payload?.metadata?.generate_learning,
        });
      }
      if (
        latestJob.status === 'needs-review' ||
        latestJob.status === 'error' ||
        latestJob.status === 'cancelled'
      ) {
        throw new Error(this.formatCodexJobError(latestJob));
      }
    }

    throw new Error(`Codex Worker 任务超时。可在控制台查看: ${this.getCodexWorkerDashboardUrl()}`);
  }

  private getCodexWorkerJobsUrl(): string {
    try {
      const url = new URL(this.webhookUrl);
      const path = url.pathname.replace(/\/+$/, '');
      if (path.endsWith('/video-summary/jobs')) {
        url.pathname = path;
      } else if (path.endsWith('/video-summary/process-sync')) {
        url.pathname = path.replace(/\/process-sync$/, '/jobs');
      } else {
        url.pathname = '/video-summary/jobs';
      }
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return 'http://127.0.0.1:8787/video-summary/jobs';
    }
  }

  private getCodexWorkerJobStatusUrl(jobsUrl: string, job: any): string {
    try {
      const base = new URL(jobsUrl);
      if (job.logsUrl && typeof job.logsUrl === 'string' && job.logsUrl.startsWith('/')) {
        base.pathname = job.logsUrl.replace(/\/logs$/, '');
        base.search = '';
        base.hash = '';
        return base.toString();
      }
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(job.id)}`;
      base.search = '';
      base.hash = '';
      return base.toString();
    } catch {
      return `http://127.0.0.1:8787/video-summary/jobs/${encodeURIComponent(job.id)}`;
    }
  }

  private getCodexWorkerDashboardUrl(): string {
    try {
      const url = new URL(this.webhookUrl);
      url.pathname = '/dashboard';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return 'http://127.0.0.1:8787/dashboard';
    }
  }

  private formatCodexJobError(job: any): string {
    const error = job?.error;
    const errorMessage =
      typeof error === 'string'
        ? error
        : error?.error || error?.message || `Codex Worker 任务状态: ${job?.status || 'unknown'}`;
    const logs = Array.isArray(job?.logs) ? job.logs : [];
    const lastDiagnostic = [...logs].reverse().find((entry: any) => {
      const detail = entry?.detail || {};
      return detail.error || detail.stderr || entry?.stage;
    });
    const diagnosticText = lastDiagnostic
      ? `\n最后阶段: ${lastDiagnostic.stage}\n诊断: ${this.truncateError(JSON.stringify(lastDiagnostic.detail || {}, null, 2), 900)}`
      : '';
    return `${errorMessage}${diagnosticText}\n控制台: ${this.getCodexWorkerDashboardUrl()}`;
  }

  private truncateError(value: string, max: number): string {
    if (!value || value.length <= max) return value || '';
    return `${value.slice(0, max)}...`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseSummaryResponse(data: any, input: VideoInput = {}): ProcessingResult {
    // n8n 可能返回数组，需要合并所有对象的数据
    const preserveKeys = new Set(['summary', 'note', 'video_transcript']);
    let payload: any = Array.isArray(data) ? {} : data;

    if (Array.isArray(data)) {
      for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        for (const [key, value] of Object.entries(item)) {
          if (value === undefined || value === null) continue;
          if (preserveKeys.has(key)) {
            if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
              payload[key] = value;
            }
            continue;
          }
          payload[key] = value;
        }
      }
    }

    payload = this.unwrapResponsePayload(payload);

    // 检查是否是错误响应
    if (payload?.error) {
      throw new Error(payload.error);
    }

    // 检查数据是否为空或无效
    if (!payload || typeof payload !== 'object') {
      throw new Error('服务器返回无效的数据格式');
    }

    // 兼容 info-only/summary 混合数据的字段命名（支持嵌套结构）
    const infoSources: Array<Record<string, any> | undefined> = [
      payload,
      payload.info,
      payload.videoInfo,
      payload.video_info,
      payload.metadata,
    ];

    const pickField = (aliases: string[]): string | undefined => {
      for (const source of infoSources) {
        if (!source || typeof source !== 'object') continue;
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
      sourceUrl: input.url,
      backend: this.backend,
      model: this.aiModel,
      processingDepth: input.processingDepth,
      promptProfile: input.contentType,
      promptVersion: CACHE_PROMPT_VERSION,
    });
  }

  private unwrapResponsePayload(payload: any): any {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }

    const candidateKeys = ['data', 'result', 'output', 'response'];
    for (const key of candidateKeys) {
      const candidate = payload[key];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
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
    }) => void,
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
            onProgress({ ...resultObj, index: globalIndex });
          }

          return resultObj;
        } catch (error) {
          const errorObj = {
            success: false,
            error: error.message,
            noteName: request.noteName,
          };

          // 实时回调
          if (onProgress) {
            onProgress({ ...errorObj, index: globalIndex });
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
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
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
      this.backend,
      timeoutMs,
      this.backend === 'n8n' ? this.buildConnectionTestPayload() : undefined,
    );
  }

  /**
   * 探测任意后端端点是否可用（静态方法，供"另一个后端是否可用"的检查复用）。
   * - n8n: POST 测试 payload；连接被拒/超时 = 不可达；HTTP 404 = webhook 未激活。
   * - codex-worker: GET /health（回退 /dashboard）；只要有 HTTP 响应就算可达。
   */
  static async probeEndpoint(
    url: string,
    backend: ProcessingBackend,
    timeoutMs = 4000,
    n8nBody?: any,
  ): Promise<EndpointProbeResult> {
    if (!url || !url.trim()) {
      return { ok: false, error: '服务 URL 未配置' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (backend === 'codex-worker') {
        let probeUrl: string;
        try {
          const parsed = new URL(url);
          parsed.pathname = '/health';
          parsed.search = '';
          parsed.hash = '';
          probeUrl = parsed.toString();
        } catch {
          probeUrl = 'http://127.0.0.1:8787/health';
        }

        let response = await fetch(probeUrl, {
          method: 'GET',
          signal: controller.signal,
        }).catch(() => null);

        if (!response) {
          const parsed = new URL(url);
          parsed.pathname = '/dashboard';
          parsed.search = '';
          parsed.hash = '';
          response = await fetch(parsed.toString(), {
            method: 'GET',
            signal: controller.signal,
          });
        }
        // 只要拿到任意 HTTP 响应就说明 worker 进程在线
        return { ok: true };
      }

      const body =
        n8nBody ??
        ({
          name: 'preflight-check',
          metadata: { mode: 'transcript-only', language: 'zh', ai: '' },
          content: '',
        } as any);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 404) {
        return { ok: false, error: 'HTTP 404 — webhook 不存在或 workflow 未激活' };
      }
      return { ok: true };
    } catch (error) {
      const message =
        (error as Error)?.name === 'AbortError'
          ? `${timeoutMs}ms 内无响应（服务可能未启动）`
          : (error as Error)?.message || String(error);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  // 测试连接（返回耗时、响应片段和下一步建议，便于诊断）
  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildConnectionTestPayload()),
      });

      const durationMs = Date.now() - started;
      const text = await response.text();
      const snippet = (text || '').slice(0, 180);

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
        const error = '服务器返回空响应';
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
            warnings: ['当前工作流测试分支未返回版本信息。建议重新导入仓库内最新 workflow。'],
          };
        }

        const error = '服务器返回的不是 JSON';
        return {
          success: false,
          durationMs,
          status: response.status,
          bodySnippet: snippet,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      if (parsed?.error) {
        const error = this.errorToString(parsed.error);
        return {
          success: false,
          durationMs,
          status: response.status,
          bodySnippet: snippet,
          error,
          hint: this.getConnectionHint(error),
        };
      }

      if (this.backend === 'codex-worker') {
        try {
          this.parseSummaryResponse(parsed);
        } catch (error) {
          const message = this.formatUserFacingError(error);
          return {
            success: false,
            durationMs,
            status: response.status,
            bodySnippet: snippet,
            error: message,
            hint: this.getConnectionHint(message),
          };
        }
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

  private buildConnectionTestPayload() {
    if (this.backend === 'codex-worker') {
      return this.buildPayload(
        'connection-test',
        {
          url: 'https://example.com/video',
        },
        'info-only',
        'zh',
      );
    }

    return this.buildPayload('test', {}, 'transcript-only', 'zh');
  }

  private tryParseJson(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private isConnectionTestSuccessText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return ['测试成功', '测试成功！', 'ok', 'success'].includes(normalized);
  }

  private extractWorkflowHealthInfo(payload: any): WorkflowHealthInfo | undefined {
    const workflow =
      payload?.workflow || payload?.videoSummaryWorkflow || payload?.health?.workflow;
    if (!workflow || typeof workflow !== 'object') {
      return undefined;
    }

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
    if (this.backend !== 'n8n') return [];

    if (!workflow) {
      return ['当前工作流未返回版本信息。建议重新导入仓库内最新 workflow 后再运行诊断。'];
    }

    const warnings: string[] = [];
    if (workflow.version && workflow.version !== RECOMMENDED_WORKFLOW.version) {
      warnings.push(
        `当前 workflow 版本是 ${workflow.version}，推荐版本是 ${RECOMMENDED_WORKFLOW.version}。`,
      );
    }
    if (!workflow.version) {
      warnings.push(`workflow 未声明版本。推荐版本是 ${RECOMMENDED_WORKFLOW.version}。`);
    }
    if (workflow.webhookPath && workflow.webhookPath !== RECOMMENDED_WORKFLOW.webhookPath) {
      warnings.push(
        `当前 webhook path 是 ${workflow.webhookPath}，推荐 path 是 ${RECOMMENDED_WORKFLOW.webhookPath}。`,
      );
    }
    const models = workflow.models || [];
    const missingModels = RECOMMENDED_WORKFLOW.models.filter((model) => !models.includes(model));
    if (models.length > 0 && missingModels.length > 0) {
      warnings.push(`workflow 未声明推荐模型标签: ${missingModels.join(', ')}。`);
    }
    const tools = workflow.requiredTools || [];
    const missingTools = RECOMMENDED_WORKFLOW.requiredTools.filter((tool) => !tools.includes(tool));
    if (tools.length > 0 && missingTools.length > 0) {
      warnings.push(`workflow 未声明推荐媒体工具: ${missingTools.join(', ')}。`);
    }

    return warnings;
  }

  private readString(value: any): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private readStringArray(value: any): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const values = value.filter((item) => typeof item === 'string' && item.trim());
    return values.length > 0 ? values.map((item) => item.trim()) : undefined;
  }

  private async readJsonResponse(response: Response): Promise<any> {
    const text = await response.text();
    if (!text || text.trim() === '') {
      throw new Error('服务器返回空响应');
    }

    const parsed = this.tryParseJson(text);
    if (!parsed) {
      throw new Error(`服务器返回的不是 JSON。响应片段: ${this.truncateError(text, 180)}`);
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

    const snippet = text ? `。响应片段: ${this.truncateError(text, 180)}` : '';
    return `HTTP ${response.status} ${response.statusText}${snippet}`;
  }

  formatUserFacingError(error: unknown): string {
    const message = this.errorToString(error);
    const lower = message.toLowerCase();

    if (message.includes('请求被取消')) {
      return '请求已取消。';
    }

    if (message.includes('HTTP 404')) {
      return `Webhook 不存在或路径不匹配。请确认 n8n workflow 已激活，并且插件 URL 与 Webhook Path 完全一致。当前 URL: ${this.webhookUrl}`;
    }

    if (message.includes('HTTP 401') || message.includes('HTTP 403')) {
      return '处理服务拒绝访问。请检查 n8n 权限、反向代理鉴权或远程服务访问设置。';
    }

    if (
      lower.includes('bilibili') &&
      (lower.includes('http error 412') || lower.includes('precondition failed'))
    ) {
      return 'Bilibili 拒绝了 yt-dlp 请求。请先用项目 Docker 镜像无缓存重建以更新 yt-dlp；如果仍失败，把浏览器导出的 cookies 保存为 docker/cookies/bilibili_cookies.txt 后重启 n8n。';
    }

    if (lower.includes('yt-dlp') && lower.includes('not found')) {
      return 'n8n 容器缺少 yt-dlp。请使用项目提供的 Docker 镜像，或在当前 n8n 环境中安装 yt-dlp 后重试。';
    }

    if (lower.includes('ffmpeg') && lower.includes('not found')) {
      return 'n8n 容器缺少 ffmpeg。请使用项目提供的 Docker 镜像，或在当前 n8n 环境中安装 ffmpeg 后重试。';
    }

    if (
      message.includes('HTTP 500') ||
      message.includes('HTTP 502') ||
      message.includes('HTTP 503')
    ) {
      return `处理服务内部报错。请打开 n8n Execution 日志查看失败节点。原始错误: ${message}`;
    }

    if (
      lower.includes('failed to fetch') ||
      lower.includes('load failed') ||
      lower.includes('networkerror') ||
      lower.includes('connection refused')
    ) {
      return `无法连接处理服务。请确认 Docker/n8n 已启动，端口可访问，插件 URL 正确。当前 URL: ${this.webhookUrl}`;
    }

    if (message.includes('服务器返回空响应')) {
      return '服务器返回空响应。请确认 n8n workflow 已激活，并且 Respond to Webhook 节点已连到测试/处理分支。';
    }

    if (message.includes('服务器返回的不是 JSON')) {
      return `${message}。请确认 URL 指向 n8n Webhook，而不是 n8n 登录页、反向代理错误页或普通网页。`;
    }

    if (message.includes('服务器返回的数据中没有有效内容')) {
      return '处理服务已响应，但没有返回 summary、note、video_transcript 或视频信息字段。请检查 n8n 最后的 Respond to Webhook 输出。';
    }

    return message || '未知错误。请打开调试模式后重试，并查看 Obsidian 开发者控制台。';
  }

  private getConnectionHint(message: string): string {
    if (message.includes('Webhook 不存在') || message.includes('HTTP 404')) {
      return '打开 n8n，确认 workflow 已激活；Webhook 节点 Path 应为 obsidian-video-summary。';
    }

    if (message.includes('无法连接处理服务')) {
      return '先运行 docker compose 服务，再确认端口没有被其他 n8n 占用。';
    }

    if (message.includes('Bilibili 拒绝')) {
      return '执行 docker compose build --no-cache 更新 yt-dlp；仍失败时添加 docker/cookies/bilibili_cookies.txt。';
    }

    if (message.includes('空响应')) {
      return '检查 Respond to Webhook: Test 节点是否仍连接在测试分支上。';
    }

    if (message.includes('不是 JSON') || message.includes('没有有效内容')) {
      return '检查最后一个 Respond to Webhook 节点，确保返回 JSON，且包含 note、summary、video_transcript 或 video_title。';
    }

    if (message.includes('拒绝访问')) {
      return '如果你使用远程 n8n，请检查登录、反向代理和 CORS/鉴权配置。';
    }

    return '打开 Obsidian 设置里的调试模式，然后查看 n8n Execution 日志定位失败节点。';
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
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

/** 从后端返回的 job JSON 里挑第一个非空字符串字段 */
function pickString(source: any, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** 把 0-1 或 0-100 的进度字段统一成 0-1 */
function pickRatio(source: any, keys: string[]): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ratio = value > 1 ? value / 100 : value;
      return Math.min(1, Math.max(0, ratio));
    }
  }
  return undefined;
}
