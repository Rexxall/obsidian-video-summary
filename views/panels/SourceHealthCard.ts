import { Notice } from 'obsidian';
import type { Job } from '../../core/JobStore';
import { diagnoseSource, type SourceDiagnosis } from '../../core/SourceHealth';
import { tr } from '../../utils/i18n';
import { isRecord } from '../../utils/json';
import type { ViewContext } from '../context';
import { textButton } from '../ui';
import { openSettings } from './ActionBar';

/** The quick check does not call any service; one answer is good for a few minutes. */
const SPEECH_TTL_MS = 5 * 60 * 1000;
let speechCheck: { at: number; configured?: boolean; pending?: boolean } = { at: 0 };

function speechConfigured(ctx: ViewContext): boolean | undefined {
  if (speechCheck.pending || Date.now() - speechCheck.at < SPEECH_TTL_MS) {
    return speechCheck.configured;
  }
  speechCheck = { at: Date.now(), pending: true };
  void ctx.plugin.api.checkBackend(false).then((outcome) => {
    const backend = isRecord(outcome.report) ? outcome.report.backend : undefined;
    const speech = isRecord(backend) ? backend.speech : undefined;
    const configured = isRecord(speech) ? speech.configured === true : undefined;
    speechCheck = { at: Date.now(), configured };
    ctx.renderPanels();
  });
  return undefined;
}

function subtitlesText(diagnosis: SourceDiagnosis): string {
  switch (diagnosis.subtitles) {
    case 'missing':
      return tr('这条视频没有', 'None for this video');
    case 'login':
      return tr('需要登录', 'Needs a login');
    case 'rate-limit':
      return tr('请求太频繁，被暂时挡住', 'Blocked for now: too many requests');
    case 'blocked':
      return tr('平台不让读取', 'The platform does not allow reading it');
    default:
      return tr('没拿到', 'Not received');
  }
}

function speechText(diagnosis: SourceDiagnosis): string {
  if (diagnosis.speech === 'off') return tr('没有配置', 'Not set up');
  if (diagnosis.speech === 'on') return tr('已配置', 'Set up');
  return speechCheck.pending
    ? tr('正在检查…', 'Checking…')
    : tr('后端没连上，查不到', 'Unknown: the backend is not connected');
}

/** The one next step for each cause. */
function nextStep(
  diagnosis: SourceDiagnosis,
  platform: string | undefined,
): { text: string; action?: 'settings' | 'paste' } {
  switch (diagnosis.problem) {
    case 'rate-limit':
      return {
        text: tr(
          '过 10 分钟再试。现在重试还会被挡；急用就贴文稿。',
          'Try again in 10 minutes; retrying now gets blocked again. If it is urgent, paste a transcript.',
        ),
        action: 'paste',
      };
    case 'login':
      return platform === 'bilibili'
        ? {
            text: tr(
              '在首次配置里扫码登录 B 站，再重试。',
              'Log in to Bilibili in first-run setup, then retry.',
            ),
            action: 'settings',
          }
        : {
            text: tr('登录后再重试，或者贴文稿。', 'Log in and retry, or paste a transcript.'),
            action: 'paste',
          };
    case 'blocked':
      return {
        text: tr(
          '把文案贴进来总结；也可以手动下载视频，拖进侧栏。',
          'Paste the text to summarise it, or download the video yourself and drop it into the side panel.',
        ),
        action: 'paste',
      };
    case 'speech-off':
      return {
        text: tr(
          '贴一份文稿；或者在后端文件夹运行 ./vs-backend.sh keys 填上语音转写密钥，以后没字幕的视频也能转写。',
          'Paste a transcript, or run ./vs-backend.sh keys in the backend folder and add a speech-to-text key so videos without subtitles get transcribed.',
        ),
        action: 'paste',
      };
    case 'no-subtitles':
      if (diagnosis.speech !== 'on') {
        return {
          text: tr('贴一份文稿就能接着总结。', 'Paste a transcript to finish.'),
          action: 'paste',
        };
      }
      return {
        text: tr(
          '语音转写也没成功。贴一份文稿就能接着总结。',
          'Speech-to-text did not work either. Paste a transcript to finish.',
        ),
        action: 'paste',
      };
    default:
      return {
        text: tr(
          '后端没有连上。打开 Docker，再运行启动脚本。',
          'The backend is not connected. Open Docker, then run the start script.',
        ),
      };
  }
}

