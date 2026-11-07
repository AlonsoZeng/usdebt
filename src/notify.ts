/**
 * 通知出口 —— DOR-2：Resend 发到账号注册邮箱（onboarding@resend.dev 免域名）。
 *
 * 设计约束：notify() 永不抛错，避免掩盖真正的业务异常（沿用 v0 骨架的约定）。
 * 通道未配置时返回 'skipped' 并打日志；/api/health 会暴露这个状态，
 * 这样「没配告警」不会被误当成「一切正常」。
 *
 * 备用通道 NOTIFY_WEBHOOK：任意接受 { text } JSON 的 webhook
 * （例如国内可达的企业微信机器人），方便日后不依赖 Resend 账号。
 */

export interface NotifyEnv {
  RESEND_API_KEY?: string;
  NOTIFY_EMAIL?: string;
  NOTIFY_WEBHOOK?: string;
}

export type NotifyStatus = 'sent' | 'skipped' | 'partial';

export async function notify(env: NotifyEnv, text: string): Promise<NotifyStatus> {
  const jobs: Promise<boolean>[] = [];

  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    jobs.push(
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: 'daily-tracker <onboarding@resend.dev>',
          to: [env.NOTIFY_EMAIL],
          subject: '[daily-tracker] run report',
          text
        })
      })
        .then(async (res) => {
          if (!res.ok) console.error('[notify] resend failed', res.status, await res.text());
          return res.ok;
        })
        .catch((e) => { console.error('[notify] resend error', String(e)); return false; })
    );
  }

  if (env.NOTIFY_WEBHOOK) {
    jobs.push(
      fetch(env.NOTIFY_WEBHOOK, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } })
      })
        .then((res) => {
          if (!res.ok) console.error('[notify] webhook failed', res.status);
          return res.ok;
        })
        .catch((e) => { console.error('[notify] webhook error', String(e)); return false; })
    );
  }

  if (jobs.length === 0) {
    console.log('[notify skipped] no channel configured:', text);
    return 'skipped';
  }
  const results = await Promise.all(jobs);
  return results.every(Boolean) ? 'sent' : 'partial';
}
