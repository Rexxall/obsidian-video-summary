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
  ArtifactStore,
  VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
} from './ArtifactStore';

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

/**
 * 把"输入草稿"变成任务并驱动它们跑完：建笔记 → 调后端 → 写回笔记 → 记历史。
 * 视图只管调用和订阅，不再自己 await 一长串处理逻辑。
 */
export class JobService {
  private plugin: VideoSummaryPlugin;
  private store: JobStore;
  private noteProcessor: NoteProcessor;
  private noteFactory: NoteFactory;

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

    for (const draft of jsonDrafts) {
      await this.createNoteFromJson(draft.rawJson || '', options.language);
    }

    if (runnableDrafts.length === 0) return jsonDrafts.length;

    if (!(await this.plugin.ensureBackendReady())) {
      new Notice('后端不可用，任务未提交');
      return jsonDrafts.length;
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
    return queued + jsonDrafts.length;
  }

  /** 对已有笔记发起处理（笔记库里的 ▶ 和重跑都走这里） */
  async submitFile(file: TFile, options: SubmitOptions): Promise<Job | null> {
    const content = await this.plugin.app.vault.read(file);
    const input = this.noteProcessor.buildVideoInput(content);
    if (!input.url && !input.transcript && !input.localFile && !input.localFiles?.length) {
      new Notice('笔记里没有链接、文稿或本地文件');
      return null;
    }
    if (!(await this.plugin.ensureBackendReady())) return null;

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
  }

  async cancel(job: Job) {
    this.store.cancel(job.id);
    const noteName = job.notePath ? basenameOf(job.notePath) : job.title;
    this.plugin.api.cancelByNoteName(noteName);
    const file = this.fileFor(job);
    if (file) {
      await this.noteProcessor.setProcessingStatus(file, 'pending');
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
      await this.applyResult(file, job.result, job.mode);
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
    if (file) await this.noteProcessor.setProcessingStatus(file, 'pending');
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
      await this.applyResult(activeFile, result, mode);
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

  async createNoteFromJson(jsonText: string, language: SupportedLanguage) {
    try {
      const parsed = JSON.parse(jsonText);
      const result = this.plugin.api.normalizeWebhookPayload(parsed);
      const file = await this.noteFactory.createNoteFromResult(
        {
          result,
          input: extractVideoInputFromPayload(parsed),
          mode: 'summary',
          language,
          timestamp: Date.now(),
        },
        {
          outputFolder: this.plugin.settings.outputFolder || '',
          successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
        },
      );
      if (file) new Notice(`已根据 JSON 创建笔记: ${file.basename}`);
    } catch (error) {
      new Notice(`JSON 解析失败: ${messageOf(error)}`);
    }
  }

  /**
   * 兼容仍保留专用交互的命令入口。它们可以继续自行控制提示/重命名，
   * 但机器可读工件必须与任务队列走同一份持久化逻辑。
   */
  async persistExternalResult(
    context: ArtifactJobContext,
    result: ProcessingResult,
  ): Promise<void> {
    await this.persistArtifact(context, result);
  }

  private async runJob(
    job: Job,
    report: (progress: { stageLabel?: string; progress?: number; message?: string }) => void,
  ): Promise<ProcessingResult> {
    const file = this.fileFor(job);
    const noteName = file ? file.basename : job.title;

    if (file) {
      await this.noteProcessor.setProcessingStatus(file, 'running');
    }

    try {
      const result = await this.plugin.api.processVideo(
        noteName,
        job.input,
        job.mode,
        job.language,
        job.useCache,
        report,
      );
      await this.persistArtifact(job, result);

      if (job.awaitingWrite) {
        // 结果留在任务里等确认，笔记保持 running，由用户点"写入"或"丢弃"决定
        return result;
      }

      if (file) {
        await this.applyResult(file, result, job.mode);
      }
      this.plugin.addToHistory(noteName, 'success', job.mode, {
        url: job.input.url,
        platform: job.platform,
        durationMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      });
      return result;
    } catch (error) {
      const message = messageOf(error);
      if (file) {
        await this.noteProcessor.setProcessingError(file, error);
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

  private async applyResult(file: TFile, result: ProcessingResult, mode: ProcessingMode) {
    await this.noteProcessor.updateNote(file, result, mode, {
      autoRename: this.plugin.settings.autoRenameEnabled,
      conflictStrategy: this.plugin.settings.renameConflictStrategy,
    });
    await this.noteProcessor.setProcessingStatus(
      file,
      this.plugin.settings.successStatusValue ?? 'success',
    );
  }

  private async persistArtifact(job: ArtifactJobContext, result: ProcessingResult): Promise<void> {
    const source = {
      url: result.artifact?.source_url || job.input.url,
      local_file: job.input.localFile,
      note_path: job.notePath,
      source_hash: '',
    };
    const sourceHash = await ArtifactStore.sourceHash(source);
    const artifactId = ArtifactStore.artifactId(sourceHash);
    let previous: VideoKnowledgeArtifact | undefined;
    try {
      previous = await this.plugin.artifactStore.load(artifactId);
    } catch (error) {
      if (!(error instanceof ArtifactNotFoundError)) throw error;
    }

    const now = new Date().toISOString();
    const provenance = {
      ...(result.artifact || {}),
      schema_version: VIDEO_KNOWLEDGE_ARTIFACT_SCHEMA_VERSION,
      artifact_id: artifactId,
      source_url: job.input.url,
      source_hash: sourceHash,
      backend: this.plugin.settings.activeBackend,
      model: this.plugin.settings.aiModel,
      prompt_profile: job.input.contentType || this.plugin.settings.defaultContentType,
      prompt_version: result.artifact?.prompt_version || 'video-knowledge-v3',
      processing_depth:
        job.input.processingDepth || this.plugin.settings.defaultProcessingDepth,
      generated_at: result.artifact?.generated_at || now,
      transcript_source: result.transcript_source || result.artifact?.transcript_source,
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
      related_notes: result.related_notes || [],
      highlights: previous?.highlights || [],
      course_ids: previous?.course_ids || [],
      provenance,
      created_at: previous?.created_at || now,
      updated_at: now,
    };
    const saved = await this.plugin.artifactStore.save(artifact);
    result.artifact = {
      ...saved.provenance,
      artifact_id: saved.artifact_id,
      source_hash: saved.source.source_hash,
    };
    result.timing_quality = saved.timing_quality;
    job.input.artifactId = saved.artifact_id;
    job.input.highlightedSegmentIds = saved.highlights.map((highlight) => highlight.segment_id);
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
