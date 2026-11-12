import { desktopRequire } from '../utils/desktop';

/**
 * A small HTTP endpoint on 127.0.0.1 for the browser extension. The extension posts a
 * captured video here instead of opening an obsidian:// link, so Obsidian stays where it
 * is: the OS brings an app forward for every link it opens, never for a local request.
 */

export const DEFAULT_BRIDGE_PORT = 27183;
const CODE_PREFIX = 'vsb1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** What the extension pastes: prefix, port and the secret, in one copyable string. */
export function bridgePairingCode(port: number, token: string): string {
  return `${CODE_PREFIX}.${port}.${token}`;
}

export function parseBridgePairingCode(code: string): { port: number; token: string } | null {
  const match = /^vsb1\.(\d{2,5})\.([A-Za-z0-9]{16,128})$/.exec(code.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? { port, token: match[2] } : null;
}

export function newBridgeToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type BridgeDecision =
  | { status: 200; body: Record<string, unknown> }
  | { status: 202; body: Record<string, unknown>; params: Record<string, string> }
  | { status: 400 | 401 | 403 | 404 | 405 | 413; body: Record<string, unknown> };

export interface BridgeRequest {
  method: string;
  path: string;
  origin?: string;
  token?: string;
  body?: string;
}

/**
 * Decide what a request gets, without any I/O. Web pages can reach 127.0.0.1 too, so a
 * request must carry the secret and must not come from a web origin.
 */
export function decideBridgeRequest(
  request: BridgeRequest,
  expectedToken: string,
  version: string,
): BridgeDecision {
  const origin = request.origin || '';
  if (origin && !/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
    return { status: 403, body: { ok: false, error: 'forbidden origin' } };
  }
  if (!expectedToken || request.token !== expectedToken) {
    return { status: 401, body: { ok: false, error: 'pairing code does not match' } };
  }
  if (request.path === '/video-summary/ping') {
    if (request.method !== 'GET') return { status: 405, body: { ok: false } };
    return { status: 200, body: { ok: true, name: 'video-summary', version } };
  }
  if (request.path !== '/video-summary/capture') {
    return { status: 404, body: { ok: false, error: 'not found' } };
  }
  if (request.method !== 'POST') return { status: 405, body: { ok: false } };
  if ((request.body || '').length > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: 'too large' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body || '{}');
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid JSON' } };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { ok: false, error: 'invalid body' } };
  }
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = String(value);
  }
  if (!(params.url || '').trim()) {
    return { status: 400, body: { ok: false, error: 'missing url' } };
  }
  return { status: 202, body: { ok: true }, params };
}

interface NodeServer {
  listen(port: number, host: string, callback: () => void): void;
  close(): void;
  on(event: 'error', listener: (error: { code?: string; message?: string }) => void): void;
}
interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end' | 'error', listener: () => void): void;
  destroy(): void;
}
interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}
interface NodeHttp {
  createServer(handler: (req: NodeRequest, res: NodeResponse) => void): NodeServer;
}

export type BridgeState = 'off' | 'listening' | 'port-in-use' | 'unavailable';

export class ExtensionBridge {
  private server: NodeServer | null = null;
  state: BridgeState = 'off';

  constructor(
    private readonly options: {
      version: string;
      onCapture: (params: Record<string, string>) => void;
      onStateChange?: (state: BridgeState) => void;
    },
  ) {}

  start(port: number, token: string): void {
    this.stop();
    const http = desktopRequire('http') as NodeHttp | undefined;
    if (!http?.createServer) {
      this.setState('unavailable');
      return;
    }
    const server = http.createServer((req, res) => this.handle(req, res, token));
    server.on('error', (error) => {
      this.setState(error.code === 'EADDRINUSE' ? 'port-in-use' : 'unavailable');
      this.server = null;
    });
    server.listen(port, '127.0.0.1', () => this.setState('listening'));
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.setState('off');
  }

  private setState(state: BridgeState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private handle(req: NodeRequest, res: NodeResponse, token: string): void {
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    // Kept as bytes: a character split between two chunks must be decoded whole.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { ok: false, error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => reply(400, { ok: false }));
    req.on('end', () => {
      const decision = decideBridgeRequest(
        {
          method: req.method || 'GET',
          path: (req.url || '').split('?')[0],
          origin: header('origin'),
          token: header('x-video-summary-token'),
          body: decodeBody(chunks),
        },
        token,
        this.options.version,
      );
      reply(decision.status, decision.body);
      if (decision.status === 202) this.options.onCapture(decision.params);
    });
  }
}

function decodeBody(chunks: Uint8Array[]): string {
  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(all);
}
