import { BackendDiagnosis, BackendSnapshot, isLocalEndpoint } from '../core/BackendHealth';
import { LaunchResult } from '../core/BackendLauncher';
import { tr } from '../utils/i18n';

/**
 * One word for the status bar and the side panel. liteReady: the light tier can make notes
 * without a backend, so a backend that was never set up is not a fault.
 */
export function statusWord(snapshot: BackendSnapshot, liteReady = false): string {
  switch (snapshot.status) {
    case 'online':
      return tr('在线', 'online');
    case 'offline':
      if (snapshot.diagnosis?.fault !== 'not-configured') return tr('离线', 'offline');
      return liteReady
        ? tr('未安装 · 轻量档可用', 'not set up · light tier ready')
        : tr('未安装', 'not set up');
    case 'starting':
      return tr('启动中', 'starting');
    case 'checking':
      return tr('检查中', 'checking');
    default:
      return tr('未检查', 'not checked');
  }
}

export function statusClass(snapshot: BackendSnapshot, liteReady = false): string {
  if (snapshot.status === 'online') return 'is-online';
  if (snapshot.status === 'offline') {
    return liteReady && snapshot.diagnosis?.fault === 'not-configured'
      ? 'is-unknown'
      : 'is-offline';
  }
  if (snapshot.status === 'unknown') return 'is-unknown';
  return 'is-checking';
}

/** A few words saying what is wrong. Never contains the address or the token. */
export function faultReason(diagnosis: BackendDiagnosis | undefined, endpoint: string): string {
  switch (diagnosis?.fault) {
    case 'not-configured':
      return tr('还没安装后端', 'no backend yet');
    case 'unreachable':
      return isLocalEndpoint(endpoint)
        ? tr('后端没在运行', 'the backend is not running')
        : tr('连不上服务器', 'the server cannot be reached');
    case 'workflow-inactive':
      return tr('工作流没激活', 'the workflow is not active');
    case 'workflow-error':
      return tr('工作流执行出错', 'the workflow failed');
    case 'empty-response':
      return tr('工作流没有回内容', 'the workflow sent nothing back');
    case 'auth':
      return tr('口令不对', 'wrong token');
    case 'timeout':
      return tr('没有应答', 'no answer');
    case 'http':
      return tr(
        `地址不对（HTTP ${diagnosis.status ?? '?'}）`,
        `wrong address (HTTP ${diagnosis.status ?? '?'})`,
      );
    default:
      return '';
  }
}

/** One sentence the person can act on. */
export function faultNextStep(
  diagnosis: BackendDiagnosis | undefined,
  endpoint: string,
  canStart: boolean,
): string {
  switch (diagnosis?.fault) {
    case 'not-configured':
      return tr(
        '到 设置 → 视频总结 → 后端 里安装并启动。',
        'Go to Settings → Video Summary → Backend to install and start it.',
      );
    case 'unreachable':
      if (canStart) return tr('点“启动后端”。', 'Choose Start backend.');
      return isLocalEndpoint(endpoint)
        ? tr(
            '打开 Docker，再运行后端文件夹里的启动脚本。',
            'Open Docker, then run the start script in the backend folder.',
          )
        : tr(
            '确认服务器开着，这台电脑能连到它。',
            'Make sure the server is up and this computer can reach it.',
          );
    case 'workflow-inactive':
      return tr(
        '打开 n8n，把视频总结工作流右上角的开关打开。',
        'Open n8n and switch the video summary workflow on (top right).',
      );
    case 'workflow-error':
      return tr(
        '打开 n8n 的 Executions，看最近一次执行在哪个节点报错。',
        'Open Executions in n8n and see which node failed in the latest run.',
      );
    case 'empty-response':
      return tr(
        '打开 n8n 的 Executions，看最近一次执行停在哪个节点；没有报错就检查回复节点还连着。',
        'Open Executions in n8n and see where the latest run stopped; with no error there, check that the Respond node is still connected.',
      );
    case 'auth':
      return tr(
        '重新运行启动脚本，把它显示的连接码粘贴到设置里。',
        'Run the start script again and paste the connection code it shows into settings.',
      );
    case 'timeout':
      return tr(
        '后端可能还在启动，过半分钟再检查。',
        'The backend may still be starting; check again in half a minute.',
      );
    case 'http':
      return tr(
        '连接码指向的不是视频总结的 webhook，重新粘贴一次连接码。',
        'The connection code does not point at the video summary webhook; paste it again.',
      );
    default:
      return '';
  }
}

/** Why the start button did not get the backend up, with the next step. */
export function launchFailureText(
  result: Extract<LaunchResult, { ok: false }>,
  diagnosis: BackendDiagnosis | undefined,
  endpoint: string,
): string {
  const detail = result.detail ? `（${result.detail}）` : '';
  const detailEn = result.detail ? ` (${result.detail})` : '';
  switch (result.stage) {
    case 'no-docker':
      return tr(
        '这台电脑上没找到 Docker。先装 OrbStack 或 Docker Desktop，再运行后端文件夹里的启动脚本。',
        'Docker was not found on this computer. Install OrbStack or Docker Desktop, then run the start script in the backend folder.',
      );
    case 'engine':
      return tr(
        'Docker 引擎没起来。手动打开 OrbStack 或 Docker Desktop，等它显示运行中，再点一次。',
        'The Docker engine did not come up. Open OrbStack or Docker Desktop yourself, wait until it says running, then try again.',
      );
    case 'no-folder':
      return tr(
        'Docker 在运行，但没找到后端容器。在设置里填后端文件夹，或运行一次里面的启动脚本。',
        'Docker is running, but no backend container was found. Set the backend folder in settings, or run the start script in it once.',
      );
    case 'container':
      return tr(
        `后端容器没起来${detail}。在后端文件夹运行 docker compose logs 看原因。`,
        `The backend container did not start${detailEn}. Run docker compose logs in the backend folder to see why.`,
      );
    default:
      return tr(
        `容器起来了，但${faultReason(diagnosis, endpoint)}。${faultNextStep(diagnosis, endpoint, false)}`,
        `The container is up, but ${faultReason(diagnosis, endpoint)}. ${faultNextStep(diagnosis, endpoint, false)}`,
      );
  }
}
