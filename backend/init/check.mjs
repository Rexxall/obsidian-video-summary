// `vs-backend check`: ask the running workflow for a deep health report and print it in Chinese.
// Runs inside the container so the host needs nothing besides Docker.
import fs from 'node:fs';

import { parseEnv } from './configure.mjs';

const env = parseEnv(fs.readFileSync('/run/video-summary/config.env', 'utf8'));
const response = await fetch('http://127.0.0.1:5678/webhook/obsidian-video-summary', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Video-Summary-Token': String(env.VS_WEBHOOK_TOKEN || ''),
  },
  body: JSON.stringify({ name: 'test', metadata: { check: 'deep' } }),
  signal: AbortSignal.timeout(120000),
});
const text = await response.text();
let report;
try {
  report = JSON.parse(text);
} catch {
  console.log(`✗ 后端没有返回检查结果（HTTP ${response.status}）：${text.slice(0, 200)}`);
  process.exit(1);
}
const backend = report.backend || {};
const line = (ok, message) => console.log(`${ok ? '✓' : '✗'} ${message}`);
const service = (part, label) => {
  if (!part?.configured) return line(false, `${label} ${part?.model || ''}：.env 里还没填密钥`);
  if (part.ok === false) {
    const reason = /payment required|\b402\b|balance|余额/i.test(part.error)
      ? '账户余额不足。硅基流动余额为 0 时连免费模型也会拒绝，充值一两元后再检查'
      : /\b40[13]\b|authorization failed|unauthori[sz]ed/i.test(part.error)
        ? '服务商不认这个密钥，运行 vs-backend keys 重新输入'
        : part.error;
    return line(false, `${label} ${part.model} @ ${part.host}：${reason}`);
  }
  if (part.modelListed === false) {
    return line(false, `${label} ${part.model}：密钥可用，但服务商的模型列表里没有这个模型名`);
  }
  return line(true, `${label} ${part.model} @ ${part.host}`);
};
line(true, `工作流 ${report.workflow?.version || '?'}`);
line(
  Boolean(backend.tools?.ytDlp && backend.tools?.ffmpeg),
  `yt-dlp ${backend.tools?.ytDlp || '缺失'}，ffmpeg ${backend.tools?.ffmpeg ? '可用' : '缺失'}`,
);
service(backend.chat, '模型');
service(backend.speech, '语音转写');
line(
  Boolean(backend.cookies?.bilibili?.loggedIn),
  `B 站登录 cookie ${backend.cookies?.bilibili?.loggedIn ? '已导入' : '未导入（可选，导入后能用 B 站 AI 字幕）'}`,
);
