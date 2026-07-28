import { Job, JobStore } from '../core/JobStore';
import { VideoNoteEntry } from '../core/NoteIndex';

export type NoteDisplayStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'review'
  | 'interrupted'
  | 'success'
  | 'error';

/**
 * `running` 会被写进笔记并跨重启保留，但 JobStore 只代表本次插件会话。
 * 因此重载后没有对应活跃任务的 `running` 不能继续显示成“处理中”。
 */
export function noteDisplayStatus(entry: VideoNoteEntry, jobs: JobStore): NoteDisplayStatus {
  if (entry.status !== 'running') {
    if (entry.status === 'success' || entry.status === 'error' || entry.status === 'pending') {
      return entry.status;
    }
    return 'pending';
  }

  const job = liveJobForNote(jobs, entry.path);
  if (!job) return entry.hasGeneratedOutput ? 'success' : 'interrupted';
  if (job.state === 'review') return 'review';
  if (job.state === 'queued') return 'queued';
  return 'running';
}

export function liveJobForNote(jobs: JobStore, notePath: string): Job | undefined {
  return jobs
    .getAll()
    .find(
      (job) =>
        job.notePath === notePath &&
        (job.state === 'queued' || job.state === 'running' || job.state === 'review'),
    );
}
