/**
 * A finished model result kept on disk until it is in its note: if writing the note fails
 * (or Obsidian closes first), the job comes back as "ready to write" and can be written again
 * without calling the model or fetching the transcript again. No obsidian import.
 */
import type { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';
import { type FileAdapter, readJsonGuarded, writeJsonChecked } from './SafeFiles';

/** The job fields needed to show it and write it again. */
export interface PendingJob {
  id: string;
  title: string;
  notePath?: string;
  input: VideoInput;
  mode: ProcessingMode;
  language: SupportedLanguage;
  platform?: string;
  lite?: boolean;
}

export interface PendingRecord {
  version: 1;
  savedAt: number;
  job: PendingJob;
  result: ProcessingResult;
  /** Why writing failed, once it has. */
  error?: string;
}

/** Thrown by a job whose result came back but could not be written; carries the result. */
export class WriteFailedError extends Error {
  constructor(
    message: string,
    readonly result: ProcessingResult,
  ) {
    super(message);
    this.name = 'WriteFailedError';
  }
}

export interface PendingAdapter extends FileAdapter {
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export class PendingResults {
  constructor(
    private adapter: PendingAdapter,
    private dir: string,
  ) {}

  private path(id: string): string {
    return `${this.dir}/${id.replace(/[^\w-]/g, '_')}.json`;
  }

  async save(job: PendingJob, result: ProcessingResult, error?: string): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
    const record: PendingRecord = {
      version: 1,
      savedAt: Date.now(),
      job: {
        id: job.id,
        title: job.title,
        notePath: job.notePath,
        input: job.input,
        mode: job.mode,
        language: job.language,
        platform: job.platform,
        lite: job.lite,
      },
      result,
      ...(error ? { error } : {}),
    };
    await writeJsonChecked(this.adapter, this.path(job.id), JSON.stringify(record));
  }

  async remove(id: string): Promise<void> {
    const path = this.path(id);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  /** Every kept result, oldest first; files that do not parse are set aside by readJsonGuarded. */
  async list(): Promise<PendingRecord[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { files } = await this.adapter.list(this.dir);
    const records: PendingRecord[] = [];
    for (const file of files.filter((name) => /\.json$/.test(name))) {
      const read = await readJsonGuarded(this.adapter, file);
      if (read.state !== 'ok') continue;
      const record = read.value as Partial<PendingRecord>;
      if (record?.version === 1 && record.job?.id && record.result) {
        records.push(record as PendingRecord);
      }
    }
    return records.sort((a, b) => a.savedAt - b.savedAt);
  }
}
