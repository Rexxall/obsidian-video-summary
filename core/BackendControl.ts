import { Notice, Platform } from 'obsidian';
import type VideoSummaryPlugin from '../main';
import { BackendDiagnosis, BackendMonitor, endpointPort, isLocalEndpoint } from './BackendHealth';
import { LaunchResult, LaunchStep, launchBackend } from './BackendLauncher';
import {
  dockerEngineApp,
  joinPath,
  openDockerEngine,
  pathExists,
  pickFolderInSystem,
  runProgram,
} from '../utils/desktop';
import { tr } from '../utils/i18n';
import { fire } from '../utils/fire';
import { faultNextStep, faultReason, launchFailureText } from '../views/backendText';

const FRESH_MS = 60_000;
const INTERVAL_MS = 5 * 60_000;

/**
 * Plugin-side glue around BackendMonitor: when to check, holding the queue
 * while the backend is away, and the Start backend action.
 */
export class BackendControl {
  readonly monitor: BackendMonitor;
  /** Why the last Start backend attempt failed; cleared when the backend is up. */
  lastStartFailure = '';
  private launching: Promise<boolean> | null = null;
  private notice: Notice | null = null;

  constructor(private readonly plugin: VideoSummaryPlugin) {
    this.monitor = new BackendMonitor(() =>
      this.plugin.hasBackend()
        ? this.plugin.api.diagnose()
        : Promise.resolve({ ok: false, fault: 'not-configured' as const, checkedAt: Date.now() }),
    );
    this.monitor.subscribe((snapshot) => {
      if (snapshot.status === 'online') {
        this.lastStartFailure = '';
        this.notice?.hide();
        this.notice = null;
        // An answer just before a restart comes from the process about to stop: keep the queue held.
        if (!this.plugin.installer?.restarting) this.plugin.jobs.setHeld(false);
      } else if (snapshot.status === 'offline' && this.preflightOn()) {
        this.plugin.jobs.setHeld(true);
      }
    });
  }

  /** Checks once the layout is ready, when the window gets focus, and at most every five minutes. */
  attach() {
    const { plugin } = this;
    plugin.app.workspace.onLayoutReady(() => void this.monitor.check());
    plugin.registerDomEvent(window, 'focus', () => {
      void this.monitor.check(this.monitor.snapshot().status === 'online' ? FRESH_MS : 5_000);
    });
    plugin.registerInterval(
      window.setInterval(() => {
        if (activeDocument.visibilityState === 'visible') void this.monitor.check(FRESH_MS);
      }, INTERVAL_MS),
    );
  }

  endpoint(): string {
    return (this.plugin.activeEndpoint() || '').trim();
  }

  /** Start backend only makes sense for a backend on this computer. */
  canStart(): boolean {
    return Platform.isDesktopApp && isLocalEndpoint(this.endpoint());
  }

  /** The address or the token changed: forget what was known and look again. */
  endpointChanged() {
    this.monitor.reset();
    void this.monitor.check();
  }

  /**
   * Before a job is queued. true: the backend is up. false: it is not, the
   * queue is held and the person was told; the job is still queued and runs
   * once the backend answers.
   */
  async readyOrHold(): Promise<boolean> {
    if (!this.preflightOn()) return true;
    const diagnosis = await this.freshDiagnosis();
    if (diagnosis.ok) return true;
    this.plugin.jobs.setHeld(true);
    const snapshot = this.monitor.snapshot();
    if (snapshot.status === 'starting') {
      // The backend is being started or is restarting with new settings: no button, it comes back by itself.
      this.notice?.hide();
      this.notice = new Notice(
        tr(
          `任务在等后端：${snapshot.step || '正在启动'}。后端应答后自动开始。`,
          `The job is waiting: ${snapshot.step || 'the backend is starting'}. It starts by itself once the backend answers.`,
        ),
        8000,
      );
      return false;
    }
    this.tellOffline(diagnosis, true);
    return false;
  }

  /** For the older commands that do not use the queue: false means stop, and says why. */
  async ensureReady(): Promise<boolean> {
    if (!this.preflightOn()) return true;
    const diagnosis = await this.freshDiagnosis();
    if (diagnosis.ok) return true;
    this.tellOffline(diagnosis, false);
    return false;
  }

  /** A running job found the backend gone. */
  lostWhileRunning() {
    void this.monitor.check();
  }

  /**
   * A job just failed with an empty answer or a connection error. true when the
   * backend is in fact gone. A backend that is shutting down still answers for a
   * few seconds, so it is asked up to three times over eight seconds.
   */
  async goneAfterFailure(): Promise<boolean> {
    for (const wait of [0, 3000, 5000]) {
      if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
      const diagnosis = await this.monitor.check();
      if (!diagnosis.ok && (diagnosis.fault === 'unreachable' || diagnosis.fault === 'timeout')) {
        return true;
      }
    }
    return false;
  }

