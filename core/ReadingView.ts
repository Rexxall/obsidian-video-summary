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
    // file-open fires while the leaf is still taking its new state; switch once it has settled.
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    // The side panel may hold focus when it opens a note, so look at every tab showing it.
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== file.path) continue;
      const alreadyOpenedHere = this.seen.get(leaf) === file.path;
      this.seen.set(leaf, file.path);
      if (!wantsReadingView(this.enabled(), frontmatter, alreadyOpenedHere)) continue;
      if (view.getMode() === 'preview') continue;
      await view.setState({ ...view.getState(), mode: 'preview' }, { history: false });
    }
  }
}
