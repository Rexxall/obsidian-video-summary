import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
  private resolve: (value: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    private title: string,
    private message: string,
    resolve: (value: boolean) => void,
  ) {
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
    this.message.split('\n').forEach((line, index) => {
      if (index > 0) messageEl.createEl('br');
      messageEl.appendText(line);
    });

    // 按钮容器
    const buttonContainer = contentEl.createEl('div', { cls: 'confirm-buttons' });

    // 确认按钮
    const confirmBtn = buttonContainer.createEl('button', {
      text: '确认',
      cls: 'mod-cta',
    });
    confirmBtn.onclick = () => {
      this.settle(true);
      this.close();
    };

    // 取消按钮
    const cancelBtn = buttonContainer.createEl('button', {
      text: '取消',
      cls: 'mod-warning',
    });
    cancelBtn.onclick = () => {
      this.settle(false);
      this.close();
    };

    // 安全默认：按回车或通过键盘操作时不会意外授权敏感动作。
    cancelBtn.focus();
  }

  onClose() {
    // Escape、点击遮罩、窗口关闭等路径都必须按取消完成 Promise。
    this.settle(false);
    const { contentEl } = this;
    contentEl.empty();
  }

  private settle(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
  }
}
