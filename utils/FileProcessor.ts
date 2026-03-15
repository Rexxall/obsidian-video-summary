import { App, TFile, MarkdownView, Notice } from 'obsidian';
import { VideoUtils } from './VideoUtils';
import { VideoSummaryModal } from '../modals';
import VideoSummaryPlugin from '../main';

/**
 * 文件处理工具类
 * 包含通用的文件处理逻辑
 */
export class FileProcessor {
	private app: App;
	private plugin: VideoSummaryPlugin;

	constructor(app: App, plugin: VideoSummaryPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	/**
	 * 处理单个文件
	 */
	async processFile(file: TFile): Promise<void> {
		try {
			const leaf = this.app.workspace.getLeaf();
			await leaf.openFile(file);
			setTimeout(() => {
				const view = leaf.view;
				if (view instanceof MarkdownView) {
					new VideoSummaryModal(this.app, this.plugin, view.editor, view).open();
				}
			}, 100);
		} catch (error) {
			new Notice(`处理文件失败: ${error.message}`);
		}
	}

	/**
	 * 检查文件是否包含视频内容
	 */
	async hasVideoContent(file: TFile): Promise<boolean> {
		try {
			const content = await this.app.vault.read(file);
			return VideoUtils.hasVideoMetadata(content);
		} catch (error) {
			console.error(`读取文件失败: ${file.path}`, error);
			return false;
		}
	}

	/**
	 * 获取文件的处理状态
	 */
	async getFileStatus(file: TFile): Promise<string | null> {
		try {
			const content = await this.app.vault.read(file);
			return VideoUtils.getProcessingStatus(content);
		} catch (error) {
			console.error(`读取文件状态失败: ${file.path}`, error);
			return null;
		}
	}

	/**
	 * 从文件内容中提取视频URL
	 */
	async extractVideoUrlFromFile(file: TFile): Promise<string | null> {
		try {
			const content = await this.app.vault.read(file);
			return VideoUtils.extractVideoUrl(content);
		} catch (error) {
			console.error(`从文件提取视频URL失败: ${file.path}`, error);
			return null;
		}
	}

	/**
	 * 从文件内容中提取提供的文稿
	 */
	async extractProvidedTranscriptFromFile(file: TFile): Promise<string | null> {
		try {
			const content = await this.app.vault.read(file);
			return VideoUtils.extractProvidedTranscript(content);
		} catch (error) {
			console.error(`从文件提取文稿失败: ${file.path}`, error);
			return null;
		}
	}

	/**
	 * 从文件内容中提取本地文件名
	 */
	async extractLocalFileNameFromFile(file: TFile): Promise<string | null> {
		try {
			const content = await this.app.vault.read(file);
			return VideoUtils.extractLocalFileName(content);
		} catch (error) {
			console.error(`从文件提取本地文件名失败: ${file.path}`, error);
			return null;
		}
	}

	/**
	 * 获取所有包含视频内容的Markdown文件
	 */
	async getVideoFiles(): Promise<TFile[]> {
		const markdownFiles = this.app.vault.getMarkdownFiles();
		const videoFiles: TFile[] = [];

		for (const file of markdownFiles) {
			if (await this.hasVideoContent(file)) {
				videoFiles.push(file);
			}
		}

		return videoFiles;
	}

	/**
	 * 按状态分组文件
	 */
	async groupFilesByStatus(files: TFile[]): Promise<{
		pending: TFile[];
		processing: TFile[];
		completed: TFile[];
		error: TFile[];
	}> {
		const groups = {
			pending: [] as TFile[],
			processing: [] as TFile[],
			completed: [] as TFile[],
			error: [] as TFile[]
		};

		for (const file of files) {
			const status = await this.getFileStatus(file);
			
			if (!status || status === 'pending') {
				groups.pending.push(file);
			} else if (status === 'running') {
				groups.processing.push(file);
			} else if (status === 'error') {
				groups.error.push(file);
			} else {
				groups.completed.push(file);
			}
		}

		return groups;
	}

	/**
	 * 获取文件统计信息
	 */
	async getFileStatistics(): Promise<{
		total: number;
		pending: number;
		processing: number;
		completed: number;
		error: number;
	}> {
		const videoFiles = await this.getVideoFiles();
		const groups = await this.groupFilesByStatus(videoFiles);

		return {
			total: videoFiles.length,
			pending: groups.pending.length,
			processing: groups.processing.length,
			completed: groups.completed.length,
			error: groups.error.length
		};
	}
} 