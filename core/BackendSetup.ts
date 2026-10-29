/**
 * First-run setup for the packaged backend: reading the connection code the start script prints,
 * and turning the backend's health report into steps that each say what to do next.
 */
import { DEFAULT_WEBHOOK_AUTH_HEADER, RECOMMENDED_WORKFLOW } from '../constants';
import { isRecord, type JsonRecord } from '../utils/json';

export interface ConnectionCode {
  url: string;
  headerName: string;
  secret: string;
}

/**
 * Accepts the start script's code (`http://127.0.0.1:5678/webhook/obsidian-video-summary#token=…`),
 * the same with `header=` before the token, or a bare token (then the default local URL is used).
 */
export function parseConnectionCode(raw: string, fallbackUrl: string): ConnectionCode | null {
  const text = raw.trim().replace(/^["'<]+|[">']+$/g, '');
  if (/^[A-Za-z0-9_-]{24,128}$/.test(text)) {
    return { url: fallbackUrl, headerName: DEFAULT_WEBHOOK_AUTH_HEADER, secret: text };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const secret = params.get('token') || '';
  const headerName = params.get('header') || DEFAULT_WEBHOOK_AUTH_HEADER;
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(secret) || !/^[A-Za-z0-9-]{1,64}$/.test(headerName)) {
    return null;
  }
  parsed.hash = '';
  return { url: parsed.toString(), headerName, secret };
}

export type SetupStepState = 'ready' | 'warning' | 'missing' | 'pending';

export interface SetupStep {
  id: 'connect' | 'token' | 'version' | 'tools' | 'chat' | 'speech' | 'vision' | 'bilibili';
  label: string;
  state: SetupStepState;
  detail: string;
  /** What to do when the step is not ready. */
  fix?: string;
}

export interface SetupCheckInput {
  /** HTTP status of the health request; undefined when the request never got an answer. */
  status?: number;
  error?: string;
  report?: unknown;
  /** false for the quick check that does not call the model or speech service. */
  deep: boolean;
}

const START_SCRIPT =
  '在后端文件夹里运行启动脚本（macOS 双击 start-mac.command，Windows 双击 start-windows.cmd）';
const CODE_COMMAND =
  '在后端文件夹运行 ./vs-backend.sh code（Windows：.\\vs-backend.ps1 code），把连接码重新粘贴到上面';
const RESTART = '改完 .env 后再运行一次启动脚本';

const LABELS: Record<SetupStep['id'], string> = {
  connect: '后端在运行',
  token: '连接码正确',
  version: '后端版本',
  tools: '下载和转码工具',
  chat: '总结模型',
  speech: '语音转写',
  vision: '识图（可选）',
  bilibili: 'B 站登录（可选）',
};

function step(id: SetupStep['id'], state: SetupStepState, detail: string, fix?: string): SetupStep {
  return { id, label: LABELS[id], state, detail, fix };
}

function pendingAfter(ids: SetupStep['id'][]): SetupStep[] {
  return ids.map((id) => step(id, 'pending', '等上一步通过后再检查。'));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function serviceFailure(error: string, host: string, keyName: string, modelName: string): string {
  if (/\b40[13]\b|Authorization failed|unauthori[sz]ed|invalid[^.]{0,30}key/i.test(error)) {
    return `服务商不认这个密钥。检查 .env 里的 ${keyName} 是否完整（也可以运行 vs-backend keys 重新输入），${RESTART}。`;
  }
  if (/\b402\b|payment required|balance|quota|余额/i.test(error)) {
    return '服务商账户余额不足。硅基流动在余额为 0 时连免费模型也会拒绝，充值一两元即可；或换一个密钥。';
  }
  if (/\b404\b|not found|could not be found/i.test(error)) {
    return `服务商找不到这个地址或模型名。检查 .env 里的接口地址和 ${modelName}，${RESTART}。`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|timeout|socket|network/i.test(error)) {
    return `后端连不上 ${host}。检查电脑网络；如果需要代理，在 .env 填 VS_HTTP_PROXY，${RESTART}。`;
  }
  return `${error || '未知错误'}。运行 vs-backend logs 查看后端日志。`;
}

function serviceStep(
  id: 'chat' | 'speech',
  part: JsonRecord,
  deep: boolean,
  keyName: string,
  modelName: string,
  missingState: SetupStepState,
  missingWhy: string,
): SetupStep {
  const model = text(part.model) || '未知模型';
  const host = text(part.host) || '服务商';
  if (part.configured !== true) {
    return step(
      id,
      missingState,
      `${model} @ ${host}：还没有填密钥。${missingWhy}`,
      `在后端 .env 里填 ${keyName}（或运行 vs-backend keys），${RESTART}。`,
    );
  }
  if (!deep || part.checked !== true) {
    return step(id, 'pending', `${model} @ ${host}：已填密钥，点“完整检查”确认能用。`);
  }
  if (part.ok === false) {
    return step(
      id,
      'missing',
      `${model} @ ${host}：调用失败。`,
      serviceFailure(text(part.error), host, keyName, modelName),
    );
  }
  if (part.modelListed === false) {
    return step(
      id,
      'warning',
      `${model} @ ${host}：密钥可用，但服务商的模型列表里没有这个名字。`,
      `核对 .env 里的 ${modelName}，名称以服务商文档为准，${RESTART}。`,
    );
  }
  return step(id, 'ready', `${model} @ ${host}`);
}

export function interpretSetupCheck(input: SetupCheckInput): SetupStep[] {
  const later: SetupStep['id'][] = ['version', 'tools', 'chat', 'speech', 'vision', 'bilibili'];
  if (input.status === undefined) {
    return [
      step(
        'connect',
        'missing',
        `连不上后端：${input.error || '没有响应'}`,
        `先打开 Docker Desktop 或 OrbStack，再${START_SCRIPT}。看到“好了”和连接码后再检查。`,
      ),
      ...pendingAfter(['token', ...later]),
    ];
  }
  if (input.status === 404) {
    return [
      step(
        'connect',
        'warning',
        '后端在运行，但还没有准备好处理请求。',
        '第一次启动要等一分钟左右。如果一直这样，确认连接码里的端口和启动脚本最后显示的一致。',
      ),
      ...pendingAfter(['token', ...later]),
    ];
  }
  if (input.status === 401 || input.status === 403) {
    return [
      step('connect', 'ready', '后端在运行。'),
      step('token', 'missing', '后端拒绝了这个连接码。', `${CODE_COMMAND}。`),
      ...pendingAfter(later),
    ];
  }
  if (input.status < 200 || input.status >= 300 || !isRecord(input.report)) {
    return [
      step('connect', 'ready', '后端在运行。'),
      step(
        'token',
        'warning',
        `后端返回了 HTTP ${input.status}，不是检查结果。`,
        '运行 vs-backend logs 查看后端日志。',
      ),
      ...pendingAfter(later),
    ];
  }

  const report = input.report;
  const workflow = isRecord(report.workflow) ? report.workflow : {};
  const backend = isRecord(report.backend) ? report.backend : null;
  const steps: SetupStep[] = [
    step('connect', 'ready', '后端在运行。'),
    step('token', 'ready', '连接码正确。'),
  ];
  const version = text(workflow.version);
  if (!backend) {
    steps.push(
      step(
        'version',
        'missing',
        `这是旧版手动导入的工作流${version ? `（${version}）` : ''}。`,
        '请改用后端安装包：下载 video-summary-backend 压缩包，运行启动脚本，再粘贴新的连接码。',
      ),
      ...pendingAfter(['tools', 'chat', 'speech', 'vision', 'bilibili']),
    );
    return steps;
  }
  steps.push(
    version === RECOMMENDED_WORKFLOW.version
      ? step('version', 'ready', `工作流 ${version}`)
      : step(
          'version',
          'warning',
          `后端工作流是 ${version || '未知版本'}，这个插件配套的是 ${RECOMMENDED_WORKFLOW.version}。`,
          '下载同版本的后端安装包，覆盖旧文件夹（.env 会保留），再运行 vs-backend update。',
        ),
  );

  const tools = isRecord(backend.tools) ? backend.tools : {};
  const ytDlp = text(tools.ytDlp);
  const ffmpeg = text(tools.ffmpeg);
  steps.push(
    ytDlp && ffmpeg
      ? step('tools', 'ready', `yt-dlp ${ytDlp}，ffmpeg ${ffmpeg}`)
      : step(
          'tools',
          'missing',
          `缺少${ytDlp ? '' : ' yt-dlp'}${ffmpeg ? '' : ' ffmpeg'}。`,
          '这个后端不是用安装包启动的。请用安装包里的启动脚本重新启动。',
        ),
  );

  steps.push(
    serviceStep(
      'chat',
      isRecord(backend.chat) ? backend.chat : {},
      input.deep,
      'VS_CHAT_API_KEY',
      'VS_CHAT_MODEL',
      'missing',
      '没有它就不能生成总结。',
    ),
    serviceStep(
      'speech',
      isRecord(backend.speech) ? backend.speech : {},
      input.deep,
      'VS_SPEECH_API_KEY',
      'VS_SPEECH_MODEL',
      'warning',
      '没有字幕的视频和本地音视频要用它；有字幕的视频和粘贴文稿不受影响。',
    ),
  );

  const vision = isRecord(backend.vision) ? backend.vision : {};
  steps.push(
    vision.configured === true
      ? step('vision', 'ready', `${text(vision.model)} @ ${text(vision.host)}`)
      : step(
          'vision',
          'warning',
          '没有可用的识图密钥，本地图片暂时读不了；PDF 不受影响。',
          '默认沿用语音转写的硅基流动密钥，填好 VS_SPEECH_API_KEY 即可。',
        ),
  );

  const cookies = isRecord(backend.cookies) ? backend.cookies : {};
  const bilibili = isRecord(cookies.bilibili) ? cookies.bilibili : {};
  steps.push(
    bilibili.loggedIn === true
      ? step('bilibili', 'ready', '已导入 B 站登录 cookie，可以用 B 站 AI 字幕。')
      : step(
          'bilibili',
          'warning',
          bilibili.present === true
            ? 'cookie 文件里没有登录信息（SESSDATA）。'
            : '还没有导入。不导入也能用，只是 B 站 AI 字幕拿不到，会改用语音转写。',
          '点下面的“④ 扫码登录”，用 B 站手机客户端扫一下即可；也可以用浏览器扩展“同步 B 站登录”，或粘贴 cookies.txt。',
        ),
  );
  return steps;
}

/** The model name the backend reported, recorded with every result. */
export function reportedChatModel(report: unknown): string {
  if (!isRecord(report) || !isRecord(report.backend) || !isRecord(report.backend.chat)) return '';
  return text(report.backend.chat.model);
}
