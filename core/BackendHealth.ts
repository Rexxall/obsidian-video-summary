/**
 * Whether the processing backend can take a job, and if not, which part is missing.
 * No Obsidian or Node imports here: the probe, the clock and the timers are passed in.
 */

export type BackendFault =
  | 'not-configured'
  /** Nothing answers at the address: the container or the Docker engine is not running. */
  | 'unreachable'
  /** n8n answers, the webhook is not registered: the workflow is not active. */
  | 'workflow-inactive'
  /** The workflow ran and failed (HTTP 5xx). */
  | 'workflow-error'
  /** The workflow answered 2xx with no body: a node failed or the Respond node is disconnected. */
  | 'empty-response'
  | 'auth'
  | 'timeout'
  | 'http';

export interface BackendDiagnosis {
  ok: boolean;
  fault?: BackendFault;
  /** HTTP status of the webhook answer, when there was one. */
  status?: number;
  /** Raw transport error, for the log only. */
  detail?: string;
  checkedAt: number;
}

/** What one POST to the webhook came back with. */
export interface WebhookAnswer {
  status?: number;
  bodyEmpty?: boolean;
  timedOut?: boolean;
  networkError?: string;
}

/**
 * Turns the webhook answer into a diagnosis. `serviceUp` is whether n8n's own
 * health endpoint answered; it only matters for a 404, where it separates an
 * inactive workflow from a wrong address.
 */
export function diagnoseBackend(
  answer: WebhookAnswer,
  serviceUp: boolean | undefined,
  checkedAt: number,
): BackendDiagnosis {
  if (answer.timedOut) return { ok: false, fault: 'timeout', checkedAt };
  if (answer.status === undefined) {
    return { ok: false, fault: 'unreachable', detail: answer.networkError, checkedAt };
  }
  const { status } = answer;
  if (status === 404) {
    return { ok: false, fault: serviceUp ? 'workflow-inactive' : 'http', status, checkedAt };
  }
  if (status === 401 || status === 403) return { ok: false, fault: 'auth', status, checkedAt };
  if (status >= 500) return { ok: false, fault: 'workflow-error', status, checkedAt };
  if (status < 200 || status >= 300) return { ok: false, fault: 'http', status, checkedAt };
  if (answer.bodyEmpty) return { ok: false, fault: 'empty-response', status, checkedAt };
  return { ok: true, status, checkedAt };
}

export function isLocalEndpoint(url: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(?::|\/|$)/i.test(
    (url || '').trim(),
  );
}

/** Host port of the webhook address; 0 when the address cannot be read. */
export function endpointPort(url: string): number {
  try {
    const parsed = new URL(url.trim());
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

/** Scheme, host and port of the webhook address; '' when it cannot be read. */
export function endpointOrigin(url: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '';
  }
}

export type BackendStatus = 'unknown' | 'checking' | 'online' | 'offline' | 'starting';

export interface BackendSnapshot {
  status: BackendStatus;
  diagnosis?: BackendDiagnosis;
  /** What the start sequence is doing right now; only while status is 'starting'. */
  step?: string;
}

/**
 * The one place that knows whether the backend is up. The status bar, the side
 * panel, the pre-submit check and the running-job watch all read and feed it,
 * so they never disagree and never probe twice at once.
 */
export class BackendMonitor {
  private current: BackendSnapshot = { status: 'unknown' };
  private pending: Promise<BackendDiagnosis> | null = null;
  private listeners = new Set<(snapshot: BackendSnapshot) => void>();
  private starting = false;

  constructor(
    private readonly probe: () => Promise<BackendDiagnosis>,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): BackendSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: BackendSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Probes unless a result younger than `maxAgeMs` exists. Concurrent callers
   * share one request.
   */
  check(maxAgeMs = 0): Promise<BackendDiagnosis> {
    const last = this.current.diagnosis;
    if (maxAgeMs > 0 && last && this.now() - last.checkedAt < maxAgeMs) {
      return Promise.resolve(last);
    }
    if (this.pending) return this.pending;
    if (!this.starting) this.set({ status: 'checking', diagnosis: last });
    this.pending = this.probe()
      .catch(
        (error): BackendDiagnosis => ({
          ok: false,
          fault: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: this.now(),
        }),
      )
      .then((diagnosis) => {
        this.pending = null;
        this.record(diagnosis);
        return diagnosis;
      });
    return this.pending;
  }

  /** A result learned elsewhere, for example a running job that lost its backend. */
  record(diagnosis: BackendDiagnosis) {
    if (this.starting && !diagnosis.ok) {
      this.set({ status: 'starting', diagnosis, step: this.current.step });
      return;
    }
    this.set({ status: diagnosis.ok ? 'online' : 'offline', diagnosis });
  }

  /** Forget the last result, for example after the address changed. */
  reset() {
    this.set({ status: 'unknown' });
  }

  beginStart(step?: string) {
    this.starting = true;
    this.set({ status: 'starting', diagnosis: this.current.diagnosis, step });
  }

  setStep(step: string) {
    if (this.starting) this.set({ status: 'starting', diagnosis: this.current.diagnosis, step });
  }

  endStart() {
    this.starting = false;
    const diagnosis = this.current.diagnosis;
    this.set(
      diagnosis
        ? { status: diagnosis.ok ? 'online' : 'offline', diagnosis }
        : { status: 'unknown' },
    );
  }

  private set(next: BackendSnapshot) {
    this.current = next;
    this.listeners.forEach((listener) => {
      try {
        listener(next);
      } catch (error) {
        console.error('[BackendMonitor] listener failed', error);
      }
    });
  }
}

/**
 * Whether a failed job's message is one a stopped backend produces: no
 * connection, or an answer with nothing in it. Matches the raw transport text
 * and the wording VideoSummaryAPI.formatUserFacingError turns it into.
 */
export function mayMeanBackendGone(message: string): boolean {
  return /无法连接|Cannot reach|空响应|empty response|没有回内容|sent nothing back|ERR_|ECONN|socket hang up|failed to fetch|network/i.test(
    message,
  );
}

/** Thrown into a running job when its backend stops answering. */
export class BackendLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendLostError';
  }
}

export interface BackendWatchOptions {
  /** true while the service answers at all, whatever the HTTP status. */
  ping: () => Promise<boolean>;
  /** Called once, right before the work is failed. */
  onLost: () => void;
  lostMessage: string;
  intervalMs?: number;
  /** A failed ping is asked again after this long before the job is failed. */
  confirmMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Waits for `work`, and meanwhile asks the backend every `intervalMs` whether it
 * is still there. Two failed pings in a row fail the work at once instead of
 * leaving it to the request's own timeout.
 */
export function withBackendWatch<T>(work: Promise<T>, options: BackendWatchOptions): Promise<T> {
  const intervalMs = options.intervalMs ?? 45_000;
  const confirmMs = options.confirmMs ?? 5_000;
  const setTimer = options.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));

  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: unknown;

    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      settle();
    };
    const schedule = (ms: number, confirming: boolean) => {
      timer = setTimer(() => {
        void options
          .ping()
          .catch(() => false)
          .then((alive) => {
            if (done) return;
            if (alive) {
              schedule(intervalMs, false);
            } else if (!confirming) {
              schedule(confirmMs, true);
            } else {
              finish(() => {
                options.onLost();
                reject(new BackendLostError(options.lostMessage));
              });
            }
          });
      }, ms);
    };

    schedule(intervalMs, false);
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}
