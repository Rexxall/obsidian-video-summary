import { Notice, Platform } from 'obsidian';
import type VideoSummaryPlugin from '../main';
import { setupTrialTranscript } from '../constants';
import { endpointPort } from './BackendHealth';
import {
  type SetupStep,
  interpretSetupCheck,
  reportedChatModel,
  withSettingsFixes,
} from './BackendSetup';
import {
  BACKEND_DEFAULT_PORT,
  type BackendFacts,
  INSTALL_SCRIPT_NAME,
  applyModelConfig,
  backendFacts,
  backendOutdated,
  connectionFor,
  installScript,
  managedCompose,
  planEnv,
  requiredImage,
} from './ManagedBackend';
import { backendModelConfig, modelConfigFingerprint } from './ModelSettings';
import {
  homeFolder,
  joinPath,
  makeFolderOutsideVault,
  openFileInSystem,
  pathExists,
  portIsFree,
  readTextOutsideVault,
  runProgram,
  writeTextOutsideVault,
} from '../utils/desktop';
import { getLanguage } from 'obsidian';
import { tr } from '../utils/i18n';

export type InstallPhase =
  | 'idle'
  /** Terminal is open; waiting for the person to press Return and for the download. */
  | 'terminal'
  | 'configure'
  | 'check'
  | 'trial'
  | 'done'
  | 'failed';

export interface InstallProgress {
  phase: InstallPhase;
  /** One line saying what is happening now, or why it stopped. */
  message: string;
  /** Result of the full check, once it has run. */
  steps?: SetupStep[];
  /** Seconds waited in the current phase, for the terminal step. */
  startedAt?: number;
}

const ONLINE_WAIT_MS = 30 * 60_000;
const RESTART_WAIT_MS = 4 * 60_000;
const APPLY_DEBOUNCE_MS = 1500;

/**
 * Sets up, adopts and maintains the packaged backend from the settings page.
 * State lives here, not in the page, so closing settings does not lose it.
 */
export class BackendInstaller {
  private current: InstallProgress = { phase: 'idle', message: '' };
  private listeners = new Set<() => void>();
  private running = false;
  private cancelled = false;
  private applyTimer: number | null = null;
  private applying: Promise<boolean> | null = null;
  private lastFacts: BackendFacts | null = null;
  /** true from handing settings over until the container has restarted: an answer in between is the old process. */
  restarting = false;

  constructor(private readonly plugin: VideoSummaryPlugin) {}

  progress(): InstallProgress {
    return this.current;
  }

