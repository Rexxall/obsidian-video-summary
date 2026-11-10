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
  ): { stdin?: { end(text: string): void; on(event: 'error', listener: () => void): void } };
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
  options: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; notFound?: boolean }> {
  const childProcess = desktopRequire('child_process') as ChildProcessModule | undefined;
  if (!childProcess?.execFile) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', notFound: true });
  }
  const env = (desktopRequire('process') as { env?: Record<string, string | undefined> }).env ?? {};
  return new Promise((resolve) => {
    try {
      const child = childProcess.execFile(
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
      if (options.input !== undefined && child.stdin) {
        // The program may exit before it reads everything; that is reported through its exit code.
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.input);
      }
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

interface DesktopFsWrite {
  mkdirSync(path: string, options: { recursive: boolean }): unknown;
  writeFileSync(path: string, text: string, options: { mode: number }): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  chmodSync(path: string, mode: number): void;
}

/** Text of a file outside the vault, or null when it does not exist or cannot be read. */
export function readTextOutsideVault(path: string): string | null {
  const fs = desktopRequire('fs') as DesktopFsWrite | undefined;
  try {
    return fs ? fs.readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Writes a text file outside the vault, creating its folder. Throws when that is not possible. */
export function writeTextOutsideVault(dir: string, name: string, text: string, mode = 0o644) {
  const fs = desktopRequire('fs') as DesktopFsWrite | undefined;
  if (!fs) throw new Error('No file access on this device');
  fs.mkdirSync(dir, { recursive: true });
  const target = joinPath(dir, name);
  fs.writeFileSync(target, text, { mode });
  fs.chmodSync(target, mode);
}

export function makeFolderOutsideVault(path: string) {
  const fs = desktopRequire('fs') as DesktopFsWrite | undefined;
  fs?.mkdirSync(path, { recursive: true });
}

export function homeFolder(): string {
  const os = desktopRequire('os') as { homedir?: () => string } | undefined;
  return os?.homedir?.() ?? '';
}

/** Opens a file with the system's default app, for example a .command file in Terminal. */
export async function openFileInSystem(path: string): Promise<boolean> {
  const electron = desktopRequire('electron') as
    | { shell?: { openPath?: (path: string) => Promise<string> } }
    | undefined;
  if (!electron?.shell?.openPath) return false;
  return (await electron.shell.openPath(path)) === '';
}

/** true when nothing on this computer listens on the port. */
export function portIsFree(port: number): Promise<boolean> {
  interface NetServer {
    once(event: 'error' | 'listening', listener: () => void): NetServer;
    listen(port: number, host: string): void;
    close(callback?: () => void): void;
  }
  const net = desktopRequire('net') as { createServer?: () => NetServer } | undefined;
  if (!net?.createServer) return Promise.resolve(true);
  return new Promise((resolve) => {
    const server = net.createServer!();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}
