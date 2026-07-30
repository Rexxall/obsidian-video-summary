// agent: claude (2026-07-26)
import { Notice, TFile } from 'obsidian';
import VideoSummaryPlugin from '../main';
import { NoteProcessor } from '../utils/NoteProcessor';
import {
  ProcessingDepth,
  ProcessingMode,
  ProcessingResult,
  RequestedContentType,
  SupportedLanguage,
  VideoInput,
  VideoKnowledgeArtifact,
} from '../types';
import { Job, JobStore } from './JobStore';
import { JobDraft } from './InputParser';
import { NoteFactory, buildInsertionContent, extractVideoInputFromPayload } from './NoteFactory';
import { detectPlatform } from './NoteIndex';
import {
  ArtifactNotFoundError,
  VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
  rebaseHighlightsForSegments,
} from './ArtifactStore';
import { AttentionUserContext, evaluateAttention, parseDurationSeconds } from './AttentionEngine';
import { resolveContentRoute } from './ContentRouter';
import { MediaAssetLocalizer, mediaAssetRoot } from './MediaAssetLocalizer';
import { createReproducibilityManifest } from './ReproducibilityManifest';
import type { CourseProgressStatus } from './CourseStore';
import { syncCourseIndexAtomic } from './CourseIndexWriter';
import {
  hydratePersistedReprocessResult,
  resolveArtifactPersistenceIdentity,
} from './ReprocessPersistence';

export interface SubmitOptions {
  mode: ProcessingMode;
  language: SupportedLanguage;
  useCache: boolean;
  /** 结果先进预览，由用户确认后再写入笔记 */
  previewBeforeWrite: boolean;
  processingDepth: ProcessingDepth;
  contentType: RequestedContentType;
  autoRoute: boolean;
  attentionAssessment: boolean;
  generateLearning: boolean;
}

type ArtifactJobContext = Pick<Job, 'title' | 'input' | 'notePath' | 'platform'>;

class JobCancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'JobCancelledError';
  }
}

/**
 * 把"输入草稿"变成任务并驱动它们跑完：建笔记 → 调后端 → 写回笔记 → 记历史。
 * 视图只管调用和订阅，不再自己 await 一长串处理逻辑。
 */
export class JobService {
  private plugin: VideoSummaryPlugin;
  private store: JobStore;
  private noteProcessor: NoteProcessor;
  private noteFactory: NoteFactory;
  private readonly courseProgressLocks = new Map<string, Promise<unknown>>();

  constructor(plugin: VideoSummaryPlugin, store: JobStore) {
    this.plugin = plugin;
    this.store = store;
    this.noteProcessor = new NoteProcessor(plugin.app.vault);
    this.noteFactory = new NoteFactory(plugin.app);
    this.store.setRunner((job, report) => this.runJob(job, report));
    this.store.setConcurrency(plugin.settings.batchConcurrency || 2);
  }

  /** 提交一批草稿：JSON 直接落笔记，其余建占位笔记后入队 */
  async submit(drafts: JobDraft[], options: SubmitOptions): Promise<number> {
    if (drafts.length === 0) return 0;

    const jsonDrafts = drafts.filter((draft) => draft.source === 'json');
    const runnableDrafts = drafts.filter((draft) => draft.source !== 'json');

    let jsonCreated = 0;
    for (const draft of jsonDrafts) {
      if (await this.createNoteFromJson(draft.rawJson || '', options.language)) {
        jsonCreated += 1;
      }
    }

    if (runnableDrafts.length === 0) return jsonCreated;

    if (!(await this.plugin.ensureBackendReady())) {
      new Notice('后端不可用，任务未提交');
      return jsonCreated;
    }

    let queued = 0;
    for (const draft of runnableDrafts) {
      const file = await this.noteFactory.createStubNote(draft, {
        outputFolder: this.plugin.settings.outputFolder || '',
        successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
      });
      if (!file) {
        new Notice(`创建笔记失败: ${draft.title}`);
        continue;
      }
      this.store.enqueue({
        title: draft.title,
        input: withAnalysisOptions(draft.input, options),
        mode: options.mode,
        language: options.language,
        useCache: options.useCache,
        notePath: file.path,
        platform: draft.platform,
        awaitingWrite: options.previewBeforeWrite,
      });
      queued += 1;
    }
    return queued + jsonCreated;
  }

