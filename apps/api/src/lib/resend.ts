/**
 * Resend 寄信的唯一呼叫點。所有要寄 email 的地方（通知投遞、帳號邀請信、
 * 重設密碼信）都走 `sendMail`，之後換供應商只改這一個檔。
 *
 * `RESEND_API_KEY` 未設 → `isMailConfigured()` 為 false；呼叫端據此改走
 * dryRun（不寄信、把連結回給 HR 手動轉交），而不是直接失敗。
 * `NOTIFICATION_EMAIL_FROM` 缺漏則視為設定錯誤，`sendMail` 會 throw。
 */

export interface MailInput {
  to: string | string[]
  subject: string
  text: string
  html?: string
}

export function isMailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY
}

export async function sendMail({ to, subject, text, html }: MailInput): Promise<{ id: string | null }> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.NOTIFICATION_EMAIL_FROM
  if (!apiKey || !from) throw new Error("RESEND_API_KEY or NOTIFICATION_EMAIL_FROM missing")

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text, ...(html ? { html } : {}) }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Resend ${response.status}: ${body.slice(0, 300)}`)
  }
  const body = (await response.json().catch(() => null)) as { id?: string } | null
  return { id: body?.id ?? null }
}
