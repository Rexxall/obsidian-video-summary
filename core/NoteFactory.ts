// agent: claude (2026-07-26)
import { App, TFile } from 'obsidian';
import { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';
import { JobDraft, titleForUrl } from './InputParser';

export interface NoteFactoryOptions {
  outputFolder: string;
  successStatusValue: string;
}

/**
 * 建笔记相关的纯操作，从旧视图的 createNoteForPart / createNoteFromWebhookResult 移出来，
 * 行为保持一致（YAML 结构、文件名冲突处理、正文骨架都没变）。
 */
export class NoteFactory {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** 为一个待处理任务创建占位笔记 */
  async createStubNote(draft: JobDraft, options: NoteFactoryOptions): Promise<TFile | null> {
    const targetFolder = this.resolveFolder(options.outputFolder);
    const filePath = await this.uniquePath(targetFolder, sanitizeFileName(draft.title));

    const now = new Date();
    const dateString = formatDateTime(now);
    const lines: string[] = ['---'];
    if (draft.input.url) lines.push(`link: ${yamlEscape(draft.input.url)}`);
    lines.push('video_summary: true');
    lines.push('source_type: video');
    lines.push('video_summary_status: pending');
    lines.push('status: pending');
    lines.push(`video_title: ${yamlEscape(draft.title)}`);
    lines.push(`date: ${dateString}`);
    if (draft.input.transcript) {
      lines.push('provided_transcript: |');
      lines.push(`  ${draft.input.transcript.replace(/\n/g, '\n  ')}`);
    }
    if (draft.input.localFile) {
      lines.push(`local_file: ${yamlEscape(draft.input.localFile)}`);
    }
    lines.push('---');

    const content = `${lines.join('\n')}

# ${draft.title}

## 基本信息
- **视频链接**: ${draft.input.url || '（无）'}
- **创建时间**: ${now.toLocaleString('zh-CN')}
- **处理状态**: 待处理

## 视频内容
<!-- 视频总结将在这里生成 -->

## 笔记
<!-- 个人笔记将在这里生成 -->

## 文稿
<!-- 视频文稿将在这里生成 -->
`;

    try {
      return await this.app.vault.create(filePath, content);
    } catch (error) {
      console.error('[NoteFactory] 创建笔记失败', error);
      return null;
    }
  }

  /** 直接把一份 webhook 结果落成新笔记 */
  async createNoteFromResult(
    entry: {
      result: ProcessingResult;
      input: VideoInput;
      mode: ProcessingMode;
      language: SupportedLanguage;
      timestamp: number;
    },
    options: NoteFactoryOptions,
  ): Promise<TFile | null> {
    const folder = this.resolveFolder(options.outputFolder);
    const baseTitle =
      entry.result.video_title || (entry.input.url ? titleForUrl(entry.input.url) : 'Webhook结果');
    const fileName = `${sanitizeFileName(baseTitle)}_${entry.timestamp}`;
    const filePath = await this.uniquePath(folder, fileName);

    const fm: string[] = ['---'];
    fm.push('video_summary: true');
    fm.push('source_type: video');
    fm.push('video_summary_status: success');
    fm.push(`status: ${yamlEscape(options.successStatusValue || 'success')}`);
    if (entry.input.url) fm.push(`link: ${yamlEscape(entry.input.url)}`);
    if (entry.result.video_title) fm.push(`video_title: ${yamlEscape(entry.result.video_title)}`);
    if (entry.result.video_author)
      fm.push(`video_author: ${yamlEscape(entry.result.video_author)}`);
    if (entry.result.video_duration)
      fm.push(`video_duration: ${yamlEscape(entry.result.video_duration)}`);
    if (entry.result.video_cover) fm.push(`video_cover: ${yamlEscape(entry.result.video_cover)}`);
    fm.push(`date: ${new Date(entry.timestamp).toISOString()}`);
    if (entry.result.summary) {
      fm.push('summary: |');
      fm.push(`  ${entry.result.summary.replace(/\n/g, '\n  ')}`);
    }
    if (entry.result.video_transcript) {
      fm.push('video_transcript: |');
      fm.push(`  ${entry.result.video_transcript.replace(/\n/g, '\n  ')}`);
    }
    fm.push('---\n');

    try {
      return await this.app.vault.create(
        filePath,
        `${fm.join('\n')}${entry.result.note?.trim() ?? ''}`,
      );
    } catch (error) {
      console.error('[NoteFactory] 从结果创建笔记失败', error);
      return null;
    }
  }

  private resolveFolder(outputFolder: string): string {
    if (outputFolder) return outputFolder;
    const activeFile = this.app.workspace.getActiveFile();
    return activeFile?.parent?.path && activeFile.parent.path !== '/' ? activeFile.parent.path : '';
  }

  private async uniquePath(folder: string, baseName: string): Promise<string> {
    let candidate = folder ? `${folder}/${baseName}.md` : `${baseName}.md`;
    let counter = 1;
    while (await this.app.vault.adapter.exists(candidate)) {
      const name = `${baseName} (${counter})`;
      candidate = folder ? `${folder}/${name}.md` : `${name}.md`;
      counter += 1;
    }
    return candidate;
  }
}

/** 把结果拼成可插入当前笔记的 Markdown 片段 */
export function buildInsertionContent(result: ProcessingResult): string {
  const lines: string[] = ['---', '## Webhook 结果'];
  if (result.video_title) lines.push(`- **标题**: ${result.video_title}`);
  if (result.video_author) lines.push(`- **作者**: ${result.video_author}`);
  if (result.video_duration) lines.push(`- **时长**: ${result.video_duration}`);
  if (result.summary) {
    lines.push('', '### 总结', result.summary);
  }
  if (result.note) {
    lines.push('', '### 大纲', result.note);
  }
  if (result.video_transcript) {
    lines.push('', '### 文稿', result.video_transcript);
  }
  lines.push('---');
  return lines.join('\n');
}

/** 从任意 webhook payload 里尽力还原原始输入 */
export function extractVideoInputFromPayload(raw: any): VideoInput {
  const sources: any[] = [];
  const collect = (obj: any) => {
    if (!obj || typeof obj !== 'object') return;
    sources.push(obj);
    if (obj.metadata && typeof obj.metadata === 'object') sources.push(obj.metadata);
    if (obj.input && typeof obj.input === 'object') sources.push(obj.input);
  };
  if (Array.isArray(raw)) raw.forEach(collect);
  else collect(raw);

  const pick = (keys: string[]) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return undefined;
  };

  const input: VideoInput = {};
  const link = pick(['link', 'url']);
  if (link) input.url = link;
  const transcript = pick(['provided_transcript', 'transcript']);
  if (transcript) input.transcript = transcript;
  const localFile = pick(['local_file', 'localFileName', 'localFile']);
  if (localFile) input.localFile = localFile;
  return input;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'video_note';
}

export function yamlEscape(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '""';
  const needsQuotes = /[:[\]{}#,&*!?|<>=@`]/.test(trimmed);
  return needsQuotes ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
}

function formatDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