  /** 对已有笔记发起处理（笔记库里的 ▶ 和重跑都走这里） */
  async submitFile(file: TFile, options: SubmitOptions): Promise<Job | null> {
    const content = await this.plugin.app.vault.read(file);
    const input = this.noteProcessor.buildVideoInput(content);
    return this.submitPreparedFile(file, input, options);
  }

  /**
   * Queue a caller-supplied, already validated input. Reproducible reprocessing
   * uses this path so the stored transcript can be sent without source fetch.
   */
  async submitPreparedFile(
    file: TFile,
    input: VideoInput,
    options: SubmitOptions,
  ): Promise<Job | null> {
    if (!input.url && !input.transcript && !input.localFile && !input.localFiles?.length) {
      new Notice('笔记里没有链接、文稿或本地文件');
      return null;
    }
    if (!(await this.plugin.ensureBackendReady())) return null;

    await this.updateCourseProgressForFile(file, 'queued', 0, input.artifactId);
    try {
      return this.store.enqueue({
        title: file.basename,
        input: withAnalysisOptions(input, options),
        mode: options.mode,
        language: options.language,
        useCache: options.useCache,
        notePath: file.path,
        platform: input.url ? detectPlatform(input.url) : undefined,
        awaitingWrite: options.previewBeforeWrite,
      });
    } catch (error) {
      await this.updateCourseProgressForFile(file, 'pending', 0, input.artifactId);
      throw error;
    }
  }

  async cancel(job: Job) {
    this.store.cancel(job.id);
    const noteName = job.notePath ? basenameOf(job.notePath) : job.title;
    this.plugin.api.cancelByNoteName(noteName);
    const file = this.fileFor(job);
    if (file) {
      await this.noteProcessor.setProcessingStatus(file, 'pending');
      await this.updateCourseProgressForFile(file, 'pending', 0);
    }
  }

  /** 预览确认后写入笔记 */
  async writeResult(job: Job): Promise<boolean> {
    if (!job.result) return false;
    const file = this.fileFor(job);
    if (!file) {
      new Notice('目标笔记已不存在');
      return false;
    }
    try {
      await this.persistArtifact(job, job.result);
      await this.applyResult(file, job.result, job.mode, job);
      await this.updateCourseProgressForFile(
        file,
        'complete',
        100,
        job.input.artifactId || job.result.artifact?.artifact_id,
      );
      this.store.update(job.id, { state: 'success', awaitingWrite: false });
      this.plugin.addToHistory(file.basename, 'success', job.mode, {
        url: job.input.url,
        platform: job.platform,
        durationMs: job.endedAt && job.startedAt ? job.endedAt - job.startedAt : undefined,
      });
      return true;
    } catch (error) {
      new Notice(`写入失败: ${messageOf(error)}`);
      return false;
    }
  }

  /** 丢弃结果，把笔记退回待处理 */
  async discardResult(job: Job) {
    const file = this.fileFor(job);
    if (file) {
      await this.noteProcessor.setProcessingStatus(file, 'pending');
      await this.updateCourseProgressForFile(file, 'pending', 0);
    }
    this.store.update(job.id, { state: 'cancelled', awaitingWrite: false });
  }

