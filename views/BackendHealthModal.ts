import { App, Modal } from 'obsidian';
import type VideoSummaryPlugin from '../main';
import { endpointOrigin, endpointPort } from '../core/BackendHealth';
import { locateContainer } from '../core/BackendLauncher';
import { dockerEngineApp, runProgram } from '../utils/desktop';
import { fire } from '../utils/fire';
import { tr } from '../utils/i18n';
import { safeExternalHttpUrl } from '../utils/SafeExternalUrl';
import { faultNextStep, faultReason, statusClass, statusWord } from './backendText';

interface DockerFacts {
  engine: 'missing' | 'stopped' | 'running';
  container?: { name: string; running: boolean };
}

/** The check-up behind the status bar dot: each layer of the backend, and the one next step. */
export class BackendHealthModal extends Modal {
  private static opened = new Set<BackendHealthModal>();
  private off: (() => void) | null = null;
  private docker: DockerFacts | null = null;
  private dockerPending = false;

  constructor(
    app: App,
    private readonly plugin: VideoSummaryPlugin,
  ) {
    super(app);
  }

  /** Closes every open check-up; the plugin calls it when it unloads. */
  static closeAll() {
    [...BackendHealthModal.opened].forEach((modal) => modal.close());
  }

  onOpen() {
    BackendHealthModal.opened.add(this);
    this.modalEl.addClass('vs-health-modal');
    this.setTitle(tr('处理后端', 'Processing backend'));
    this.off = this.plugin.backend.monitor.subscribe((snapshot) => {
      // Docker is asked again whenever a check or a start finishes.
      if (snapshot.status === 'online' || snapshot.status === 'offline') this.loadDocker();
      this.render();
    });
    this.render();
    this.loadDocker();
    void this.plugin.backend.monitor.check(5_000);
  }

  onClose() {
    BackendHealthModal.opened.delete(this);
    this.off?.();
    this.off = null;
    this.contentEl.empty();
  }

