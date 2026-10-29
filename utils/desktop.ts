/** Node and Electron modules on desktop; undefined on mobile, where there is no require. */
export function desktopRequire(id: string): unknown {
  const nodeRequire = (window as unknown as { require?: (module: string) => unknown }).require;
  return nodeRequire?.(id);
}

/** Opens a folder in the system file manager. Returns false where that is not possible. */
export function openPathInSystem(path: string): boolean {
  const electron = desktopRequire('electron') as
    | { shell?: { openPath?: (path: string) => Promise<string> } }
    | undefined;
  const openPath = electron?.shell?.openPath;
  if (!openPath) return false;
  void openPath(path);
  return true;
}
