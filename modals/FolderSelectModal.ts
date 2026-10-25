import { App, Modal } from 'obsidian';

export class FolderSelectModal extends Modal {
  private folders: string[];
  private onSelect: (path: string) => void;
  private folderContainer: HTMLElement | null = null;

  constructor(app: App, folders: string[], onSelect: (path: string) => void) {
    super(app);
    this.folders = folders;
    this.onSelect = onSelect;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('vs-modal', 'vs-folder-modal');
    contentEl.createEl('h3', { text: '选择输出文件夹' });

    const searchInput = contentEl.createEl('input', {
      cls: 'vs-folder-search',
      attr: { type: 'text', placeholder: '搜索文件夹…' },
    });

    this.folderContainer = contentEl.createDiv({ cls: 'vs-folder-list' });
    this.renderOptions('');

    searchInput.addEventListener('input', () => {
      this.renderOptions(searchInput.value.toLowerCase());
    });
    searchInput.focus();
  }

  private renderOptions(keyword: string) {
    if (!this.folderContainer) return;
    this.folderContainer.empty();

    const current = this.folderContainer.createDiv({ cls: 'vs-folder-option' });
    current.setText('当前文件夹（留空）');
    current.onclick = () => {
      this.onSelect('');
      this.close();
    };

    this.folders
      .filter((path) => !keyword || path.toLowerCase().includes(keyword))
      .slice(0, 200)
      .forEach((path) => {
        const option = this.folderContainer!.createDiv({ cls: 'vs-folder-option' });
        option.setText(path);
        option.onclick = () => {
          this.onSelect(path);
          this.close();
        };
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
