import { TFile, Vault } from 'obsidian';
import * as yaml from 'js-yaml';
import { ProcessingResult, NoteMetadata, VideoInput, ProcessingMode } from '../types';
import { SUPPORTED_PLATFORMS } from '../constants';

export class NoteProcessor {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	/**
	 * 解析 frontmatter 与正文
	 */
	private parseFrontmatter(content: string): { fm: any; body: string } {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
		if (fmMatch) {
			const fmText = fmMatch[1];
			let fm: any = {};
			try {
				fm = yaml.load(fmText) || {};
			} catch (e) {
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
	private buildContent(fm: any, body: string): string {
		const fmText = yaml.dump(fm, { lineWidth: 1000 });
		return `---\n${(fmText || '').trim()}\n---\n${body}`;
	}

	/**
	 * 从笔记内容中提取视频链接
	 */
	extractVideoUrl(content: string): string | null {
		const { fm, body } = this.parseFrontmatter(content);
		// frontmatter 优先
		const linkField = (fm as any)?.link;
		if (Array.isArray(linkField)) {
			for (const l of linkField) {
				if (typeof l === 'string' && this.isValidVideoUrl(l)) return l;
			}
		} else if (typeof linkField === 'string') {
			if (this.isValidVideoUrl(linkField)) return linkField;
		}
		// 正文回退
		const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
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
		const v = (fm as any)?.video_transcript;
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	}

	extractProvidedTranscript(content: string): string | null {
		const { fm } = this.parseFrontmatter(content);
		const provided = (fm as any)?.provided_transcript;
		if (typeof provided === 'string' && provided.trim()) {
			return provided.trim();
		}
		const existing = (fm as any)?.video_transcript;
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
		const v = (fm as any)?.local_file;
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	}

	/**
	 * 从笔记内容中提取多个本地文件名（逗号分隔）
	 */
	extractLocalFileNames(content: string): string[] {
		const raw = this.extractLocalFileName(content);
		if (!raw) return [];
		return raw.split(',').map(f => f.trim()).filter(f => f.length > 0);
	}

	/**
	 * 从笔记内容中提取元数据
	 */
	extractMetadata(content: string): NoteMetadata {
		const { fm } = this.parseFrontmatter(content);
		const md: NoteMetadata = {};
		if (!fm || typeof fm !== 'object') return md;
		const copy = (k: keyof NoteMetadata) => {
			const v = (fm as any)[k];
			if (typeof v === 'string') (md as any)[k] = v;
		};
		['status', 'link', 'video_title', 'video_author', 'video_duration', 'summary', 'video_transcript', 'date', 'updated'].forEach(k => copy(k as any));
		return md;
	}

	/**
	 * 检查笔记是否已经包含基础视频信息（用于 info-only 批量补全）
	 * 这里的「info」主要指：视频标题 / 作者 / 时长 等基础字段
	 */
	hasBasicVideoInfo(content: string): boolean {
		const metadata = this.extractMetadata(content) as any;
		return !!(metadata.video_title || metadata.video_author || metadata.video_duration);
	}

	/**
	 * 更新笔记内容
	 */
	async updateNote(
		file: TFile,
		result: ProcessingResult,
		mode: ProcessingMode,
		options?: { autoRename?: boolean; conflictStrategy?: 'skip' | 'append-number' | 'append-date' }
	): Promise<void> {
		const content = await this.vault.read(file);
		const { fm, body } = this.parseFrontmatter(content);

		// 不在此处修改 status，交由调用方根据设置写入

		// 更新处理结果
		if (result.video_title) fm.video_title = result.video_title;
		if (result.video_author) fm.video_author = result.video_author;
		if (result.video_duration) fm.video_duration = result.video_duration;
		if (result.summary) fm.summary = result.summary;
		if (result.video_transcript) fm.video_transcript = result.video_transcript;

		// 清理 provided_transcript
		if (fm.provided_transcript) delete fm.provided_transcript;

		// 更新正文
		let newBody = body;
		if (mode === 'summary' && result.note) newBody = result.note;

		const newContent = this.buildContent(fm, newBody);
		await this.vault.modify(file, newContent);

		// 自动重命名（受开关控制）
		if (options?.autoRename) {
			await this.renameFileToVideoTitle(
				file,
				result.video_title || '',
				newBody,
				options.conflictStrategy || 'append-number'
			);
		}
	}

	/**
	 * 设置处理状态
	 */
	async setProcessingStatus(file: TFile, status: string): Promise<void> {
		const content = await this.vault.read(file);
		const { fm, body } = this.parseFrontmatter(content);
		fm.status = status;
		const newContent = this.buildContent(fm, body);
		await this.vault.modify(file, newContent);
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
		return SUPPORTED_PLATFORMS.some(platform => url.includes(platform));
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

	/**
	 * 检查笔记是否包含视频内容
	 */
	hasVideoContent(content: string): boolean {
		return !!this.extractVideoUrl(content) ||
			!!this.extractProvidedTranscript(content) ||
			!!this.extractLocalFileName(content);
	}

	/**
	 * 获取笔记的处理状态
	 */
	getProcessingStatus(content: string): string | null {
		const metadata = this.extractMetadata(content);
		return metadata.status || null;
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
		const lines = bodyOnly.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
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
		strategy: 'skip' | 'append-number' | 'append-date' = 'append-number'
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

				let targetPath = newPath;
				const exists = (p: string) => !!this.vault.getAbstractFileByPath(p);
				if (exists(targetPath)) {
					if (strategy === 'skip') {
						console.log(`文件 ${targetPath} 已存在，策略=skip，跳过重命名`);
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
				console.log(`文件已重命名为: ${targetPath}`);
			} else {
				// 文件在根目录
				let targetPath = newFileName;
				const exists = (p: string) => !!this.vault.getAbstractFileByPath(p);
				if (exists(targetPath)) {
					if (strategy === 'skip') {
						console.log(`文件 ${targetPath} 已存在，策略=skip，跳过重命名`);
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
				console.log(`文件已重命名为: ${targetPath}`);
			}
		} catch (error) {
			console.error(`重命名文件失败: ${error.message}`);
		}
	}
} 