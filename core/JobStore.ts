// agent: claude (2026-07-26)
import { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';

export type JobState = 'queued' | 'running' | 'review' | 'success' | 'error' | 'cancelled';

export interface JobLogEntry {
  time: number;
  text: string;
}

export interface Job {
  id: string;
  title: string;
  /** 目标笔记路径；从链接新建的任务在建好笔记后回填 */
  notePath?: string;
  input: VideoInput;
  mode: ProcessingMode;
  language: SupportedLanguage;
  useCache: boolean;
  state: JobState;
  /** 后端上报的阶段文本。n8n 不上报，保持 undefined，界面只显示计时 */
  stageLabel?: string;
  /** 0-1；后端不上报时为 undefined，界面用不确定态进度条 */
  progress?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  result?: ProcessingResult;
  logs: JobLogEntry[];
  platform?: string;
  /** 结果已拿到但还没写入笔记（预览后手动确认时用） */
  awaitingWrite?: boolean;
}

export interface JobSpec {
  title: string;
  input: VideoInput;
  mode: ProcessingMode;
  language: SupportedLanguage;
  useCache: boolean;
  notePath?: string;
  platform?: string;
  /** 结果先进预览、不直接写笔记。必须在入队时就定，否则任务可能已经跑起来了 */
  awaitingWrite?: boolean;
}

export interface JobProgress {
  stageLabel?: string;
  progress?: number;
  message?: string;
}

export type JobRunner = (
  job: Job,
  report: (progress: JobProgress) => void,
) => Promise<ProcessingResult>;

/**
 * 任务是插件的一等对象：进度、失败原因、日志都挂在这里，视图只订阅不持有。
 * 挂在 plugin 上而不是 view 上，关掉侧栏再打开任务不丢。
 */
export class JobStore {
  private jobs: Job[] = [];
  private listeners = new Set<() => void>();
  private runner: JobRunner | null = null;
  private running = 0;
  private seq = 0;
  private concurrency = 2;
  private cancelled = new Set<string>();

  setRunner(runner: JobRunner) {
    this.runner = runner;
  }

  setConcurrency(value: number) {
    this.concurrency = Math.max(1, value || 1);
    this.pump();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[JobStore] listener failed', error);
      }
    });
  }

  getAll(): Job[] {
    return this.jobs;
  }

  get(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  getActive(): Job[] {
    return this.jobs.filter((job) => job.state === 'queued' || job.state === 'running');
  }

  countByState(state: JobState): number {
    return this.jobs.filter((job) => job.state === state).length;
  }

  enqueue(spec: JobSpec): Job {
    const job: Job = {
      id: `job-${Date.now().toString(36)}-${(this.seq += 1)}`,
      title: spec.title,
      notePath: spec.notePath,
      input: spec.input,
      mode: spec.mode,
      language: spec.language,
      useCache: spec.useCache,
      platform: spec.platform,
      awaitingWrite: spec.awaitingWrite === true,
      state: 'queued',
      createdAt: Date.now(),
      logs: [],
    };
    this.jobs.unshift(job);
    this.emit();
    this.pump();
    return job;
  }

  /** 等一个任务跑到终态（命令面板走的是同步语义，需要等结果） */
  waitFor(id: string): Promise<Job | undefined> {
    const terminal = (state: JobState) =>
      state === 'success' || state === 'error' || state === 'cancelled' || state === 'review';
    const current = this.get(id);
    if (!current || terminal(current.state)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        const job = this.get(id);
        if (!job || terminal(job.state)) {
          off();
          resolve(job);
        }
      });
    });
  }

  update(id: string, patch: Partial<Job>) {
    const job = this.get(id);
    if (!job) return;
    Object.assign(job, patch);
    this.emit();
  }

  log(id: string, text: string) {
    const job = this.get(id);
    if (!job) return;
    job.logs.push({ time: Date.now(), text });
    if (job.logs.length > 200) job.logs.shift();
    this.emit();
  }

  cancel(id: string) {
    const job = this.get(id);
    if (!job) return;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.endedAt = Date.now();
      this.emit();
      return;
    }
    if (job.state === 'running') {
      // 实际中止由 runner 侧的 api.cancelByNoteName 完成，这里只登记意图
      this.cancelled.add(id);
      this.log(id, '已请求取消');
    }
  }

  isCancelRequested(id: string): boolean {
    return this.cancelled.has(id);
  }

  retry(id: string) {
    const job = this.get(id);
    if (!job) return;
    this.cancelled.delete(id);
    job.state = 'queued';
    job.error = undefined;
    job.result = undefined;
    job.awaitingWrite = false;
    job.stageLabel = undefined;
    job.progress = undefined;
    job.startedAt = undefined;
    job.endedAt = undefined;
    job.useCache = false; // 重试一律绕开缓存，否则会拿回同一个坏结果
    this.log(id, '重新排队（跳过缓存）');
    this.emit();
    this.pump();
  }

  remove(id: string) {
    this.jobs = this.jobs.filter((job) => job.id !== id);
    this.cancelled.delete(id);
    this.emit();
  }

  clearFinished() {
    this.jobs = this.jobs.filter(
      (job) => job.state === 'queued' || job.state === 'running' || job.state === 'review',
    );
    this.emit();
  }

  private pump() {
    if (!this.runner) return;
    while (this.running < this.concurrency) {
      const next = this.jobs.filter((job) => job.state === 'queued').pop();
      if (!next) return;
      void this.run(next);
    }
  }

  private async run(job: Job) {
    if (!this.runner) return;
    this.running += 1;
    job.state = 'running';
    job.startedAt = Date.now();
    job.error = undefined;
    this.emit();

    try {
      const result = await this.runner(job, (progress) => {
        if (progress.stageLabel !== undefined) job.stageLabel = progress.stageLabel;
        if (progress.progress !== undefined) job.progress = progress.progress;
        if (progress.message) this.log(job.id, progress.message);
        this.emit();
      });
      if (this.cancelled.has(job.id)) {
        job.state = 'cancelled';
      } else {
        job.result = result;
        job.state = job.awaitingWrite ? 'review' : 'success';
      }
    } catch (error) {
      job.state = this.cancelled.has(job.id) ? 'cancelled' : 'error';
      job.error = error instanceof Error ? error.message : String(error);
      this.log(job.id, job.error);
    } finally {
      this.cancelled.delete(job.id);
      job.endedAt = Date.now();
      job.progress = undefined;
      job.stageLabel = undefined;
      this.running -= 1;
      this.emit();
      this.pump();
    }
  }
}