  /** What Docker said last time it was asked; null before the first answer. */
  facts(): BackendFacts | null {
    return this.lastFacts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Only a backend on this computer, on a desktop that can run docker, can be set up from here. */
  supported(): boolean {
    return Platform.isDesktopApp && (Platform.isMacOS || Platform.isLinux);
  }

  /** Where the backend folder is, or where it will be written. */
  backendDir(): string {
    return (
      (this.plugin.settings.backendDirPath || '').trim() ||
      joinPath(homeFolder(), 'video-summary-backend')
    );
  }

  async refreshFacts(): Promise<BackendFacts> {
    const endpoint = this.plugin.backend.endpoint();
    const port =
      this.plugin.hasBackend() && this.plugin.backend.canStart() ? endpointPort(endpoint) : 0;
    const facts = await backendFacts(runProgram, port);
    this.lastFacts = facts;
    // A backend made with the start script is adopted as it is: remember its folder, keep its token.
    const dir = facts.bundled ? facts.container?.workingDir : undefined;
    if (dir && !(this.plugin.settings.backendDirPath || '').trim()) {
      this.plugin.settings.backendDirPath = dir;
      await this.plugin.saveSettings();
    }
    this.emit();
    return facts;
  }

  /** true when the running backend was made from another image than this plugin version expects. */
  outdated(): boolean {
    return (
      !!this.lastFacts &&
      backendOutdated(
        this.lastFacts,
        this.plugin.manifest.version,
        this.plugin.settings.backendImage,
      )
    );
  }

  /**
   * Install and start: writes the backend folder, points the plugin at it, opens
   * Terminal for the download, then waits and finishes the setup by itself.
   */
  async install(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    try {
      const { token, port } = await this.writeBackendFolder(false);
      await this.plugin.applyConnection(connectionFor(port, token), true);
      await this.openTerminal();
      await this.finishAfterTerminal(false);
    } catch (error) {
      this.set({
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** Update: the same Terminal step with the new image, then the check again. */
  async update(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    try {
      await this.writeBackendFolder(true);
      await this.openTerminal();
      await this.finishAfterTerminal(true);
    } catch (error) {
      this.set({
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /** Opens the Terminal window again, for when it was closed before the download. */
  async reopenTerminal(): Promise<void> {
    await this.openTerminal();
  }

  /** Stops waiting. Nothing already installed is removed. */
  cancel() {
    this.cancelled = true;
    if (!this.running) this.set({ phase: 'idle', message: '' });
  }

  /** Runs the full check and shows its steps; used by the Check button. */
  async check(): Promise<SetupStep[]> {
    const steps = await this.fullCheck();
    this.set({ phase: 'idle', message: '', steps });
    return steps;
  }

  async stop(): Promise<boolean> {
    const facts = await this.refreshFacts();
    if (!facts.container?.running) return true;
    const stopped = await runProgram('docker', ['stop', facts.container.id], { timeoutMs: 40_000 });
    await this.plugin.backend.monitor.check();
    await this.refreshFacts();
    return stopped.code === 0;
  }

  /** Whether Docker starts the backend container by itself whenever Docker starts. */
  autoStart(): boolean {
    const policy = this.lastFacts?.container?.restart;
    return policy === 'unless-stopped' || policy === 'always';
  }

  async setAutoStart(on: boolean): Promise<boolean> {
    const container = this.lastFacts?.container;
    if (!container) return false;
    const result = await runProgram(
      'docker',
      ['update', '--restart', on ? 'unless-stopped' : 'no', container.id],
      { timeoutMs: 15_000 },
    );
    await this.refreshFacts();
    return result.code === 0;
  }

  /**
   * The model or a key changed in settings: hand it to the backend shortly after
   * the last change, so typing a model name does not restart the backend per letter.
   */
  scheduleApply(delayMs = APPLY_DEBOUNCE_MS) {
    if (this.applyTimer !== null) window.clearTimeout(this.applyTimer);
    this.applyTimer = window.setTimeout(() => {
      this.applyTimer = null;
      void this.applyIfChanged(true);
    }, delayMs);
  }

  private async waitForRunningJobs() {
    while (this.plugin.jobs.countByState('running') > 0 && !this.cancelled) await sleep(2000);
  }

  dispose() {
    if (this.applyTimer !== null) window.clearTimeout(this.applyTimer);
    this.applyTimer = null;
    this.cancelled = true;
  }

  /**
   * Gives the backend the model and keys from settings when they differ from
   * what it was last given. true when the backend is current afterwards.
   */
  applyIfChanged(announce: boolean): Promise<boolean> {
    if (this.applying) return this.applying;
    this.applying = this.runApply(announce).finally(() => {
      this.applying = null;
    });
    return this.applying;
  }

  private async runApply(announce: boolean): Promise<boolean> {
    const { settings } = this.plugin;
    const config = backendModelConfig(this.plugin.app, settings);
    if (!config.chat.key && !config.speech.key) return true;
    const fingerprint = await modelConfigFingerprint(config);
    if (fingerprint === settings.backendAppliedConfig) return true;

    // Asked afresh each time: the container may have been stopped or started since the page was drawn.
    const facts = await this.refreshFacts();
    if (!facts.bundled || !facts.container?.running) return false;

    // The restart would cut off a job in the middle: wait for running jobs, then go.
    if (this.plugin.jobs.countByState('running') > 0) {
      if (!this.running) {
        this.scheduleApply(15_000);
        return false;
      }
      await this.waitForRunningJobs();
    }

    const { monitor } = this.plugin.backend;
    monitor.beginStart(tr('正在把模型和密钥交给后端', 'Giving the backend the model and keys'));
    // Jobs sent during the restart wait in the queue; it is released when the backend answers again.
    this.plugin.jobs.setHeld(true);
    try {
      this.restarting = true;
      const result = await applyModelConfig(runProgram, facts.container.id, config).finally(() => {
        this.restarting = false;
      });
      if (!result.ok) {
        const message =
          result.reason === 'old-backend'
            ? tr(
                '这个后端是旧版，还不能从设置里接收模型和密钥。先更新后端。',
                'This backend is an older version and cannot take the model and keys from settings yet. Update the backend first.',
              )
            : result.reason === 'rejected'
              ? tr(
                  `后端不接受这组设置：${result.detail || ''}`,
                  `The backend did not accept these settings: ${result.detail || ''}`,
                )
              : tr(
                  `没能把设置交给后端：${result.detail || '未知原因'}`,
                  `Could not hand the settings to the backend: ${result.detail || 'unknown reason'}`,
                );
        if (announce) new Notice(message, 10_000);
        throw new Error(message);
      }
      monitor.setStep(
        tr('后端正在带着新设置重启', 'The backend is restarting with the new settings'),
      );
      const online = await this.waitOnline(RESTART_WAIT_MS);
      if (!online) {
        const message = tr(
          '后端重启后没有应答。打开后端体检看卡在哪一步。',
          'The backend did not answer after restarting. Open the backend check-up to see where it stopped.',
        );
        if (announce) new Notice(message, 10_000);
        throw new Error(message);
      }
      settings.backendAppliedConfig = fingerprint;
      await this.plugin.saveSettings();
      if (announce)
        new Notice(
          tr('后端已换上新的模型和密钥', 'The backend now uses the new model and keys'),
          4000,
        );
      return true;
    } catch (error) {
      if (this.running) throw error;
      return false;
    } finally {
      monitor.endStart();
      // Online again releases the queue; still offline keeps it held with the usual Start backend path.
      const after = await monitor.check();
      if (after.ok) this.plugin.jobs.setHeld(false);
    }
  }

  /** Writes compose.yaml, .env, the two data folders and the Terminal script. */
  private async writeBackendFolder(update: boolean): Promise<{ token: string; port: number }> {
    const dir = this.backendDir();
    const { settings, manifest } = this.plugin;
    const existingEnv = readTextOutsideVault(joinPath(dir, '.env'));
    let port = BACKEND_DEFAULT_PORT;
    // Only a folder without a port of its own gets one picked: the first free one from 5678 up.
    if (!/^\s*VS_PORT=\d+/m.test(existingEnv ?? '')) {
      while (port < BACKEND_DEFAULT_PORT + 40 && !(await portIsFree(port))) port += 1;
    }
    const plan = planEnv(existingEnv, {
      port,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      image: (settings.backendImage || '').trim() || undefined,
    });
    try {
      makeFolderOutsideVault(joinPath(dir, 'uploads'));
      makeFolderOutsideVault(joinPath(dir, 'cookies'));
      // A folder from the start script keeps its own compose.yaml (it can build the image locally).
      if (!pathExists(joinPath(dir, 'Dockerfile'))) {
        writeTextOutsideVault(dir, 'compose.yaml', managedCompose(manifest.version));
      }
      writeTextOutsideVault(dir, '.env', plan.text, 0o600);
      writeTextOutsideVault(
        dir,
        INSTALL_SCRIPT_NAME,
        installScript({ chinese: getLanguage().startsWith('zh'), update }),
        0o755,
      );
    } catch (error) {
      throw new Error(
        tr(
          `写不了后端文件夹 ${dir}：${error instanceof Error ? error.message : String(error)}`,
          `Cannot write the backend folder ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    if ((settings.backendDirPath || '').trim() !== dir) {
      settings.backendDirPath = dir;
      await this.plugin.saveSettings();
    }
    return { token: plan.token, port: plan.port };
  }

  private async openTerminal() {
    const script = joinPath(this.backendDir(), INSTALL_SCRIPT_NAME);
    const opened = Platform.isMacOS
      ? (await runProgram('/usr/bin/open', ['-a', 'Terminal', script], { timeoutMs: 8000 }))
          .code === 0
      : await openFileInSystem(script);
    if (!opened) {
      throw new Error(
        tr(
          `打不开终端。请自己在终端里运行：bash "${script}"`,
          `Could not open a terminal. Run this in a terminal yourself: bash "${script}"`,
        ),
      );
    }
    this.set({
      phase: 'terminal',
      message: tr(
        '在弹出的终端窗口里按回车，开始下载后端（约 550 MB）。下载完这里会自己继续。',
        'Press Return in the Terminal window that opened to download the backend (about 550 MB). This page carries on by itself afterwards.',
      ),
      startedAt: Date.now(),
    });
  }

  /** After the Terminal step: wait for the backend, give it the keys, check, trial run. */
  private async finishAfterTerminal(update: boolean) {
    const expected = requiredImage(this.plugin.manifest.version, this.plugin.settings.backendImage);
    const deadline = Date.now() + ONLINE_WAIT_MS;
    let ready = false;
    while (Date.now() < deadline && !this.cancelled) {
      await sleep(2500);
      const diagnosis = await this.plugin.backend.monitor.check();
      if (!diagnosis.ok) continue;
      if (!update) {
        ready = true;
        break;
      }
      // An update is done once the container runs the new image, not merely when the old one answers.
      const facts = await this.refreshFacts();
      if (
        facts.container?.image === expected ||
        !backendOutdated(facts, this.plugin.manifest.version, this.plugin.settings.backendImage)
      ) {
        ready = true;
        break;
      }
    }
    if (this.cancelled) {
      this.set({ phase: 'idle', message: '' });
      return;
    }
    if (!ready) {
      this.set({
        phase: 'failed',
        message: tr(
          '等了 30 分钟后端还没上线。看终端窗口里的提示，处理后再点一次。',
          'The backend did not come up within 30 minutes. See what the Terminal window says, then try again.',
        ),
      });
      return;
    }

    await this.refreshFacts();
    this.set({
      phase: 'configure',
      message: tr(
        '后端已上线，正在把模型和密钥交给它…',
        'The backend is up; giving it the model and keys…',
      ),
    });
    await this.applyIfChanged(false);

    this.set({
      phase: 'check',
      message: tr(
        '正在做完整检查，会调用一次模型和语音转写，约 10–30 秒…',
        'Running the full check; it calls the model and speech-to-text once, about 10–30 seconds…',
      ),
    });
    const steps = await this.fullCheck();
    const blocking = steps.find(
      (item) =>
        item.state === 'missing' &&
        item.id !== 'speech' &&
        item.id !== 'vision' &&
        item.id !== 'bilibili',
    );
    if (blocking) {
      this.set({
        phase: 'failed',
        message: tr(`检查没通过：${blocking.label}`, `The check did not pass: ${blocking.label}`),
        steps,
      });
      return;
    }

    this.set({
      phase: 'trial',
      message: tr('正在用一段短文稿试跑一次总结…', 'Trying one summary on a short sample text…'),
      steps,
    });
    const trial = await this.plugin.api.trialRun(
      setupTrialTranscript(),
      this.plugin.settings.defaultLanguage,
    );
    if (!trial.ok) {
      this.set({ phase: 'failed', message: trial.message, steps });
      return;
    }
    this.plugin.settings.setupGuideDismissed = true;
    await this.plugin.saveSettings();
    this.set({
      phase: 'done',
      message: tr(
        `装好了，试跑用时 ${(trial.durationMs / 1000).toFixed(1)} 秒。`,
        `All set; the trial took ${(trial.durationMs / 1000).toFixed(1)} s.`,
      ),
      steps,
    });
  }

  private async fullCheck(): Promise<SetupStep[]> {
    const outcome = await this.plugin.api.checkBackend(true);
    const model = reportedChatModel(outcome.report);
    if (model && model !== this.plugin.settings.aiModel) {
      this.plugin.settings.aiModel = model;
      this.plugin.api.setAiModel(model);
      await this.plugin.saveSettings();
    }
    const steps = interpretSetupCheck({ ...outcome, deep: true });
    return this.lastFacts?.bundled ? withSettingsFixes(steps) : steps;
  }

  private async waitOnline(limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    // docker restart returns before n8n listens again; the first answers can still be the old process.
    await sleep(3000);
    while (Date.now() < deadline) {
      const diagnosis = await this.plugin.api.diagnose(3000);
      this.plugin.backend.monitor.record(diagnosis);
      if (diagnosis.ok) return true;
      await sleep(2500);
    }
    return false;
  }

  private set(next: InstallProgress) {
    this.current = next;
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('[BackendInstaller] listener failed', error);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
