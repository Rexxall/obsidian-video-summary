import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
	private resolve: (value: boolean) => void;

	constructor(app: App, private title: string, private message: string, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// 标题
		contentEl.createEl('h2', { text: this.title });

		// 消息内容
		const messageEl = contentEl.createEl('div', { cls: 'confirm-message' });
		messageEl.innerHTML = this.message.replace(/\n/g, '<br>');

		// 按钮容器
		const buttonContainer = contentEl.createEl('div', { cls: 'confirm-buttons' });

		// 确认按钮
		const confirmBtn = buttonContainer.createEl('button', {
			text: '确认',
			cls: 'mod-cta'
		});
		confirmBtn.onclick = () => {
			this.resolve(true);
			this.close();
		};

		// 取消按钮
		const cancelBtn = buttonContainer.createEl('button', {
			text: '取消',
			cls: 'mod-warning'
		});
		cancelBtn.onclick = () => {
			this.resolve(false);
			this.close();
		};

		// 默认聚焦到确认按钮
		confirmBtn.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
} 