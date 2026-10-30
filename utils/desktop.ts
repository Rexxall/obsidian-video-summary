/** Node and Electron modules on desktop; undefined on mobile, where there is no require. */
export function desktopRequire(id: string): unknown {
  const nodeRequire = (window as unknown as { require?: (module: string) => unknown }).require;
  return nodeRequire?.(id);
}

/** The parts of Node's fs and path that the cookies folder check reads. */
export interface DesktopFs {
  existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean; mtimeMs: number; size: number };
  readdirSync(path: string): string[];
}
export interface DesktopPath {
  join(...parts: string[]): string;
}

/** The parts of Node's http and https modules used to read one redirect. */
export interface DesktopHttpResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
}
export interface DesktopHttpRequest {
  setTimeout(timeoutMs: number, onTimeout: () => void): void;
  destroy(): void;
  on(event: 'error', listener: () => void): void;
}
export interface DesktopHttp {
  get(
    url: string,
    options: { headers: Record<string, string> },
    onResponse: (response: DesktopHttpResponse) => void,
  ): DesktopHttpRequest;
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
