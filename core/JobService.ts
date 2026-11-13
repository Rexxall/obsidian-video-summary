import { BackendLostError, mayMeanBackendGone, withBackendWatch } from './BackendHealth';
import { Notice, TFile, getFrontMatterInfo, parseYaml, requestUrl } from 'obsidian';
import { MIN_ARTICLE_CHARS, extractArticle, isArticleLink } from './ArticleReader';
import { bilibiliNoteImages } from './BilibiliImages';
import { bilibiliRef } from './BilibiliRef';
import type { NoteImage } from './NoteStyle';
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
import { Job, JobProgress, JobStore } from './JobStore';
import {
  type LiteVideoMeta,
  linkWantsPageCapture,
  liteDecision,
  nodeStreamTransport,
  runLiteJob,
} from './LiteRunner';
import { readSecret, resolveLlm } from './ModelSettings';
import { JobDraft } from './InputParser';
import { isPlaceholderTitle, youTubeOEmbed } from './VideoOEmbed';
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
  stripUntrustedPersistedMediaAssetPaths,
} from './ReprocessPersistence';

import { errorMessage } from '../utils/errors';
import { tr } from '../utils/i18n';
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
  /** Light-tier jobs talk to the model directly; cancelling aborts that request. */
  private readonly liteControllers = new Map<string, AbortController>();

  constructor(plugin: VideoSummaryPlugin, store: JobStore) {
    this.plugin = plugin;
    this.store = store;
    this.noteProcessor = plugin.createNoteProcessor();
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
    await this.readArticles(runnableDrafts, options.mode);

    const liteFlags = runnableDrafts.map(
      (draft) => this.liteFor(withAnalysisOptions(draft.input, options), options.mode).lite,
    );
    // 轻量档任务不经过后端；只有要后端的任务才去问后端在不在
    if (liteFlags.some((lite) => !lite)) {
      await this.waitForBackendOrExplain(
        runnableDrafts
          .filter((_, i) => !liteFlags[i])
          .map((draft) => withAnalysisOptions(draft.input, options)),
        options.mode,
      );
    }

    let queued = 0;
    for (const draft of runnableDrafts) {
      const file = await this.noteFactory.createStubNote(draft, {
        outputFolder: this.plugin.settings.outputFolder || '',
        successStatusValue: this.plugin.settings.successStatusValue ?? 'success',
      });
      if (!file) {
        new Notice(tr(`创建笔记失败: ${draft.title}`, `Could not create the note: ${draft.title}`));
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
        lite: liteFlags[runnableDrafts.indexOf(draft)],
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
      new Notice(
        tr('笔记里没有链接、文稿或本地文件', 'The note has no link, transcript or local file'),
      );
      return null;
    }
    const lite = this.liteFor(withAnalysisOptions(input, options), options.mode).lite;
    if (!lite)
      await this.waitForBackendOrExplain([withAnalysisOptions(input, options)], options.mode);

    await this.updateCourseProgressForFile(file, 'queued', 0, input.artifactId);
    try {
      return this.store.enqueue({
        lite,
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
    this.liteControllers.get(job.id)?.abort();
    const noteName = job.notePath ? basenameOf(job.notePath) : job.title;
    await this.plugin.api.cancelByNoteName(noteName);
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
      new Notice(tr('目标笔记已不存在', 'The target note no longer exists'));
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
        path: file.path,
        url: job.input.url || job.input.sourceUrl,
        platform: job.platform,
        durationMs: job.endedAt && job.startedAt ? job.endedAt - job.startedAt : undefined,
      });
      return true;
    } catch (error) {
      new Notice(tr(`写入失败: ${messageOf(error)}`, `Could not write: ${messageOf(error)}`));
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
      new Notice(tr('请先打开一个笔记', 'Open a note first'));
      return;
    }
    try {
      const noteInput = this.noteProcessor.buildVideoInput(
        await this.plugin.app.vault.read(activeFile),
      );
      const inferredInput = extractVideoInputFromPayload(result);
      const context: ArtifactJobContext = {
        title: activeFile.basename,
        notePath: activeFile.path,
        input: {
          ...inferredInput,
          url: noteInput.url || inferredInput.url,
          localFile: noteInput.localFile,
          transcript: noteInput.transcript || inferredInput.transcript,
        },
        platform: result.video_platform,
      };
      const saved = await this.persistArtifact(context, result);
      await this.applyResult(activeFile, result, mode, context);
      await this.updateCourseProgressForFile(activeFile, 'complete', 100, saved.artifact_id);
      new Notice(tr('已应用到当前笔记', 'Applied to the current note'));
    } catch (error) {
      new Notice(tr(`应用失败: ${messageOf(error)}`, `Could not apply: ${messageOf(error)}`));
    }
  }

  /** 把结果插到当前打开的笔记末尾 */
  async insertIntoActiveNote(result: ProcessingResult) {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice(tr('请先打开一个笔记', 'Open a note first'));
      return;
    }
    // Read and write in one step, so an edit made meanwhile is not overwritten.
    await this.plugin.app.vault.process(
      activeFile,
      (content) => `${content.trim()}\n\n${buildInsertionContent(result)}`,
    );
    new Notice(tr('已插入当前笔记', 'Inserted into the current note'));
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
    if (file) new Notice(tr(`已创建笔记: ${file.basename}`, `Created note: ${file.basename}`));
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
      new Notice(
        tr(`JSON 解析失败: ${messageOf(error)}`, `Could not parse the JSON: ${messageOf(error)}`),
      );
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
          await this.noteProcessor.markProcessingSuccess(
            file,
            this.plugin.settings.successStatusValue ?? 'success',
          );
          new Notice(
            tr(
              `${existingFile ? '已更新' : '已根据 JSON 创建'}笔记: ${file.basename}`,
              `${existingFile ? 'Updated' : 'Created from JSON'}: ${file.basename}`,
            ),
          );
          return file;
        } catch (error) {
          try {
            await this.noteProcessor.setProcessingError(file, error);
          } catch (statusError) {
            console.error('[Video Summary] JSON 失败状态写回失败', statusError);
          }
          new Notice(
            tr(
              `JSON 笔记写入失败，已保留为错误状态: ${messageOf(error)}`,
              `Could not write the JSON note; kept as an error: ${messageOf(error)}`,
            ),
            8000,
          );
          return null;
        }
      }
      return null;
    } catch (error) {
      new Notice(
        tr(
          `JSON 工件或笔记创建失败: ${messageOf(error)}`,
          `Could not create the JSON artifact or note: ${messageOf(error)}`,
        ),
        8000,
      );
      return null;
    }
  }

  private async fileForArtifactId(artifactId: string): Promise<TFile | null> {
    // Newer notes carry no id; the record knows its note.
    const known = this.plugin.noteLinks.pathFor(artifactId);
    const knownFile = known ? this.plugin.app.vault.getAbstractFileByPath(known) : null;
    if (knownFile instanceof TFile) return knownFile;
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
      // 处理中每 45 秒问一次后端还在不在；连着两次没应答就立刻失败，不等总超时
      const result = job.lite
        ? await this.runLite(job, report)
        : await withBackendWatch(
            this.plugin.api.processVideo(
              noteName,
              job.input,
              job.mode,
              job.language,
              job.useCache,
              report,
            ),
            {
              ping: () => this.plugin.api.pingService(),
              onLost: () => {
                void this.plugin.api.cancelByNoteName(noteName);
                this.plugin.backend.lostWhileRunning();
              },
              lostMessage: backendLostText(),
            },
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
      this.plugin.addToHistory(file?.basename || noteName, 'success', job.mode, {
        path: file?.path,
        url: job.input.url || job.input.sourceUrl,
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
      // n8n 被停掉时会先给还没答完的请求回一个空响应，再关端口。所以“空响应”和连接错误
      // 先确认后端还在不在：不在了就照实说“后端停了”，而不是让人去查工作流。
      let failure: unknown = error;
      if (error instanceof BackendLostError) {
        this.plugin.backend.lostWhileRunning();
      } else if (
        !job.lite &&
        mayMeanBackendGone(messageOf(error)) &&
        (await this.plugin.backend.goneAfterFailure())
      ) {
        failure = new BackendLostError(backendLostText());
      }
      const message = messageOf(failure);
      if (file) {
        await this.noteProcessor.setProcessingError(file, failure);
        await this.updateCourseProgressForFile(file, 'error', 0, job.input.artifactId);
      }
      this.plugin.addToHistory(noteName, 'error', job.mode, {
        url: job.input.url || job.input.sourceUrl,
        platform: job.platform,
        error: message,
        durationMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      });
      throw failure;
    }
  }

  /**
   * A link to an ordinary web page, with the light tier ready: its text is read here and the
   * draft becomes a pasted article with its link, written without the backend. A page with too
   * little text (a login wall, a page drawn by script) is left as it was.
   */
  private async readArticles(drafts: JobDraft[], mode: ProcessingMode) {
    if (mode === 'info-only' || this.plugin.settings.liteTierEnabled === false) return;
    if (!this.plugin.liteReady()) return;
    const pages = drafts.filter(
      (draft) =>
        isArticleLink(draft.input.url) &&
        !draft.input.transcript?.trim() &&
        !draft.input.localFile &&
        !draft.input.localFiles?.length,
    );
    if (pages.length === 0) return;
    const notice = new Notice(tr('正在读取网页正文…', 'Reading the page…'), 0);
    try {
      await Promise.all(
        pages.map(async (draft) => {
          const url = draft.input.url as string;
          try {
            const reply = await requestUrl({ url, method: 'GET', throw: false });
            if (reply.status >= 400 || !reply.text) return;
            const doc = new DOMParser().parseFromString(reply.text, 'text/html');
            const { title, text } = extractArticle(doc);
            if (text.length < MIN_ARTICLE_CHARS) return;
            draft.input = { ...draft.input, transcript: text, article: true };
            if (title) draft.title = title;
            draft.platform = 'web';
          } catch (error) {
            console.warn('[Video Summary] 读取网页失败', url, error);
          }
        }),
      );
    } finally {
      notice.hide();
    }
  }

  /** Whether the light tier takes this input: on in settings, a transcript, a summary key. */
  liteFor(input: VideoInput, mode: ProcessingMode) {
    const enabled = this.plugin.settings.liteTierEnabled !== false;
    return liteDecision(enabled, this.plugin.liteReady(), input, mode);
  }

  /**
   * Before queueing a job that needs the backend. With no backend at all, says what the
   * full tier is for and holds the job; otherwise the usual check, which holds the queue
   * and offers Start backend when the backend is off.
   */
  private async waitForBackendOrExplain(inputs: VideoInput[], mode: ProcessingMode) {
    if (this.plugin.hasBackend() || this.plugin.settings.liteTierEnabled === false) {
      const liteReady = this.plugin.liteReady();
      const fromPage = inputs.some((input) => linkWantsPageCapture(input, liteReady, mode));
      await this.plugin.backend.readyOrHold(fromPage);
      return;
    }
    this.plugin.jobs.setHeld(true);
    new Notice(
      tr(
        '这条要完整档：只有链接或本地文件时，由后端下载并转写。装好后端后它会自动开始。\n不装后端：在 YouTube 或 B 站的视频页用浏览器扩展发送，或贴文稿。',
        'This one needs the full tier: with only a link or a local file, the backend downloads and transcribes it. It starts by itself once a backend is installed.\nWithout a backend: send from the YouTube or Bilibili page with the browser extension, or paste a transcript.',
      ),
      12_000,
    );
  }

  /** Title, uploader, duration and cover already on the job's note, as the backend would have them. */
  private async videoMetaFor(job: Job): Promise<LiteVideoMeta> {
    const file = this.fileFor(job);
    let fm: Record<string, unknown> | undefined = file
      ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
      : undefined;
    // Right after Obsidian starts (a link can be what starts it) the cache may not have the
    // note yet; read it, or the note's file name would replace the video's title.
    if (file && !fm) {
      try {
        const info = getFrontMatterInfo(await this.plugin.app.vault.read(file));
        fm = info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown>) : undefined;
      } catch {
        fm = undefined;
      }
    }
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const url = job.input?.url || job.input?.sourceUrl;
    let title = text(fm?.video_title) || job.title;
    let author = text(fm?.video_author);
    // A pasted link carries no title: ask YouTube once, or the note keeps the made-up
    // "YouTube视频_<id>" title and the postmark has no channel.
    if (isPlaceholderTitle(title, url) || !author) {
      const info = await youTubeOEmbed(url, async (endpoint) => {
        const response = await requestUrl({ url: endpoint, throw: false });
        return response.status === 200 ? (response.json as unknown) : null;
      });
      if (info.title && isPlaceholderTitle(title, url)) title = info.title;
      author = author || info.author;
    }
    return {
      title,
      author,
      duration: text(fm?.video_duration),
      cover: text(fm?.video_cover),
      frames: text(fm?.video_frames),
    };
  }

  /** Light tier: the job's transcript, then the person's model, streamed. */
  private async runLite(
    job: Job,
    report: (progress: JobProgress) => void,
  ): Promise<ProcessingResult> {
    const { settings } = this.plugin;
    const llm = resolveLlm(settings);
    const controller = new AbortController();
    this.liteControllers.set(job.id, controller);
    // The note grows a few characters at a time; redraw the panel at most a few times a second.
    let lastLive = 0;
    let lastStage = '';
    const throttled = (progress: JobProgress) => {
      // While a reasoning model thinks, the same stage arrives many times a second.
      if (progress.liveText === undefined && !progress.message) {
        if (progress.stageLabel === lastStage) return;
        lastStage = progress.stageLabel || '';
      }
      if (progress.liveText !== undefined && !progress.message) {
        lastStage = progress.stageLabel || '';
        const now = Date.now();
        if (now - lastLive < 150 && progress.liveText) return;
        lastLive = now;
      }
      report(progress);
    };
    try {
      // Bilibili's pictures only load with a Bilibili referer: saved into the vault first.
      let images: NoteImage[] = [];
      const source = job.input.url || job.input.sourceUrl;
      if (job.mode === 'summary' && bilibiliRef(source) && job.notePath) {
        throttled({ stageLabel: tr('保存封面和截帧', 'Saving the cover and frames') });
        try {
          const meta = await this.videoMetaFor(job);
          images = await bilibiliNoteImages(
            this.plugin.app,
            source,
            job.notePath,
            meta.cover,
            meta.frames,
          );
        } catch (error) {
          console.warn('[Video Summary] B 站图片保存失败', error);
        }
      }
      return await runLiteJob(
        {
          transport: nodeStreamTransport,
          baseUrl: llm.baseUrl,
          apiKey: readSecret(this.plugin.app, settings.llmKeySecret) || '',
          model: llm.model,
          noteStyle: settings.noteStyle,
          images,
        },
        job.input,
        job.mode,
        job.language,
        throttled,
        controller.signal,
        await this.videoMetaFor(job),
      );
    } finally {
      this.liteControllers.delete(job.id);
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
    await this.noteProcessor.markProcessingSuccess(
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
    const managedMediaRoot = mediaAssetRoot(this.plugin.settings.outputFolder);
    stripBackendMediaAssetPaths(result);
    hydratePersistedReprocessResult(result, job.input, previous);
    stripUntrustedPersistedMediaAssetPaths(result, previous, managedMediaRoot);

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
      managedMediaRoot,
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
      backend: 'n8n' as const,
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
      media_asset_root: managedMediaRoot,
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
          backend: saved.provenance.backend || 'n8n',
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

/** Fresh backend payloads never get to assert that a Vault path is already trusted. */
function stripBackendMediaAssetPaths(result: ProcessingResult): void {
  result.video_segments = result.video_segments?.map((segment) => ({
    ...segment,
    keyframe: segment.keyframe ? { ...segment.keyframe, path: undefined } : undefined,
  }));
  result.visual_evidence = result.visual_evidence?.map((evidence) => ({
    ...evidence,
    keyframe: evidence.keyframe ? { ...evidence.keyframe, path: undefined } : undefined,
  }));
}

function backendLostText(): string {
  return tr(
    '处理到一半后端停了，任务已中止。启动后端后点“重试”。',
    'The backend stopped in the middle of this job. Start the backend, then choose Retry.',
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? errorMessage(error) : String(error);
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
