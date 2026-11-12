import { MarkdownView, TFile, type App, type WorkspaceLeaf } from 'obsidian';

import { wantsReadingView } from './ReadingViewRule';

export class ReadingViewOpener {
  private readonly seen = new WeakMap<WorkspaceLeaf, string>();

  constructor(
    private readonly app: App,
    private readonly enabled: () => boolean,
  ) {}

  async onFileOpen(file: TFile | null) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;
    const leaf = view.leaf;
    const alreadyOpenedHere = this.seen.get(leaf) === file.path;
    this.seen.set(leaf, file.path);
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!wantsReadingView(this.enabled(), frontmatter, alreadyOpenedHere)) return;
    if (view.getMode() === 'preview') return;
    await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
  }
}
