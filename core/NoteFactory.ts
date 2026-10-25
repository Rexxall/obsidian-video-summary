import { App, TFile } from 'obsidian';
import { ProcessingMode, ProcessingResult, SupportedLanguage, VideoInput } from '../types';
import { JobDraft, titleForUrl } from './InputParser';
import {
  buildRichFrontmatterFields,
  escapeUntrustedMarkdownInline,
  renderAttentionMarkdown,
  renderEvidenceMarkdown,
  renderLearningMarkdown,
  SafeFrontmatterScalar,
  serializeScalarFrontmatter,
  sanitizeGeneratedMarkdownActiveResources,
  writeManagedKnowledgeMarkdown,
} from './KnowledgeMarkdown';

export interface NoteFactoryOptions {
  outputFolder: string;
  successStatusValue: string;
}

/**
 * 建笔记相关的纯操作，从旧视图的 createNoteForPart / createNoteFromWebhookResult 移出来，
 * 保留 YAML 和文件名冲突处理；待处理状态只保存在属性中，不写空白正文模板。
 */
export class NoteFactory {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** 为一个待处理任务创建占位笔记 */
  async createStubNote(draft: JobDraft, options: NoteFactoryOptions): Promise<TFile | null> {
    const targetFolder = this.resolveFolder(options.outputFolder);
    await this.ensureFolder(targetFolder);
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

    const content = `${lines.join('\n')}\n`;

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
    await this.ensureFolder(folder);
    const baseTitle =
      entry.result.video_title || (entry.input.url ? titleForUrl(entry.input.url) : 'Webhook结果');
    const fileName = `${sanitizeFileName(baseTitle)}_${entry.timestamp}`;
    const filePath = await this.uniquePath(folder, fileName);

    const fm: Record<string, SafeFrontmatterScalar> = {
      video_summary: true,
      source_type: 'video',
      video_summary_status: 'success',
      status: options.successStatusValue || 'success',
      date: new Date(entry.timestamp).toISOString(),
      ...buildRichFrontmatterFields(entry.result),
    };
    if (entry.input.url) fm.link = entry.input.url;
    const learningItems =
      (entry.result.learning?.flashcards?.length || 0) +
      (entry.result.learning?.questions?.length || 0);
    if (learningItems > 0) fm.video_review_due = new Date(entry.timestamp).toISOString();
    const frontmatter = serializeScalarFrontmatter(fm);
    const body = writeManagedKnowledgeMarkdown('', entry.result, entry.input.url).trim();

    try {
      return await this.app.vault.create(
        filePath,
        `---\n${frontmatter}\n---\n${body ? `${body}\n` : ''}`,
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

  private async ensureFolder(folder: string): Promise<void> {
    const parts = folder
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
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
  if (result.video_title) {
    lines.push(`- **标题**: ${escapeUntrustedMarkdownInline(result.video_title)}`);
  }
  if (result.video_author) {
    lines.push(`- **作者**: ${escapeUntrustedMarkdownInline(result.video_author)}`);
  }
  if (result.video_duration) {
    lines.push(`- **时长**: ${escapeUntrustedMarkdownInline(result.video_duration)}`);
  }
  if (result.summary) {
    lines.push('', '### 总结', sanitizeGeneratedMarkdownActiveResources(result.summary));
  }
  if (result.note) {
    lines.push('', '### 大纲', sanitizeGeneratedMarkdownActiveResources(result.note));
  }
  if (result.video_transcript) {
    lines.push('', '### 文稿', sanitizeGeneratedMarkdownActiveResources(result.video_transcript));
  }
  if (result.video_segments?.length || result.evidence_claims?.length) {
    lines.push('', renderEvidenceMarkdown(result, result.artifact?.source_url));
  }
  if (result.attention) {
    lines.push('', renderAttentionMarkdown(result, result.artifact?.source_url));
  }
  if (result.learning) {
    lines.push('', renderLearningMarkdown(result));
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
    if (obj.artifact && typeof obj.artifact === 'object') sources.push(obj.artifact);
    if (obj.result && typeof obj.result === 'object') {
      sources.push(obj.result);
      if (obj.result.input && typeof obj.result.input === 'object') sources.push(obj.result.input);
      if (obj.result.artifact && typeof obj.result.artifact === 'object') {
        sources.push(obj.result.artifact);
      }
    }
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
  const link = pick(['link', 'url', 'source_url']);
  if (link) input.url = link;
  const transcript = pick(['provided_transcript', 'transcript']);
  if (transcript) input.transcript = transcript;
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
