import { App, Notice, SecretComponent, Setting } from 'obsidian';
import type VideoSummaryPlugin from '../main';
import type { SetupStep } from '../core/BackendSetup';
import {
  LLM_PROVIDERS,
  SPEECH_DEFAULTS,
  hasSecretStorage,
  llmProvider,
  readSecret,
  resolveLlm,
  type LlmProviderId,
} from '../core/ModelSettings';
import { dockerEngineApp, openDockerEngine } from '../utils/desktop';
import { fire } from '../utils/fire';
import { getLanguage } from 'obsidian';
import { tr } from '../utils/i18n';

export interface BackendSettingsHost {
  app: App;
  plugin: VideoSummaryPlugin;
  /** Draws the result list of a backend check. */
  renderSteps(container: HTMLElement, steps: SetupStep[]): void;
  /** Draws the Bilibili QR login row. */
  renderBilibili(container: HTMLElement): void;
}

const ORBSTACK_URL = 'https://orbstack.dev/download';
/** Redraws the Backend group when the model group changes something it depends on (the key). */
let refreshBackendGroup: (() => void) | null = null;
const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/';

/**
 * The Backend group of the settings page. Before a backend exists it shows only
 * the step to do now and one button; afterwards the model, the keys and three
 * buttons. Returns a function that stops it following the backend's state.
 */
export function renderBackendSettings(parent: HTMLElement, host: BackendSettingsHost): () => void {
  const { plugin } = host;
  const { installer, backend } = plugin;
  const root = parent.createDiv({ cls: 'vs-settings-section vs-backend-settings' });
  let disposed = false;
  let lastKey = '';

  const stateKey = () => {
    const progress = installer.progress();
    const facts = installer.facts();
    const snapshot = backend.monitor.snapshot();
    return JSON.stringify([
      progress.phase,
      progress.message,
      progress.steps?.length ?? -1,
      facts?.docker,
      facts?.container?.id,
      facts?.container?.running,
      facts?.container?.restart,
      facts?.container?.image,
      snapshot.status,
      snapshot.step,
      snapshot.diagnosis?.fault,
      plugin.hasBackend(),
      !!readSecret(host.app, plugin.settings.llmKeySecret),
    ]);
  };
  const draw = () => {
    if (disposed) return;
    lastKey = stateKey();
    root.empty();
    drawBackend(root, host, () => draw());
  };
  const maybeDraw = () => {
    // Redrawing takes the focus out of a field being typed in, so only redraw on a real change.
    if (!disposed && stateKey() !== lastKey) draw();
  };

  const offInstaller = installer.subscribe(maybeDraw);
  const offMonitor = backend.monitor.subscribe(maybeDraw);
  refreshBackendGroup = maybeDraw;
  draw();
  if (installer.supported()) void installer.refreshFacts();
  void backend.monitor.check(30_000);

  return () => {
    disposed = true;
    if (refreshBackendGroup === maybeDraw) refreshBackendGroup = null;
    offInstaller();
    offMonitor();
  };
}

/** The plugin runs the packaged backend, so the model and keys chosen here reach it. */
function isManaged(plugin: VideoSummaryPlugin): boolean {
  const facts = plugin.installer.facts();
  // While Docker is off that cannot be seen, so a backend the plugin has already handed settings to still counts.
  return (
    !!facts?.bundled || (!!facts && !facts.container && !!plugin.settings.backendAppliedConfig)
  );
}

/** A remote backend or someone's own n8n keeps its model and keys on its side. */
function isExternal(plugin: VideoSummaryPlugin): boolean {
  const facts = plugin.installer.facts();
  return !!facts && !isManaged(plugin) && plugin.hasBackend();
}

/**
 * The Model group: summary model and keys, used by both tiers, and the light-tier
 * switch. Shown whatever state the backend is in, so a new person can make a first
 * note with a key alone. Returns a function that stops it following the backend.
 */
