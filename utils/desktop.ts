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

interface ChildProcessModule {
  execFile(
    file: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
    callback: (
      error: (Error & { code?: number | string }) | null,
      stdout: string,
      stderr: string,
    ) => void,
  ): unknown;
}

/** Folders where Docker's command-line tool lives when Obsidian was started from the Dock. */
function dockerSearchPath(): string {
  const env = (desktopRequire('process') as { env?: Record<string, string | undefined> }).env ?? {};
  const home = env.HOME || env.USERPROFILE || '';
  const separator = env.USERPROFILE && !env.HOME ? ';' : ':';
  const extra = env.HOME
    ? [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        `${home}/.orbstack/bin`,
        `${home}/.docker/bin`,
        '/Applications/OrbStack.app/Contents/MacOS/xbin',
        '/Applications/Docker.app/Contents/Resources/bin',
      ]
    : ['C:\\Program Files\\Docker\\Docker\\resources\\bin'];
  return [env.PATH || '', ...extra].filter(Boolean).join(separator);
}

/**
 * Runs one program with an argument list and no shell. Resolves with the exit
 * code and output; never rejects.
 */
export function runProgram(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; notFound?: boolean }> {
  const childProcess = desktopRequire('child_process') as ChildProcessModule | undefined;
  if (!childProcess?.execFile) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', notFound: true });
  }
  const env = (desktopRequire('process') as { env?: Record<string, string | undefined> }).env ?? {};
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 10_000,
          env: { ...env, PATH: dockerSearchPath() },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          resolve({
            code: typeof error.code === 'number' ? error.code : null,
            stdout: String(stdout || ''),
            stderr: String(stderr || error.message || ''),
            notFound: error.code === 'ENOENT',
          });
        },
      );
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error), notFound: true });
    }
  });
}

/** The Docker engine app installed on this computer, or null. macOS and Windows only. */
export function dockerEngineApp(): { name: string; path: string } | null {
  const fs = desktopRequire('fs') as DesktopFs | undefined;
  if (!fs) return null;
  const candidates = [
    { name: 'OrbStack', path: '/Applications/OrbStack.app' },
    { name: 'Docker Desktop', path: '/Applications/Docker.app' },
    { name: 'Docker Desktop', path: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' },
  ];
  return candidates.find((candidate) => fs.existsSync(candidate.path)) ?? null;
}

/** Opens the Docker engine app without bringing it to the front. */
export async function openDockerEngine(): Promise<boolean> {
  const app = dockerEngineApp();
  if (!app) return false;
  if (app.path.endsWith('.app')) {
    return (await runProgram('/usr/bin/open', ['-g', app.path], { timeoutMs: 8000 })).code === 0;
  }
  const electron = desktopRequire('electron') as
    | { shell?: { openPath?: (path: string) => Promise<string> } }
    | undefined;
  if (!electron?.shell?.openPath) return false;
  return (await electron.shell.openPath(app.path)) === '';
}

export function pathExists(path: string): boolean {
  const fs = desktopRequire('fs') as DesktopFs | undefined;
  try {
    return !!fs?.existsSync(path);
  } catch {
    return false;
  }
}

export function joinPath(...parts: string[]): string {
  const path = desktopRequire('path') as DesktopPath | undefined;
  return path ? path.join(...parts) : parts.join('/');
}

/** Asks for a folder with the system dialog. null when cancelled or unavailable. */
export async function pickFolderInSystem(title: string): Promise<string | null> {
  interface Dialog {
    showOpenDialog(options: {
      title: string;
      properties: string[];
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  }
  const electron = desktopRequire('electron') as { remote?: { dialog?: Dialog } } | undefined;
  let dialog = electron?.remote?.dialog;
  if (!dialog) {
    try {
      dialog = (desktopRequire('@electron/remote') as { dialog?: Dialog } | undefined)?.dialog;
    } catch {
      dialog = undefined;
    }
  }
  if (!dialog) return null;
  const result = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}