  /** Opens Docker, starts the backend container and waits for the webhook. true when it answers. */
  start(): Promise<boolean> {
    if (this.launching) return this.launching;
    this.launching = this.runStart().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private preflightOn(): boolean {
    return this.plugin.settings.preflightCheckEnabled !== false;
  }

  private freshDiagnosis(): Promise<BackendDiagnosis> {
    // An "offline" answer is never reused: the backend may have come up since.
    return this.monitor.check(this.monitor.snapshot().status === 'online' ? FRESH_MS : 0);
  }

  private backendDir(): string {
    const { settings } = this.plugin;
    const explicit = (settings.backendDirPath || '').trim();
    if (explicit) return explicit;
    const cookies = (settings.cookiesDirPath || '').trim().replace(/[\\/]+$/, '');
    if (!cookies) return '';
    const parent = cookies.replace(/[\\/][^\\/]+$/, '');
    return parent && pathExists(joinPath(parent, 'compose.yaml')) ? parent : '';
  }

  private stepText(step: LaunchStep): string {
    if (step === 'engine') {
      const app = dockerEngineApp();
      return app
        ? tr(`正在打开 ${app.name}`, `Opening ${app.name}`)
        : tr('正在等 Docker', 'Waiting for Docker');
    }
    if (step === 'container') return tr('正在启动容器', 'Starting the container');
    return tr('等后端应答', 'Waiting for the backend to answer');
  }

  private async launchOnce(backendDir: string): Promise<LaunchResult> {
    return launchBackend({
      run: runProgram,
      probe: async () => {
        const diagnosis = await this.plugin.api.diagnose(3000);
        this.monitor.record(diagnosis);
        return diagnosis;
      },
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      now: Date.now,
      openEngine: openDockerEngine,
      port: endpointPort(this.endpoint()),
      backendDir: backendDir || undefined,
      hasEnvFile: backendDir ? pathExists(joinPath(backendDir, '.env')) : false,
      onStep: (step) => this.monitor.setStep(this.stepText(step)),
    });
  }

  private async runStart(): Promise<boolean> {
    if (!this.canStart()) return false;
    this.notice?.hide();
    this.notice = null;
    this.lastStartFailure = '';
    const waiting = this.plugin.jobs.countByState('queued');
    this.monitor.beginStart(this.stepText('engine'));
    try {
      let result = await this.launchOnce(this.backendDir());
      if (!result.ok && result.stage === 'no-folder') {
        const picked = await pickFolderInSystem(
          tr(
            '选择后端文件夹（里面有 compose.yaml）',
            'Choose the backend folder (the one with compose.yaml)',
          ),
        );
        if (picked && pathExists(joinPath(picked, 'compose.yaml'))) {
          await this.rememberBackendDir(picked);
          result = await this.launchOnce(picked);
        } else if (picked) {
          new Notice(tr('这个文件夹里没有 compose.yaml', 'That folder has no compose.yaml'), 6000);
        }
      }
      if (result.backendDir) await this.rememberBackendDir(result.backendDir);
      if (result.ok) {
        new Notice(
          waiting > 0
            ? tr(
                `后端已启动，${waiting} 个等待的任务开始处理`,
                `Backend started; ${waiting} waiting ${waiting === 1 ? 'job is' : 'jobs are'} now running`,
              )
            : tr('后端已启动', 'Backend started'),
          4000,
        );
        return true;
      }
      this.lastStartFailure = launchFailureText(
        result,
        this.monitor.snapshot().diagnosis,
        this.endpoint(),
      );
      new Notice(this.lastStartFailure, 12_000);
      return false;
    } finally {
      this.monitor.endStart();
    }
  }

  private async rememberBackendDir(dir: string) {
    // A folder the person set themselves is never replaced.
    if ((this.plugin.settings.backendDirPath || '').trim()) return;
    this.plugin.settings.backendDirPath = dir;
    await this.plugin.saveSettings();
  }

  /** One notice at a time: what is wrong, the next step, and Start backend when that can help. */
  private tellOffline(diagnosis: BackendDiagnosis, held: boolean) {
    this.notice?.hide();
    const endpoint = this.endpoint();
    const startable = this.canStart() && diagnosis.fault === 'unreachable';
    const fragment = createFragment();
    const box = fragment.createDiv({ cls: 'vs-backend-notice' });
    const reason = faultReason(diagnosis, endpoint);
    box.createDiv({
      cls: 'vs-backend-notice-title',
      text: held
        ? tr(`任务在等后端：${reason}`, `The job is waiting: ${reason}`)
        : tr(`没有发出：${reason}`, `Not sent: ${reason}`),
    });
    box.createDiv({
      cls: 'vs-backend-notice-step',
      text: startable
        ? tr(
            '“启动后端”会打开 Docker 并启动后端容器。',
            'Start backend opens Docker and starts the backend container.',
          )
        : faultNextStep(diagnosis, endpoint, false),
    });
    if (startable) {
      const button = box.createEl('button', {
        cls: 'mod-cta',
        text: tr('启动后端', 'Start backend'),
        attr: { type: 'button' },
      });
      button.addEventListener(
        'click',
        fire(async (event) => {
          event.stopPropagation();
          await this.start();
        }),
      );
    }
    this.notice = new Notice(fragment, startable ? 20_000 : 10_000);
  }
}