export function renderModelSettings(parent: HTMLElement, host: BackendSettingsHost): () => void {
  const { plugin } = host;
  const root = parent.createDiv({ cls: 'vs-settings-section vs-model-settings' });
  let disposed = false;
  let lastKey = '';
  const stateKey = () => JSON.stringify([isManaged(plugin), isExternal(plugin)]);
  const draw = () => {
    if (disposed) return;
    lastKey = stateKey();
    root.empty();
    const managed = isManaged(plugin);
    if (isExternal(plugin)) {
      root.createEl('p', {
        cls: 'setting-item-description vs-backend-external',
        text: tr(
          '你的后端用它自己的模型和密钥（n8n 的凭据或它的 .env）；这里的只给轻量档用。',
          'Your backend uses its own model and keys (its n8n credentials or its .env); the ones here are for the light tier only.',
        ),
      });
    }
    drawModelRows(root, host, {
      applyToBackend: managed,
      disabled: false,
      onChange: () => {
        draw();
        refreshBackendGroup?.();
      },
    });
    new Setting(root)
      .setName(tr('轻量档', 'Light tier'))
      .setDesc(
        tr(
          'YouTube 有字幕的视频和粘贴的文稿直接交给总结模型，不经过后端，边写边显示。',
          'YouTube videos with captions and pasted transcripts go straight to the summary model, without the backend, and appear as they are written.',
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(plugin.settings.liteTierEnabled !== false).onChange(async (value) => {
          plugin.settings.liteTierEnabled = value;
          await plugin.saveSettings();
        }),
      );
  };
  const maybeDraw = () => {
    if (!disposed && stateKey() !== lastKey) draw();
  };
  const offInstaller = plugin.installer.subscribe(maybeDraw);
  draw();
  return () => {
    disposed = true;
    offInstaller();
  };
}

function drawBackend(root: HTMLElement, host: BackendSettingsHost, redraw: () => void) {
  const { plugin } = host;
  const { installer } = plugin;
  const progress = installer.progress();
  const busy =
    progress.phase === 'terminal' ||
    progress.phase === 'configure' ||
    progress.phase === 'check' ||
    progress.phase === 'trial';

  if (busy) {
    drawProgress(root, host);
    return;
  }
  if (!plugin.hasBackend() && installer.supported()) {
    drawFirstRun(root, host, redraw);
    return;
  }
  drawInstalled(root, host);
}

/** One line of progress for install, update and the automatic check that follows. */
function drawProgress(root: HTMLElement, host: BackendSettingsHost) {
  const { installer } = host.plugin;
  const progress = installer.progress();
  const order = ['terminal', 'configure', 'check', 'trial'];
  const labels = [
    tr('下载', 'Download'),
    tr('设置', 'Set up'),
    tr('检查', 'Check'),
    tr('试跑', 'Trial'),
  ];
  const card = root.createDiv({ cls: 'vs-install' });
  const track = card.createDiv({
    cls: 'vs-install-track',
    attr: { role: 'list', 'aria-label': tr('安装进度', 'Install progress') },
  });
  const at = order.indexOf(progress.phase);
  labels.forEach((label, index) => {
    const state = index < at ? 'is-done' : index === at ? 'is-now' : '';
    const item = track.createDiv({
      cls: `vs-install-stage ${state}`.trim(),
      attr: { role: 'listitem' },
    });
    item.createSpan({ cls: 'vs-install-dot' });
    item.createSpan({ text: label });
  });
  card.createDiv({
    cls: 'vs-install-message',
    text: progress.message,
    attr: { 'aria-live': 'polite' },
  });

  const row = card.createDiv({ cls: 'vs-install-actions' });
  if (progress.phase === 'terminal') {
    const again = row.createEl('button', {
      text: tr('重新打开终端', 'Open Terminal again'),
      attr: { type: 'button' },
    });
    again.addEventListener(
      'click',
      fire(() => installer.reopenTerminal()),
    );
    const cancel = row.createEl('button', { text: tr('取消', 'Cancel'), attr: { type: 'button' } });
    cancel.addEventListener('click', () => installer.cancel());
  }
}

/** Nothing installed yet: only the step to do now, and one button. */
function drawFirstRun(root: HTMLElement, host: BackendSettingsHost, redraw: () => void) {
  const { plugin } = host;
  const { installer } = plugin;
  const facts = installer.facts();
  const progress = installer.progress();

  if (progress.phase === 'failed') drawFailure(root, host);

  if (!facts) {
    new Setting(root).setName(
      tr('正在看这台电脑上有没有 Docker…', 'Looking for Docker on this computer…'),
    );
    return;
  }

  if (facts.docker === 'missing') {
    const setting = new Setting(root).setName(tr('先装 Docker', 'Install Docker first'));
    const desc = createFragment();
    desc.appendText(
      tr(
        '视频在你自己的电脑上处理，需要 Docker。装 ',
        'Videos are processed on your own computer, which needs Docker. Install ',
      ),
    );
    desc.createEl('a', { text: 'OrbStack', href: ORBSTACK_URL });
    desc.appendText(tr('（Mac，较轻）或 ', ' (Mac, lighter) or '));
    desc.createEl('a', { text: 'Docker Desktop', href: DOCKER_DESKTOP_URL });
    desc.appendText(tr('，打开它，再回到这里。', ', open it, then come back here.'));
    setting.setDesc(desc);
    setting.addButton((button) =>
      button
        .setButtonText(tr('装好了', 'Installed'))
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          await installer.refreshFacts();
          redraw();
        }),
    );
    return;
  }

  if (facts.docker === 'stopped') {
    const app = dockerEngineApp();
    new Setting(root)
      .setName(tr('打开 Docker', 'Open Docker'))
      .setDesc(tr('Docker 已经装了，但没在运行。', 'Docker is installed but not running.'))
      .addButton((button) =>
        button
          .setButtonText(
            app ? tr(`打开 ${app.name}`, `Open ${app.name}`) : tr('重新检查', 'Check again'),
          )
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText(tr('正在打开…', 'Opening…'));
            if (app) await openDockerEngine();
            for (let i = 0; i < 30; i += 1) {
              if ((await installer.refreshFacts()).docker === 'running') break;
              await new Promise((resolve) => window.setTimeout(resolve, 2000));
            }
            redraw();
          }),
      );
    return;
  }

  // Docker runs: the model and keys are chosen in the Model group above; one button does the rest.
  const ready = !!readSecret(host.app, plugin.settings.llmKeySecret);
  new Setting(root)
    .setName(tr('安装并启动', 'Install and start'))
    .setDesc(
      ready
        ? tr(
            `写好后端文件夹（${installer.backendDir()}），再打开终端，由你按回车下载约 550 MB 的后端镜像。之后的检查和试跑自动完成。`,
            `Writes the backend folder (${installer.backendDir()}), then opens Terminal, where you press Return to download the backend image (about 550 MB). The check and the trial run follow by themselves.`,
          )
        : tr('先在上面选一把总结密钥。', 'Choose a summary key above first.'),
    )
    .addButton((button) =>
      button
        .setButtonText(tr('安装并启动', 'Install and start'))
        .setCta()
        .setDisabled(!ready)
        .onClick(() => void installer.install()),
    );
}