  /** 把结果按正常写入规则应用到当前打开的笔记（等价旧版"应用到当前文件"） */
  async applyToActiveNote(result: ProcessingResult, mode: ProcessingMode) {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('请先打开一个笔记');
      return;
    }
    try {
      const context: ArtifactJobContext = {
        title: activeFile.basename,
        notePath: activeFile.path,
        input: extractVideoInputFromPayload(result),
        platform: result.video_platform,
      };
      const saved = await this.persistArtifact(context, result);
      await this.applyResult(activeFile, result, mode, context);
      await this.updateCourseProgressForFile(activeFile, 'complete', 100, saved.artifact_id);
      new Notice('已应用到当前笔记');
    } catch (error) {
      new Notice(`应用失败: ${messageOf(error)}`);
    }
  }

  /** 把结果插到当前打开的笔记末尾 */
  async insertIntoActiveNote(result: ProcessingResult) {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('请先打开一个笔记');
      return;
    }
    const content = await this.plugin.app.vault.read(activeFile);
    await this.plugin.app.vault.modify(
      activeFile,
      `${content.trim()}\n\n${buildInsertionContent(result)}`,
    );
    new Notice('已插入当前笔记');
  }

  /** 用结果新建一篇笔记 */
  async createNoteFromResult(job: Job) {
    if (!job.result) return;
    const file = await this.noteFactory.createNoteFromResult(
      {
        result: job.result,
        input: job.input,
        mode: job.mode,
        language: job.language,
        timestamp: job.endedAt || Date.now(),
      },
      {
        outputFolder: this.plugin.settings.outputFolder || '',
        successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
      },
    );
    if (file) new Notice(`已创建笔记: ${file.basename}`);
  }

  async createNoteFromJson(jsonText: string, language: SupportedLanguage): Promise<TFile | null> {
    let parsed: unknown;
    let result: ProcessingResult;
    let input: VideoInput;
    try {
      parsed = JSON.parse(jsonText);
      result = this.plugin.api.normalizeWebhookPayload(parsed);
      input = extractVideoInputFromPayload(parsed);
    } catch (error) {
      new Notice(`JSON 解析失败: ${messageOf(error)}`);
      return null;
    }

    try {
      // Persist once before note creation so frontmatter receives artifact_id,
      // then persist again with the final note path to keep the sidecar linked.
      if (hasPreNoteArtifactIdentity(input, result)) {
        await this.persistArtifact(
          {
            title: result.video_title || 'Webhook结果',
            input,
            platform: result.video_platform,
          },
          result,
        );
      }
      const existingFile = result.artifact?.artifact_id
        ? await this.fileForArtifactId(result.artifact.artifact_id)
        : null;
      const file =
        existingFile ||
        (await this.noteFactory.createNoteFromResult(
          {
            result,
            input,
            mode: 'summary',
            language,
            timestamp: Date.now(),
          },
          {
            outputFolder: this.plugin.settings.outputFolder || '',
            successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
          },
        ));
      if (file) {
        try {
          await this.persistArtifact(
            {
              title: file.basename,
              notePath: file.path,
              input,
              platform: result.video_platform,
            },
            result,
          );
          await this.noteProcessor.updateNote(file, result, 'summary');
          await this.noteProcessor.setProcessingStatus(
            file,
            this.plugin.settings.successStatusValue ?? 'success',
          );
          new Notice(`${existingFile ? '已更新' : '已根据 JSON 创建'}笔记: ${file.basename}`);
          return file;
        } catch (error) {
          try {
            await this.noteProcessor.setProcessingError(file, error);
          } catch (statusError) {
            console.error('[Video Summary] JSON 失败状态写回失败', statusError);
          }
          new Notice(`JSON 笔记写入失败，已保留为错误状态: ${messageOf(error)}`, 8000);
          return null;
        }
      }
      return null;
    } catch (error) {
      new Notice(`JSON 工件或笔记创建失败: ${messageOf(error)}`, 8000);
      return null;
    }
  }

  private async fileForArtifactId(artifactId: string): Promise<TFile | null> {
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const cached = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      let current = stringValue(cached?.video_artifact_id);
      if (!current) {
        current = frontmatterScalar(
          await this.plugin.app.vault.cachedRead(file),
          'video_artifact_id',
        );
      }
      if (current === artifactId) return file;
    }
    return null;
  }

  /**
   * 兼容仍保留专用交互的命令入口。它们可以继续自行控制提示/重命名，
   * 但机器可读工件必须与任务队列走同一份持久化逻辑。
   */
  async persistExternalResult(
    context: ArtifactJobContext,
    result: ProcessingResult,
  ): Promise<VideoKnowledgeArtifact> {
    return this.persistArtifact(context, result);
  }

  /** Refresh the sidecar and reproducibility source path after auto-rename. */
  async relinkExternalResult(
    context: ArtifactJobContext,
    result: ProcessingResult,
    file: TFile,
  ): Promise<void> {
    if (context.notePath === file.path) return;
    await this.persistArtifact({ ...context, notePath: file.path }, result);
  }

  private async runJob(
    job: Job,
    report: (progress: { stageLabel?: string; progress?: number; message?: string }) => void,
  ): Promise<ProcessingResult> {
    const file = this.fileFor(job);
    const noteName = file ? file.basename : job.title;

    this.assertNotCancelled(job);
    if (file) {
      await this.noteProcessor.setProcessingStatus(file, 'running');
      await this.updateCourseProgressForFile(file, 'processing', 10, job.input.artifactId);
    }

    try {
      this.assertNotCancelled(job);
      const result = await this.plugin.api.processVideo(
        noteName,
        job.input,
        job.mode,
        job.language,
        job.useCache,
        report,
      );
      // Some remote workers cannot abort an already-running job. Never persist
      // or write a late response after the local user has cancelled it.
      this.assertNotCancelled(job);

      if (job.awaitingWrite) {
        // Review gate: keep the result only in JobStore. No artifact,
        // reproducibility sidecar, memory index, or note body is written until
        // writeResult receives explicit confirmation.
        if (file) {
          await this.updateCourseProgressForFile(file, 'processing', 90, job.input.artifactId);
        }
        return result;
      }

      await this.persistArtifact(job, result);
      this.assertNotCancelled(job);
      if (file) {
        this.assertNotCancelled(job);
        await this.applyResult(file, result, job.mode, job);
        this.assertNotCancelled(job);
        await this.updateCourseProgressForFile(
          file,
          'complete',
          100,
          job.input.artifactId || result.artifact?.artifact_id,
        );
      }
      this.plugin.addToHistory(noteName, 'success', job.mode, {
        url: job.input.url,
        platform: job.platform,
        durationMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      });
      return result;
    } catch (error) {
      if (error instanceof JobCancelledError || this.store.isCancelRequested(job.id)) {
        if (file) {
          await this.noteProcessor.setProcessingStatus(file, 'pending');
          await this.updateCourseProgressForFile(file, 'pending', 0);
        }
        throw error instanceof JobCancelledError ? error : new JobCancelledError();
      }
      const message = messageOf(error);
      if (file) {
        await this.noteProcessor.setProcessingError(file, error);
        await this.updateCourseProgressForFile(file, 'error', 0, job.input.artifactId);
      }
      this.plugin.addToHistory(noteName, 'error', job.mode, {
        url: job.input.url,
        platform: job.platform,
        error: message,
        durationMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      });
      throw error;
    }
  }

  private assertNotCancelled(job: Job): void {
    if (this.store.isCancelRequested(job.id)) throw new JobCancelledError();
  }

  private async applyResult(
    file: TFile,
    result: ProcessingResult,
    mode: ProcessingMode,
    context?: ArtifactJobContext,
  ) {
    const originalPath = file.path;
    await this.noteProcessor.updateNote(file, result, mode, {
      autoRename: this.plugin.settings.autoRenameEnabled,
      conflictStrategy: this.plugin.settings.renameConflictStrategy,
    });
    if (context && file.path !== originalPath) {
      await this.persistArtifact({ ...context, notePath: file.path }, result);
    }
    await this.noteProcessor.setProcessingStatus(
      file,
      this.plugin.settings.successStatusValue ?? 'success',
    );
  }

  private async persistArtifact(
    job: ArtifactJobContext,
    result: ProcessingResult,
  ): Promise<VideoKnowledgeArtifact> {
    let previous: VideoKnowledgeArtifact | undefined;
    if (job.input.skipSourceFetch && job.input.artifactId) {
      try {
        previous = await this.plugin.artifactStore.load(job.input.artifactId);
      } catch (error) {
        if (!(error instanceof ArtifactNotFoundError)) throw error;
      }
    }
    hydratePersistedReprocessResult(result, job.input, previous);

    const requestedContentType =
      job.input.contentType || this.plugin.settings.defaultContentType || 'auto';
    const contentRouting =
      requestedContentType !== 'auto' || !result.content_routing
        ? resolveContentRoute({
            requestedType: requestedContentType,
            autoRoute: job.input.autoRoute ?? this.plugin.settings.autoRouteContent,
            backendType: result.content_type,
            backendConfidence: result.content_routing?.confidence,
            backendReasons: result.content_routing?.reasons,
            title: result.video_title || job.title,
            author: result.video_author,
            transcript: result.video_transcript,
          })
        : result.content_routing;
    result.content_type = contentRouting.type;
    result.content_routing = contentRouting;

    const attentionEnabled =
      job.input.attentionAssessment ?? this.plugin.settings.attentionAssessmentEnabled;
    const hasAttentionEvidence =
      (result.video_segments?.length || 0) > 0 ||
      (result.evidence_claims?.length || 0) > 0 ||
      result.attention !== undefined;
    if (attentionEnabled && hasAttentionEvidence) {
      result.attention = evaluateAttention({
        segments: result.video_segments,
        claims: result.evidence_claims,
        durationSeconds: parseDurationSeconds(result.video_duration),
        contentType: result.content_type,
        userContext: this.attentionContextFor(job),
        backendAssessment: result.attention,
      }).assessment;
    } else if (!attentionEnabled) {
      result.attention = undefined;
    }

    const identity = await resolveArtifactPersistenceIdentity({
      jobInput: job.input,
      result,
      notePath: job.notePath,
      previous,
    });
    const { source, sourceHash, artifactId } = identity;
    if (!previous) {
      try {
        previous = await this.plugin.artifactStore.load(artifactId);
      } catch (error) {
        if (!(error instanceof ArtifactNotFoundError)) throw error;
      }
    }
    const localizedMedia = await new MediaAssetLocalizer(
      this.plugin.app.vault.adapter,
      mediaAssetRoot(this.plugin.settings.outputFolder),
    ).localizeResult(result, artifactId);
    result.video_segments = localizedMedia.result.video_segments;
    result.visual_evidence = localizedMedia.result.visual_evidence;

    const now = new Date().toISOString();
    const provenance = {
      ...(result.artifact || {}),
      schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
      artifact_id: artifactId,
      source_url: source.url,
      source_hash: sourceHash,
      backend: this.plugin.settings.activeBackend,
      model: this.plugin.settings.aiModel,
      prompt_profile: contentRouting.prompt_profile.id,
      prompt_version: result.artifact?.prompt_version || 'video-knowledge-v3',
      processing_depth:
        result.artifact?.processing_depth ||
        job.input.processingDepth ||
        this.plugin.settings.defaultProcessingDepth,
      content_routing: {
        source: contentRouting.source,
        confidence: contentRouting.confidence,
        reasons: contentRouting.reasons.map((reason) => reason.message),
        prompt_profile: contentRouting.prompt_profile.id,
      },
      generated_at: result.artifact?.generated_at || now,
      transcript_source: result.transcript_source || result.artifact?.transcript_source,
      warnings: uniqueStrings([...(result.artifact?.warnings || []), ...localizedMedia.warnings]),
    } satisfies VideoKnowledgeArtifact['provenance'];

    const artifact: VideoKnowledgeArtifact = {
      schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
      artifact_id: artifactId,
      source: { ...source, source_hash: sourceHash },
      title: result.video_title || job.title,
      author: result.video_author,
      platform: result.video_platform || job.platform,
      duration: result.video_duration,
      cover: result.video_cover,
      content_type: result.content_type,
      timing_quality: result.timing_quality || 'none',
      transcript: result.video_transcript,
      segments: result.video_segments || [],
      claims: result.evidence_claims || [],
      visual_evidence: result.visual_evidence || [],
      attention: result.attention,
      learning: result.learning,
      // Reviewed cross-video relations are user-owned state, like highlights.
      // A backend omitting this optional field must not erase prior approvals.
      // `related_notes` is the reviewed state, never backend-owned output.
      // Suggestions are shown by Knowledge Lab and enter this array only via
      // ArtifactStore.updateRelatedNotes after explicit confirmation.
      related_notes: previous?.related_notes ?? [],
      highlights: rebaseHighlightsForSegments(
        previous?.highlights || [],
        previous?.segments || [],
        result.video_segments || [],
      ),
      course_ids: await this.courseIdsFor(job, previous),
      provenance,
      created_at: previous?.created_at || now,
      updated_at: now,
    };
    const saved = await this.plugin.artifactStore.save(artifact);
    this.plugin.memoryIndex.upsert(saved);
    if (saved.transcript?.trim()) {
      try {
        const reproducibility = await createReproducibilityManifest({
          source: saved.source,
          artifact_id: saved.artifact_id,
          transcript: saved.transcript,
          segments: saved.segments,
          evidence_claims: saved.claims,
          visual_evidence: saved.visual_evidence,
          backend: saved.provenance.backend || this.plugin.settings.activeBackend,
          model: saved.provenance.model || this.plugin.settings.aiModel,
          prompt: saved.provenance.prompt_profile || 'video-content-general-v1',
          version: saved.provenance.prompt_version || 'video-knowledge-v3',
          depth: saved.provenance.processing_depth || this.plugin.settings.defaultProcessingDepth,
          generated_at: saved.provenance.generated_at || saved.updated_at,
        });
        await this.plugin.reproducibilityStore.save(reproducibility);
      } catch (error) {
        console.warn('[Video Summary] 可复现工件保存失败', error);
      }
    }
    result.artifact = {
      ...saved.provenance,
      artifact_id: saved.artifact_id,
      source_hash: saved.source.source_hash,
    };
    result.timing_quality = saved.timing_quality;
    job.input.artifactId = saved.artifact_id;
    job.input.highlightedSegmentIds = saved.highlights.map((highlight) => highlight.segment_id);
    return saved;
  }

  private attentionContextFor(job: ArtifactJobContext): AttentionUserContext | undefined {
    if (!job.notePath) return undefined;
    const file = this.plugin.app.vault.getAbstractFileByPath(job.notePath);
    if (!(file instanceof TFile)) return undefined;
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    const terms = uniqueStrings(
      [
        ...toStrings(frontmatter?.video_interest_terms),
        ...toStrings(frontmatter?.research_topics),
        ...toStrings(frontmatter?.tags),
      ].filter((value) => !/^video-summary(?:\/|$)/i.test(value)),
    ).slice(0, 100);
    return terms.length
      ? {
          query_terms: terms,
          label: `笔记 ${file.path} 的显式 tags / research_topics`,
        }
      : undefined;
  }

  /**
   * Keep a course manifest and its managed index synchronized regardless of
   * whether processing was launched from the sidebar, command, or batch modal.
   */
  async updateCourseProgressForFile(
    file: TFile,
    status: CourseProgressStatus,
    percent: number,
    artifactId?: string,
  ): Promise<void> {
    try {
      const cached = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      let courseId = stringValue(cached?.video_course_id);
      let itemId = stringValue(cached?.video_course_item_id);
      if (!courseId || !itemId) {
        const content = await this.plugin.app.vault.read(file);
        courseId ||= frontmatterScalar(content, 'video_course_id');
        itemId ||= frontmatterScalar(content, 'video_course_item_id');
      }
      if (!courseId || !itemId) return;
      await this.withCourseProgressLock(courseId, async () => {
        const saved = await this.plugin.courseStore.update(courseId, (manifest) => {
          const item = manifest.items.find((candidate) => candidate.item_id === itemId);
          if (!item) return;
          item.progress = {
            ...item.progress,
            status,
            percent: Math.min(100, Math.max(0, Math.round(percent))),
            note_path: file.path,
            ...(artifactId ? { artifact_id: artifactId } : {}),
            updated_at: new Date().toISOString(),
          };
        });
        if (!saved?.index_note_path) return;
        await syncCourseIndexAtomic(
          this.plugin.app.vault,
          this.plugin.courseStore,
          saved.course_id,
          false,
        );
      });
    } catch (error) {
      console.warn('[Video Summary] 课程进度更新失败', error);
      throw error;
    }
  }

  private async withCourseProgressLock<T>(
    courseId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.courseProgressLocks.get(courseId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.courseProgressLocks.set(courseId, current);
    try {
      return await current;
    } finally {
      if (this.courseProgressLocks.get(courseId) === current) {
        this.courseProgressLocks.delete(courseId);
      }
    }
  }

  private async courseIdsFor(
    job: ArtifactJobContext,
    previous: VideoKnowledgeArtifact | undefined,
  ): Promise<string[]> {
    const ids = new Set(previous?.course_ids || []);
    if (!job.notePath) return [...ids].sort();
    const file = this.plugin.app.vault.getAbstractFileByPath(job.notePath);
    if (!(file instanceof TFile)) return [...ids].sort();
    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    const values = [frontmatter?.video_course_id, frontmatter?.video_course_ids].flat();
    const currentFileIds = new Set<string>();
    values.forEach((value) => {
      if (typeof value === 'string' && value.trim()) {
        currentFileIds.add(value.trim());
        ids.add(value.trim());
      }
    });
    if (currentFileIds.size === 0) {
      const content = await this.plugin.app.vault.read(file);
      const scalar = frontmatterScalar(content, 'video_course_id');
      if (scalar) ids.add(scalar);
    }
    return [...ids].sort();
  }

  private fileFor(job: Job): TFile | null {
    if (!job.notePath) return null;
    const file = this.plugin.app.vault.getAbstractFileByPath(job.notePath);
    return file instanceof TFile ? file : null;
  }
}

function basenameOf(path: string): string {
  const name = path.split('/').pop() || path;
  return name.replace(/\.md$/i, '');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(toStrings);
  if (typeof value !== 'string') return [];
  return value
    .split(/[,，]/)
    .map((item) => item.replace(/^#/, '').trim())
    .filter(Boolean);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function frontmatterScalar(content: string, key: string): string {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!block) return '';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function hasPreNoteArtifactIdentity(input: VideoInput, result: ProcessingResult): boolean {
  return Boolean(
    input.url ||
    input.sourceUrl ||
    input.localFile ||
    input.localFiles?.length ||
    result.video_transcript?.trim() ||
    result.artifact?.source_url,
  );
}

function withAnalysisOptions(input: VideoInput, options: SubmitOptions): VideoInput {
  return {
    ...input,
    processingDepth: input.processingDepth || options.processingDepth,
    contentType: input.contentType || options.contentType,
    autoRoute: input.autoRoute ?? options.autoRoute,
    attentionAssessment: input.attentionAssessment ?? options.attentionAssessment,
    generateLearning: input.generateLearning ?? options.generateLearning,
  };
}