  private loadDocker() {
    const { backend } = this.plugin;
    if (!backend.canStart() || this.dockerPending) return;
    this.dockerPending = true;
    void (async () => {
      const info = await runProgram('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeoutMs: 6000,
      });
      const facts: DockerFacts = {
        engine: info.notFound ? 'missing' : info.code === 0 ? 'running' : 'stopped',
      };
      if (facts.engine === 'running') {
        const container = await locateContainer(runProgram, endpointPort(backend.endpoint()));
        if (container) facts.container = { name: container.name, running: container.running };
      }
      this.docker = facts;
      this.dockerPending = false;
      if (this.off) this.render();
    })();
  }

  private render() {
    const { backend } = this.plugin;
    const snapshot = backend.monitor.snapshot();
    const endpoint = backend.endpoint();
    const { diagnosis } = snapshot;
    const el = this.contentEl;
    el.empty();

    const head = el.createDiv({ cls: 'vs-health-head', attr: { 'aria-live': 'polite' } });
    head.createSpan({ cls: `vs-backend-dot ${statusClass(snapshot)}` });
    const word = statusWord(snapshot);
    head.createSpan({
      cls: 'vs-health-state',
      text: word.charAt(0).toUpperCase() + word.slice(1),
    });
    const reason =
      snapshot.status === 'starting'
        ? snapshot.step || ''
        : snapshot.status === 'offline'
          ? faultReason(diagnosis, endpoint)
          : '';
    if (reason) head.createSpan({ cls: 'vs-health-reason', text: reason });

    const serviceDown = diagnosis?.fault === 'unreachable' || diagnosis?.fault === 'timeout';
    // The one next step. Where Start backend is that step, say what the button does instead.
    const step =
      snapshot.status !== 'offline'
        ? ''
        : backend.lastStartFailure ||
          (backend.canStart() && diagnosis?.fault === 'unreachable'
            ? tr(
                '“启动后端”会打开 Docker 并启动已装好的后端容器，不下载也不更新任何东西。',
                'Start backend opens Docker and starts the backend container that is already installed. It downloads and updates nothing.',
              )
            : faultNextStep(diagnosis, endpoint, backend.canStart()));
    if (step) el.createDiv({ cls: 'vs-health-step', text: step });

    const list = el.createDiv({ cls: 'vs-health-list' });
    const row = (label: string, value: string, tone: 'ok' | 'bad' | 'none' = 'none') => {
      const item = list.createDiv({ cls: 'vs-health-row' });
      item.createSpan({ cls: 'vs-health-label', text: label });
      item.createSpan({ cls: `vs-health-value is-${tone}`, text: value });
    };
    const dash = '—';
    const checked = snapshot.status === 'online' || snapshot.status === 'offline';

    if (backend.canStart()) {
      const docker = this.docker;
      row(
        tr('Docker 引擎', 'Docker engine'),
        !docker
          ? '…'
          : docker.engine === 'running'
            ? tr(`运行中${engineName()}`, `Running${engineName()}`)
            : docker.engine === 'stopped'
              ? tr('没在运行', 'Not running')
              : tr('没有安装', 'Not installed'),
        !docker ? 'none' : docker.engine === 'running' ? 'ok' : 'bad',
      );
      row(
        tr('容器', 'Container'),
        !docker
          ? '…'
          : docker.engine !== 'running'
            ? dash
            : docker.container
              ? `${docker.container.name} · ${docker.container.running ? tr('运行中', 'running') : tr('已停止', 'stopped')}`
              : tr(
                  `没有占用 ${endpointPort(endpoint)} 端口的容器`,
                  `None on port ${endpointPort(endpoint)}`,
                ),
        !docker || docker.engine !== 'running' ? 'none' : docker.container?.running ? 'ok' : 'bad',
      );
    }

    row(
      tr('服务', 'Service'),
      !checked || !diagnosis || diagnosis.fault === 'not-configured'
        ? dash
        : serviceDown
          ? tr('没有应答', 'No answer')
          : tr('有应答', 'Answering'),
      !checked || !diagnosis || diagnosis.fault === 'not-configured'
        ? 'none'
        : serviceDown
          ? 'bad'
          : 'ok',
    );
    const workflowValue = (): [string, 'ok' | 'bad' | 'none'] => {
      if (!checked || !diagnosis || serviceDown) return [dash, 'none'];
      if (diagnosis.ok) return [tr('已激活，能回复', 'Active and answering'), 'ok'];
      if (diagnosis.fault === 'not-configured' || diagnosis.fault === 'http') return [dash, 'none'];
      return [faultReason(diagnosis, endpoint), 'bad'];
    };
    row(tr('工作流', 'Workflow'), ...workflowValue());
    row(tr('地址', 'Address'), endpoint ? endpoint.replace(/[?#].*$/, '') : dash);

    const actions = el.createDiv({ cls: 'vs-health-actions' });
    const busy = snapshot.status === 'starting' || snapshot.status === 'checking';
    const origin = safeExternalHttpUrl(endpointOrigin(endpoint));
    if (origin && !serviceDown && checked) {
      const open = actions.createEl('button', {
        text: tr('打开 n8n', 'Open n8n'),
        attr: { type: 'button' },
      });
      open.addEventListener('click', () => window.open(origin, '_blank', 'noopener,noreferrer'));
    }
    const recheck = actions.createEl('button', {
      text: tr('重新检查', 'Check again'),
      attr: { type: 'button' },
    });
    recheck.disabled = busy;
    recheck.addEventListener(
      'click',
      fire(() => backend.monitor.check()),
    );
    if (backend.canStart() && snapshot.status !== 'online') {
      const start = actions.createEl('button', {
        cls: 'mod-cta',
        text:
          snapshot.status === 'starting'
            ? tr('启动中…', 'Starting…')
            : tr('启动后端', 'Start backend'),
        attr: {
          type: 'button',
          'aria-label': tr(
            '打开 Docker 并启动后端容器',
            'Open Docker and start the backend container',
          ),
        },
      });
      start.disabled = busy;
      start.addEventListener(
        'click',
        fire(() => backend.start()),
      );
    }
  }
}

function engineName(): string {
  const app = dockerEngineApp();
  return app ? ` · ${app.name}` : '';
}