function drawFailure(root: HTMLElement, host: BackendSettingsHost) {
  const progress = host.plugin.installer.progress();
  const box = root.createDiv({ cls: 'vs-install is-failed' });
  box.createDiv({ cls: 'vs-install-message', text: progress.message });
  if (progress.steps?.length) {
    host.renderSteps(box.createDiv({ cls: 'setup-check-list' }), progress.steps);
  }
}

/** The backend exists: status, Bilibili, start at login, three buttons. The model is in its own group. */
function drawInstalled(root: HTMLElement, host: BackendSettingsHost) {
  const { plugin } = host;
  const { installer, backend } = plugin;
  const facts = installer.facts();
  const snapshot = backend.monitor.snapshot();
  const progress = installer.progress();
  const managed = isManaged(plugin);

  if (progress.phase === 'failed') drawFailure(root, host);
  if (progress.phase === 'done') {
    root.createDiv({ cls: 'vs-install is-done' }).createDiv({
      cls: 'vs-install-message',
      text: progress.message,
    });
  }

  host.renderBilibili(root);

  if (managed && facts?.container) {
    new Setting(root)
      .setName(tr('开机后自动启动', 'Start with the computer'))
      .setDesc(
        tr(
          'Docker 启动时把后端一起带起来。Docker 自己要设成登录时打开。',
          'Docker brings the backend up when it starts. Docker itself has to open at login.',
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(installer.autoStart()).onChange(async (value) => {
          if (!(await installer.setAutoStart(value))) {
            new Notice(tr('没改成，Docker 没有接受。', 'Not changed; Docker did not accept it.'));
          }
        }),
      );
  }

  const results = root.createDiv({ cls: 'setup-check-list' });
  // After a clean install the one line above says enough; the list appears on Check or on failure.
  if (progress.steps?.length && progress.phase === 'idle')
    host.renderSteps(results, progress.steps);

  const buttons = root.createDiv({ cls: 'ap-button-row vs-backend-buttons' });
  const check = buttons.createEl('button', { text: tr('检查', 'Check'), attr: { type: 'button' } });
  check.addEventListener(
    'click',
    fire(async () => {
      check.disabled = true;
      results.empty();
      results.createDiv({
        cls: 'setup-check-progress',
        text: tr(
          '完整检查中，会调用一次模型和语音转写，约 10–30 秒…',
          'Full check in progress; it calls the model and speech-to-text once, about 10–30 seconds…',
        ),
      });
      host.renderSteps(results, await installer.check());
      check.disabled = false;
    }),
  );

  if (backend.canStart()) {
    const running = snapshot.status === 'online';
    const toggle = buttons.createEl('button', {
      text: running ? tr('停止', 'Stop') : tr('启动', 'Start'),
      attr: {
        type: 'button',
        'aria-label': running
          ? tr('停止后端容器，数据保留', 'Stop the backend container; data is kept')
          : tr('打开 Docker 并启动后端容器', 'Open Docker and start the backend container'),
      },
    });
    toggle.disabled = snapshot.status === 'starting' || snapshot.status === 'checking';
    toggle.addEventListener(
      'click',
      fire(async () => {
        toggle.disabled = true;
        if (running) await installer.stop();
        else await backend.start();
        await installer.refreshFacts();
      }),
    );
  }

  if (managed && installer.supported() && installer.outdated()) {
    const update = buttons.createEl('button', {
      cls: 'mod-cta',
      text: tr('更新后端', 'Update backend'),
      attr: {
        type: 'button',
        'aria-label': tr(
          '打开终端，由你按回车下载新版后端',
          'Opens Terminal, where you press Return to download the new backend',
        ),
      },
    });
    update.addEventListener('click', () => void installer.update());
    root.createEl('p', {
      cls: 'setting-item-description vs-backend-update',
      text: tr(
        `后端是 ${facts?.imageVersion || '旧版'}，这版插件配的是 ${plugin.manifest.version}。“更新后端”会打开终端，由你按回车下载。`,
        `The backend is ${facts?.imageVersion || 'an older version'}; this plugin version goes with ${plugin.manifest.version}. Update backend opens Terminal, where you press Return to download it.`,
      ),
    });
  }
}

/** Summary model, summary key, speech-to-text key. */
function drawModelRows(
  root: HTMLElement,
  host: BackendSettingsHost,
  options: { applyToBackend: boolean; disabled: boolean; onChange: () => void },
) {
  const { plugin, app } = host;
  const { settings } = plugin;
  const chinese = getLanguage().startsWith('zh');
  const changed = async (redraw = false) => {
    await plugin.saveSettings();
    if (options.applyToBackend) plugin.installer.scheduleApply();
    if (redraw) options.onChange();
  };

  /** Greys a row out and takes its controls out of reach of the pointer and the keyboard. */
  const lock = (setting: Setting) => {
    if (!options.disabled) return;
    setting.setDisabled(true);
    setting.settingEl.addClass('is-disabled', 'vs-row-locked');
    setting.controlEl.setAttr('inert', '');
    setting.controlEl.setAttr('aria-disabled', 'true');
  };

  const provider = llmProvider(settings.llmProvider);
  const llm = resolveLlm(settings);
  const model = new Setting(root).setName(tr('总结模型', 'Summary model'));
  model.addDropdown((dropdown) => {
    for (const item of LLM_PROVIDERS) {
      dropdown.addOption(item.id, (chinese && item.labelZh) || item.label);
    }
    dropdown.setValue(provider.id).onChange(async (value) => {
      settings.llmProvider = value as LlmProviderId;
      settings.llmModel = '';
      await changed(true);
    });
  });
  if (provider.id === 'custom') {
    model.addText((text) =>
      text
        .setPlaceholder('https://api.example.com/v1')
        .setValue(settings.llmBaseUrl || '')
        .onChange(async (value) => {
          settings.llmBaseUrl = value.trim();
          await changed();
        }),
    );
  }
  model.addText((text) => {
    text
      .setPlaceholder(provider.defaultModel || tr('模型名', 'Model name'))
      .setValue(settings.llmModel || '')
      .onChange(async (value) => {
        settings.llmModel = value.trim();
        await changed();
      });
    text.inputEl.setAttr('aria-label', tr('模型名', 'Model name'));
    text.inputEl.addClass('vs-model-name');
  });
  lock(model);
  if (!llm.model && !options.disabled) {
    model.setDesc(
      tr(
        '这家没有固定的默认模型，填它控制台里的模型名。',
        'This service has no fixed default; enter a model name from its console.',
      ),
    );
  }

  if (!hasSecretStorage(app)) {
    new Setting(root)
      .setName(tr('密钥', 'Keys'))
      .setDesc(
        tr(
          '在设置里管理密钥需要 Obsidian 1.11.4 或更新。旧版请在后端的 .env 里填密钥。',
          "Managing keys here needs Obsidian 1.11.4 or newer. On older versions, put the keys in the backend's .env.",
        ),
      );
    return;
  }

  const keyRow = (
    name: string,
    current: string,
    keyUrl: string,
    save: (secret: string) => void,
  ) => {
    const setting = new Setting(root).setName(name);
    if (keyUrl) {
      const desc = createFragment();
      desc.createEl('a', { text: tr('去哪拿', 'Where to get one'), href: keyUrl });
      setting.setDesc(desc);
    }
    setting.addComponent((el) =>
      new SecretComponent(app, el).setValue(current || '').onChange(async (value) => {
        save((value || '').trim());
        await changed(true);
      }),
    );
    lock(setting);
  };
  keyRow(tr('总结密钥', 'Summary key'), settings.llmKeySecret, provider.keyUrl, (secret) => {
    settings.llmKeySecret = secret;
  });
  keyRow(
    tr('语音转写密钥', 'Speech-to-text key'),
    settings.speechKeySecret,
    SPEECH_DEFAULTS.keyUrl,
    (secret) => {
      settings.speechKeySecret = secret;
    },
  );
}