/**
 * The failed job's card: where the transcript should have come from, what went wrong on each
 * route, and the one step that can work. Returns false when the failure is not about the source.
 */
export function renderSourceHealth(body: HTMLElement, ctx: ViewContext, job: Job): boolean {
  const isLink = !!job.input.url;
  const first = diagnoseSource(job.error || '', { isLink });
  if (!first) return false;
  // Speech-to-text only matters when the video simply has no subtitles; ask the backend then.
  const speechMatters = first.problem === 'no-subtitles' || first.problem === 'speech-off';
  const diagnosis =
    speechMatters && isLink
      ? (diagnoseSource(job.error || '', { isLink, speechConfigured: speechConfigured(ctx) }) ??
        first)
      : first;

  const card = body.createDiv({ cls: 'vs-source-health' });
  if (diagnosis.problem !== 'backend') {
    const group = card.createDiv({ cls: 'ap-group' });
    const row = (title: string, value: string, bad: boolean) => {
      const el = group.createDiv({ cls: 'ap-row' });
      el.createDiv({ cls: 'ap-row-main' }).createDiv({ cls: 'ap-row-title', text: title });
      el.createDiv({ cls: `ap-row-value${bad ? ' is-bad' : ''}`, text: value });
    };
    if (isLink) row(tr('视频字幕', 'Video subtitles'), subtitlesText(diagnosis), true);
    if (speechMatters) {
      row(tr('语音转写', 'Speech-to-text'), speechText(diagnosis), diagnosis.speech === 'off');
    }
  }

  const step = nextStep(diagnosis, job.platform);
  card.createDiv({ cls: 'vs-source-next', text: step.text });

  const actions = card.createDiv({ cls: 'vs-detail-actions' });
  const pasteBox = card.createDiv({ cls: 'vs-source-paste' });
  pasteBox.hide();
  if (step.action === 'paste' && diagnosis.canPaste) {
    const area = pasteBox.createEl('textarea', {
      cls: 'vs-field-input',
      attr: { rows: '6', 'aria-label': tr('文稿', 'Transcript') },
    });
    const run = textButton(
      pasteBox,
      tr('用这份文稿总结', 'Summarise this transcript'),
      () => {
        if (!area.value.trim()) {
          new Notice(tr('先贴一份文稿', 'Paste a transcript first'));
          return;
        }
        ctx.plugin.jobs.retryWithTranscript(job.id, area.value);
        ctx.closeDetail();
      },
      'is-primary is-fill',
    );
    run.addClass('vs-source-run');
    const open = () => {
      pasteBox.show();
      area.focus();
    };
    textButton(actions, tr('贴文稿', 'Paste a transcript'), open, 'is-primary is-fill');
    if (ctx.state.pasteForJob === job.id) {
      ctx.state.pasteForJob = undefined;
      window.setTimeout(open, 0);
    }
  } else if (step.action === 'settings') {
    textButton(
      actions,
      tr('打开首次配置', 'Open first-run setup'),
      () => openSettings(ctx),
      'is-primary is-fill',
    );
  }
  if (!diagnosis.retryUseless) {
    textButton(actions, tr('重试', 'Retry'), () => {
      ctx.plugin.jobs.retry(job.id);
      ctx.closeDetail();
    });
  }
  textButton(actions, tr('复制错误', 'Copy error'), () => {
    void navigator.clipboard.writeText(job.error || '');
    new Notice(tr('已复制', 'Copied'));
  });
  return true;
}
