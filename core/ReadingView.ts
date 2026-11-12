import { TFile, WorkspaceLeaf, type App, type OpenViewState } from 'obsidian';

import { wantsReadingView } from './ReadingViewRule';

type OpenFile = (file: TFile, openState?: OpenViewState) => Promise<void>;

/**
 * Finished video notes open in reading view, wherever they live and however they are opened
 * (file list, links, search, the side panel). The mode is put into the open request itself, so
 * the note is drawn once, in reading view, instead of in the editor first and again after a
 * switch. A note already showing in a tab is left in whatever mode the reader chose.
 */
export function installReadingView(
  app: App,
  enabled: () => boolean,
  libraryStatus: (path: string) => string | undefined,
): () => void {
  const proto = WorkspaceLeaf.prototype as unknown as { openFile: OpenFile };
  const original = proto.openFile;
  proto.openFile = function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) {
    try {
      const showing = (this.view as { file?: TFile | null } | undefined)?.file?.path === file?.path;
      const askedMode = (openState?.state as { mode?: string } | undefined)?.mode;
      if (file instanceof TFile && file.extension === 'md' && !showing && !askedMode) {
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
        const finished =
          libraryStatus(file.path) === 'success' || wantsReadingView(true, frontmatter, false);
        if (enabled() && finished) {
          openState = { ...openState, state: { ...openState?.state, mode: 'preview' } };
        }
      }
    } catch {
      // Never let this get in the way of opening a note.
    }
    return original.call(this, file, openState);
  };
  return () => {
    if (proto.openFile !== original) proto.openFile = original;
  };
}
