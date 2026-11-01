/**
 * Why a video gave no transcript, and the one next step that can work. A failed link has two
 * routes to a transcript: the platform's own subtitles, and speech-to-text on the audio. When
 * the cause is known, retrying the same route is pointless, so the card offers what is left
 * instead: wait, log in, set up speech-to-text, or paste a transcript into the same job.
 */

export type SourceProblem =
  | 'no-subtitles'
  | 'speech-off'
  | 'login'
  | 'rate-limit'
  | 'blocked'
  | 'backend';

export interface SourceDiagnosis {
  problem: SourceProblem;
  /** What happened with the platform's own subtitles. */
  subtitles: 'missing' | 'login' | 'rate-limit' | 'blocked' | 'unknown';
  /** Whether the backend has a speech-to-text key; unknown until the quick check answers. */
  speech: 'off' | 'on' | 'unknown';
  /** Running the same job again now would fail the same way. */
  retryUseless: boolean;
  /** A pasted transcript can finish this job. */
  canPaste: boolean;
}

const RATE_LIMIT =
  /\b429\b|too many requests|rate.?limit|请求过于频繁|限流|sign in to confirm|不是机器人|not a bot/;
const BLOCKED =
  /抖音目前读不到|小红书目前读不到|can't be read at the moment|\[douyin\].*fresh cookies|\[xiaohongshu\].*no video formats/;
const LOGIN =
  /b 站拒绝|bilibili refused|bilibili.*412|cookie|登录状态|login expired|log in|需要验证|扫码|验证码/;
const SPEECH =
  /语音转写|speech.?to.?text|audio\/transcriptions|transcription failed|siliconflow|sensevoice/;
const NO_SUBTITLES =
  /无字幕|没有字幕|未找到字幕|字幕不可用|no subtitles?|no captions?|subtitles? not (?:found|available)|transcript (?:not available|unavailable)|没有文稿/;
const BACKEND =
  /econnrefused|enotfound|failed to fetch|fetch failed|无法连接|连接失败|cannot reach the backend/;

export function diagnoseSource(
  error: string,
  options: { isLink: boolean; speechConfigured?: boolean },
): SourceDiagnosis | null {
  const text = error.toLowerCase();
  const speech: SourceDiagnosis['speech'] =
    options.speechConfigured === undefined ? 'unknown' : options.speechConfigured ? 'on' : 'off';
  const diagnosis = (
    problem: SourceProblem,
    subtitles: SourceDiagnosis['subtitles'],
    retryUseless: boolean,
  ): SourceDiagnosis => ({
    problem,
    subtitles,
    speech,
    retryUseless,
    canPaste: options.isLink && problem !== 'backend',
  });

  if (BACKEND.test(text)) return diagnosis('backend', 'unknown', false);
  if (!options.isLink) {
    return SPEECH.test(text)
      ? { ...diagnosis('speech-off', 'unknown', true), speech: 'off' }
      : null;
  }
  if (BLOCKED.test(text)) return diagnosis('blocked', 'blocked', true);
  if (RATE_LIMIT.test(text)) return diagnosis('rate-limit', 'rate-limit', false);
  if (LOGIN.test(text)) return diagnosis('login', 'login', false);
  if (SPEECH.test(text)) return { ...diagnosis('speech-off', 'missing', true), speech: 'off' };
  if (NO_SUBTITLES.test(text)) {
    return diagnosis(
      options.speechConfigured === false ? 'speech-off' : 'no-subtitles',
      'missing',
      true,
    );
  }
  return null;
}
