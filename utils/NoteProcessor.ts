import { TFile, Vault, parseYaml, stringifyYaml } from 'obsidian';
import { ProcessingResult, NoteMetadata, VideoInput, ProcessingMode } from '../types';
import { SUPPORTED_PLATFORMS } from '../constants';
import {
  buildRichFrontmatterFields,
  managedWriteOptionsForMode,
  writeManagedKnowledgeMarkdown,
} from '../core/KnowledgeMarkdown';

import { errorMessage } from './errors';
import { asRecord, type JsonRecord } from './json';
export class NoteProcessor {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * 解析 frontmatter 与正文
   */
  private parseFrontmatter(content: string): { fm: JsonRecord; body: string } {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) {
      const fmText = fmMatch[1];
      let fm: JsonRecord = {};
      try {
        fm = asRecord(parseYaml(fmText));
      } catch {
        fm = {};
      }
      const body = content.slice(fmMatch[0].length);
      return { fm, body };
    }
    return { fm: {}, body: content };
  }

  /**
   * 构建包含 frontmatter 的内容
   */
  private buildContent(fm: JsonRecord, body: string): string {
    const fmText = stringifyYaml(fm);
    return `---\n${(fmText || '').trim()}\n---\n${body}`;
  }

  /**
   * 从笔记内容中提取视频链接
   */
  extractVideoUrl(content: string): string | null {
    const { fm, body } = this.parseFrontmatter(content);
    // frontmatter 优先
    const linkField = fm.link;
    if (Array.isArray(linkField)) {
      for (const l of linkField) {
        if (typeof l === 'string' && this.isValidVideoUrl(l)) return l;
      }
    } else if (typeof linkField === 'string') {
      if (this.isValidVideoUrl(linkField)) return linkField;
    }
    // 正文回退
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const urls = body.match(urlRegex);
    if (urls) {
      for (const url of urls) {
        if (this.isValidVideoUrl(url)) return url;
      }
    }
    return null;
  }

  /**
   * 从笔记内容中提取现有文稿
   */
  extractExistingTranscript(content: string): string | null {
    const { fm } = this.parseFrontmatter(content);
    const v = fm.video_transcript;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  extractProvidedTranscript(content: string): string | null {
    const { fm } = this.parseFrontmatter(content);
    const provided = fm.provided_transcript;
    if (typeof provided === 'string' && provided.trim()) {
      return provided.trim();
    }
    const existing = fm.video_transcript;
    if (typeof existing === 'string' && existing.trim()) {
      return existing.trim();
    }
    return null;
  }

  /**
   * 从笔记内容中提取本地文件名
   */
  extractLocalFileName(content: string): string | null {
    const { fm } = this.parseFrontmatter(content);
    const v = fm.local_file;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  /**
   * 从笔记内容中提取多个本地文件名（逗号分隔）
   */
  extractLocalFileNames(content: string): string[] {
    const raw = this.extractLocalFileName(content);
    if (!raw) return [];
    return raw
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
  }

  /**
   * 从笔记内容中提取元数据
   */
  extractMetadata(content: string): NoteMetadata {
    const { fm } = this.parseFrontmatter(content);
    const md: NoteMetadata = {};
    const fields = md as Record<string, unknown>;
    const copy = (k: string) => {
      const v = fm[k];
      if (typeof v === 'string') fields[k] = v;
    };
    [
      'status',
      'video_summary_status',
      'link',
      'video_title',
      'video_author',
      'video_duration',
      'video_cover',
      'video_artifact_id',
      'video_content_type',
      'video_attention_action',
      'video_processing_depth',
      'video_review_due',
      'summary',
      'video_transcript',
      'date',
      'updated',
    ].forEach((k) => copy(k));
    return md;
  }

  /**
   * 检查笔记是否已经包含基础视频信息（用于 info-only 批量补全）
   * 这里的「info」主要指：视频标题 / 作者 / 时长 等基础字段
   */
  hasBasicVideoInfo(content: string): boolean {
    const metadata = this.extractMetadata(content);
    return !!(metadata.video_title || metadata.video_author || metadata.video_duration);
  }

  /**
   * 更新笔记内容
   */
  async updateNote(
    file: TFile,
    result: ProcessingResult,
    mode: ProcessingMode,
    options?: { autoRename?: boolean; conflictStrategy?: 'skip' | 'append-number' | 'append-date' },
  ): Promise<void> {
    const content = await this.vault.read(file);
    const { fm, body } = this.parseFrontmatter(content);

    // 插件状态与用户自己的通用 status 分离；旧插件笔记仍由 setProcessingStatus 兼容。
    fm.video_summary = true;
    if (!fm.source_type) fm.source_type = 'video';

    // 复杂证据保存在 sidecar；frontmatter 只写可安全序列化的标量投影。
    Object.assign(fm, buildRichFrontmatterFields(result));
    const learningItems =
      (result.learning?.flashcards?.length || 0) + (result.learning?.questions?.length || 0);
    if (learningItems > 0 && !fm.video_review_due) {
      fm.video_review_due = new Date().toISOString();
    }
    delete fm.processing_error;
    delete fm.processing_error_code;
    delete fm.processing_error_at;

    // 清理 provided_transcript
    if (fm.provided_transcript) delete fm.provided_transcript;

    // 更新正文
    let newBody = body;
    newBody = this.removeProcessingErrorBlock(newBody);
    const sourceUrl = typeof fm.link === 'string' ? fm.link : '';
    newBody = writeManagedKnowledgeMarkdown(
      newBody,
      result,
      sourceUrl,
      managedWriteOptionsForMode(mode),
    );

    const newContent = this.buildContent(fm, newBody);
    await this.vault.process(file, (current) => {
      if (current !== content) throw new Error('笔记在处理期间已变化，请重试；你的修改已保留。');
      return newContent;
    });

    // 自动重命名（受开关控制）
    if (options?.autoRename) {
      await this.renameFileToVideoTitle(
        file,
        result.video_title || '',
        newBody,
        options.conflictStrategy || 'append-number',
      );
    }
  }

  /**
   * 设置处理状态
   */
  async setProcessingStatus(file: TFile, status: string): Promise<void> {
    const content = await this.vault.read(file);
    const { fm, body } = this.parseFrontmatter(content);
    const mirrorLegacyStatus = shouldMirrorLegacyStatus(fm.status);
    fm.video_summary = true;
    if (!fm.source_type) fm.source_type = 'video';
    fm.video_summary_status = canonicalPluginStatus(status);
    if (mirrorLegacyStatus) fm.status = status;
    const newContent = this.buildContent(fm, body);
    await this.vault.process(file, (current) => {
      if (current !== content) throw new Error('笔记在处理期间已变化，请重试；你的修改已保留。');
      return newContent;
    });
  }

  async setProcessingError(file: TFile, error: unknown): Promise<void> {
    const content = await this.vault.read(file);
    const { fm, body } = this.parseFrontmatter(content);
    const errorMessage = this.normalizeErrorMessage(error);
    const mirrorLegacyStatus = shouldMirrorLegacyStatus(fm.status);
    fm.video_summary = true;
    if (!fm.source_type) fm.source_type = 'video';
    fm.video_summary_status = 'error';
    if (mirrorLegacyStatus) fm.status = 'error';
    fm.processing_error = errorMessage;
    fm.processing_error_at = new Date().toISOString();
    const newBody = `${this.removeProcessingErrorBlock(body).trim()}\n\n${this.buildProcessingErrorBlock(errorMessage)}\n`;
    const newContent = this.buildContent(fm, newBody);
    await this.vault.process(file, (current) => {
      if (current !== content) throw new Error('笔记在处理期间已变化，请重试；你的修改已保留。');
      return newContent;
    });
  }

  /**
   * 构建视频输入对象
   */
  buildVideoInput(content: string): VideoInput {
    const input: VideoInput = {};

    // 提取视频链接
    const url = this.extractVideoUrl(content);
    if (url) {
      input.url = url;
    }

    // 提取提供的文稿（provided_transcript）
    const providedTranscript = this.extractProvidedTranscript(content);
    if (providedTranscript) {
      input.transcript = providedTranscript;
    }

    // 提取本地文件名
    const localFiles = this.extractLocalFileNames(content);
    if (localFiles.length > 0) {
      if (localFiles.length === 1) {
        input.localFile = localFiles[0];
      } else {
        input.localFile = localFiles.join(', '); // 保持兼容性
        input.localFiles = localFiles;
        input.merge = true; // 默认开启合并
      }
    }

    return input;
  }

  /**
   * 检查是否为有效的视频URL
   */
  private isValidVideoUrl(url: string): boolean {
    return SUPPORTED_PLATFORMS.some((platform) => url.includes(platform));
  }

  /**
   * 更新或添加frontmatter字段
   */
  private updateOrAddField(fmText: string, field: string, value: string): string {
    const regex = new RegExp(`^${field}:.*$`, 'm');
    const newValue = `"${String(value).replace(/"/g, '\\"')}"`;
    const fieldLine = `${field}: ${newValue}`;

    if (regex.test(fmText)) {
      return fmText.replace(regex, fieldLine);
    } else {
      return `${fmText.trim()}\n${fieldLine}`;
    }
  }

  /**
   * 更新文稿字段（使用YAML block scalar格式）
   */
  private updateTranscriptField(fmText: string, transcript: string): string {
    const transcriptBlock = `|\n  ${transcript.replace(/\n/g, '\n  ')}`;
    const regex = /^video_transcript:[\s\S]*?(?=\n\w+:\s|$)/m;
    const fieldLine = `video_transcript: ${transcriptBlock}`;

    if (regex.test(fmText)) {
      return fmText.replace(regex, fieldLine);
    } else {
      return `${fmText}\n${fieldLine}`;
    }
  }

  /**
   * 移除frontmatter字段
   */
  private removeField(fmText: string, field: string): string {
    const regex = new RegExp(`^${field}:.*$\\n?`, 'gm');
    return fmText.replace(regex, '').replace(/\n\n+/g, '\n').trim();
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) return errorMessage(error);
    return typeof error === 'string' && error ? error : '未知错误';
  }

  private buildProcessingErrorBlock(errorMessage: string): string {
    const lines = errorMessage
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return [
      '<!-- video-summary-error:start -->',
      '## 处理错误',
      '> [!failure] 视频处理失败',
      lines || '> 未知错误',
      '>',
      '> 出错的步骤可以在 n8n 的 Executions 页面查看：http://127.0.0.1:5678/home/executions',
      '<!-- video-summary-error:end -->',
    ].join('\n');
  }

  private removeProcessingErrorBlock(body: string): string {
    return body
      .replace(
        /\n?<!-- video-summary-error:start -->[\s\S]*?<!-- video-summary-error:end -->\n?/g,
        '\n',
      )
      .replace(/\n{3,}/g, '\n\n');
  }

  /**
   * 检查笔记是否包含视频内容
   */
  hasVideoContent(content: string): boolean {
    return (
      !!this.extractVideoUrl(content) ||
      !!this.extractProvidedTranscript(content) ||
      !!this.extractLocalFileName(content)
    );
  }

  /**
   * 获取笔记的处理状态
   */
  getProcessingStatus(content: string): string | null {
    const metadata = this.extractMetadata(content);
    return metadata.video_summary_status || metadata.status || null;
  }

  /**
   * 检查笔记是否需要处理
   */
  needsProcessing(content: string): boolean {
    const status = this.getProcessingStatus(content);
    return !status || status === 'error' || status === 'running';
  }

  /**
   * 从正文中提取标题
   */
  private extractBodyTitle(body: string): string | null {
    // 移除frontmatter部分
    const bodyOnly = body.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 查找第一个标题（# 开头）
    const titleMatch = bodyOnly.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return titleMatch[1].trim();
    }

    // 查找第一个二级标题（## 开头）
    const h2Match = bodyOnly.match(/^##\s+(.+)$/m);
    if (h2Match) {
      return h2Match[1].trim();
    }

    // 查找第一个三级标题（### 开头）
    const h3Match = bodyOnly.match(/^###\s+(.+)$/m);
    if (h3Match) {
      return h3Match[1].trim();
    }

    // 兜底：取正文第一行非空文本作为标题
    const lines = bodyOnly
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      return lines[0].slice(0, 80);
    }

    // 如果没有找到标题，返回null
    return null;
  }

  /**
   * 根据video_title或正文标题重命名文件
   */
  private async renameFileToVideoTitle(
    file: TFile,
    videoTitle: string,
    body: string,
    strategy: 'skip' | 'append-number' | 'append-date' = 'append-number',
  ): Promise<void> {
    try {
      // 确定要使用的标题
      let titleToUse = '';

      // 规则1：如果YAML中有video_title字段且不为空，使用video_title
      if (videoTitle && videoTitle.trim()) {
        titleToUse = videoTitle.trim();
      } else {
        // 规则2：其他情况使用正文标题
        const bodyTitle = this.extractBodyTitle(body);
        if (bodyTitle && bodyTitle.trim()) {
          titleToUse = bodyTitle.trim();
        } else {
          // 如果都没有，不重命名
          return;
        }
      }

      // 清理文件名中的非法字符
      const cleanTitle = titleToUse.replace(/[<>:"/\\|?*]/g, '_').trim();
      if (!cleanTitle) {
        return; // 如果清理后为空，不重命名
      }

      // 构建新文件名（保持原有路径）
      const newFileName = `${cleanTitle}.md`;

      // 如果文件在子文件夹中，保持原有路径
      if (file.parent && file.parent.path !== '') {
        const newPath = `${file.parent.path}/${newFileName}`;
        if (newPath === file.path) {
          return;
        }

        let targetPath = newPath;
        const exists = (p: string) => !!this.vault.getAbstractFileByPath(p);
        if (exists(targetPath)) {
          if (strategy === 'skip') {
            return;
          }
          if (strategy === 'append-date') {
            const date = new Date().toISOString().slice(0, 10);
            targetPath = `${file.parent.path}/${cleanTitle} ${date}.md`;
            if (exists(targetPath)) {
              strategy = 'append-number';
            }
          }
          if (strategy === 'append-number') {
            let index = 1;
            while (exists(`${file.parent.path}/${cleanTitle} (${index}).md`)) index++;
            targetPath = `${file.parent.path}/${cleanTitle} (${index}).md`;
          }
        }
        await this.vault.rename(file, targetPath);
      } else {
        // 文件在根目录
        let targetPath = newFileName;
        if (targetPath === file.path) {
          return;
        }
        const exists = (p: string) => !!this.vault.getAbstractFileByPath(p);
        if (exists(targetPath)) {
          if (strategy === 'skip') {
            return;
          }
          if (strategy === 'append-date') {
            const date = new Date().toISOString().slice(0, 10);
            targetPath = `${cleanTitle} ${date}.md`;
            if (exists(targetPath)) {
              strategy = 'append-number';
            }
          }
          if (strategy === 'append-number') {
            let index = 1;
            while (exists(`${cleanTitle} (${index}).md`)) index++;
            targetPath = `${cleanTitle} (${index}).md`;
          }
        }
        await this.vault.rename(file, targetPath);
      }
    } catch (error) {
      console.error(`重命名文件失败: ${errorMessage(error)}`);
    }
  }
}

/**
 * 只兼容插件历来写入通用 `status` 的那些值。
 * 诸如 `status: 🔍` 的用户工作流状态必须原样保留，插件状态写入独立字段。
 */
function shouldMirrorLegacyStatus(value: unknown): boolean {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (text.trim() === '') return true;
  const status = text.trim().toLowerCase();
  return new Set([
    'pending',
    'running',
    'success',
    'error',
    'excluded',
    '📺',
    '⏳',
    '✅',
    '▶️',
    '❌',
    '⛔️',
    '⛔',
    '待处理',
    '处理中',
    '已处理',
    '处理失败',
    '非视频笔记',
  ]).has(status);
}

function canonicalPluginStatus(
  value: string,
): 'pending' | 'running' | 'success' | 'error' | 'excluded' {
  const status = String(value || '')
    .trim()
    .toLowerCase();
  if (status === 'pending' || status === '📺' || status === '待处理') return 'pending';
  if (status === 'running' || status === '⏳' || status === '处理中') return 'running';
  if (status === 'error' || status === '❌' || status === '处理失败') return 'error';
  if (status === 'excluded' || status.includes('⛔') || status === '非视频笔记') return 'excluded';
  // 这个入口的其他值来自“成功状态文本”设置；插件自己的真值仍保持 canonical。
  return 'success';
}
