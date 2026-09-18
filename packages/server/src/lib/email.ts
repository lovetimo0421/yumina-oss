import { Resend } from "resend";
import { env, PUBLIC_ORIGIN } from "./env.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

// Self-hosters who configure Resend set EMAIL_FROM to a sender on their own
// verified domain; the default is the hosted service's sender.
const FROM_EMAIL = process.env.EMAIL_FROM || "Yumina <noreply@yumina.io>";
const LOGO_URL = `${PUBLIC_ORIGIN}/logo.png`;
const MUSHIE_URL = `${PUBLIC_ORIGIN}/mushie-stand.png`;

/** Send an email via Resend. Logs errors but does not throw so
 *  upstream flows (signup, password reset) are never blocked by
 *  transient Resend failures. */
export async function sendEmail(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
}): Promise<boolean> {
    if (!resend) {
        console.warn("[email] RESEND_API_KEY not set — skipping email to", opts.to);
        return false;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
        let error: unknown;
        try {
            ({ error } = await resend.emails.send({
                from: FROM_EMAIL,
                to: opts.to,
                subject: opts.subject,
                html: opts.html,
                ...(opts.text && { text: opts.text }),
            }));
        } catch (cause) {
            error = cause;
        }

        if (!error) return true;

        console.error(`[email] Send attempt ${attempt}/2 failed for ${opts.to}:`, error);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
    }

    return false;
}

/** Escape HTML special characters to prevent injection in email templates. */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/* ── Email Templates ────────────────────────────────────────────── */

function baseTemplate(content: string, options?: { mascot?: boolean }) {
    const year = new Date().getFullYear();
    const showMascot = options?.mascot ?? false;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0C0C0E;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0C0C0E;">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#18181B;border-radius:24px;border:1px solid rgba(255,255,255,0.06);overflow:hidden;">

          <!-- Gold gradient bar -->
          <tr>
            <td style="height:4px;background:linear-gradient(90deg,#B8943F,#F3D361,#C9A25E,#F3D361,#B8943F);"></td>
          </tr>

          <!-- Header: Logo + wordmark -->
          <tr>
            <td align="center" style="padding:32px 40px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <img src="${LOGO_URL}" alt="Yumina" width="36" height="36" style="display:block;border:0;border-radius:8px;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:24px;font-weight:900;color:#F3D361;letter-spacing:-0.03em;">Yumina</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${showMascot ? `
          <!-- Mascot -->
          <tr>
            <td align="center" style="padding:24px 40px 0;">
              <img src="${MUSHIE_URL}" alt="" width="80" height="80" style="display:block;border:0;" />
            </td>
          </tr>
          ` : ""}

          <!-- Content -->
          <tr>
            <td style="padding:${showMascot ? "20px" : "32px"} 40px 36px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:0 40px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-top:1px solid rgba(255,255,255,0.05);padding-top:20px;text-align:center;">
                    <p style="margin:0 0 6px;font-size:11px;color:#6B6862;line-height:1.5;">
                      &copy; ${year} Yumina &middot; AI Interactive Fiction
                    </p>
                    <p style="margin:0;font-size:11px;line-height:1.5;">
                      <a href="https://yumina.io" style="color:#8E8B82;text-decoration:none;">yumina.io</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Gold CTA button — table-based for max email client compatibility.
 */
function ctaButton(href: string, label: string): string {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:4px 0;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="25%" fillcolor="#C9A25E" stroke="f">
            <w:anchorlock/>
            <center style="color:#0C0C0E;font-family:sans-serif;font-size:14px;font-weight:bold;">${label}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${href}" style="display:inline-block;padding:14px 44px;background:#C9A25E;color:#0C0C0E;font-size:14px;font-weight:800;text-decoration:none;border-radius:12px;letter-spacing:0.01em;mso-hide:all;">
            ${label}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

/** Red destructive-action CTA, kept separate so ordinary auth emails stay gold. */
function dangerCtaButton(href: string, label: string): string {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:4px 0;">
          <a href="${href}" style="display:inline-block;padding:14px 36px;background:#DC2626;color:#FFFFFF;font-size:14px;font-weight:800;text-decoration:none;border-radius:12px;letter-spacing:0.01em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

export function verificationEmailText(url: string, name: string) {
    return `Welcome to Yumina, ${name}!\n\nVerify your email to get started:\n${url}\n\nDidn't sign up? Just ignore this email.`;
}

export function verificationEmailHtml(url: string, name: string) {
    const safeName = escapeHtml(name);
    return baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#EEEAE3;letter-spacing:-0.01em;text-align:center;">
        Welcome, ${safeName}!
      </h1>
      <p style="margin:0 0 28px;font-size:14px;color:#A09D95;line-height:1.7;text-align:center;">
        Your adventure is about to begin. Just one quick step &mdash; verify your email and you're in.
      </p>

      ${ctaButton(url, "Verify my email")}

      <p style="margin:24px 0 0;font-size:12px;color:#7A776F;line-height:1.6;text-align:center;">
        Or copy this link into your browser:
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#C9A25E;line-height:1.5;word-break:break-all;text-align:center;">
        ${url}
      </p>

      <p style="margin:28px 0 0;font-size:11px;color:#5C5950;line-height:1.5;text-align:center;">
        Didn't sign up for Yumina? No worries &mdash; just ignore this email.
      </p>
    `, { mascot: true });
}

export function resetPasswordEmailText(url: string, name: string) {
    return `Hi ${name},\n\nReset your Yumina password:\n${url}\n\nThis link expires in 1 hour. Didn't request this? Just ignore it.`;
}

export function resetPasswordEmailHtml(url: string, name: string) {
    const safeName = escapeHtml(name);
    return baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#EEEAE3;letter-spacing:-0.01em;text-align:center;">
        Reset your password
      </h1>
      <p style="margin:0 0 28px;font-size:14px;color:#A09D95;line-height:1.7;text-align:center;">
        Hey ${safeName}, we got your request. Tap the button below to pick a new password.
      </p>

      ${ctaButton(url, "Choose new password")}

      <p style="margin:24px 0 0;font-size:12px;color:#7A776F;line-height:1.6;text-align:center;">
        Or copy this link into your browser:
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#C9A25E;line-height:1.5;word-break:break-all;text-align:center;">
        ${url}
      </p>

      <p style="margin:28px 0 0;font-size:11px;color:#5C5950;line-height:1.5;text-align:center;">
        This link expires in 1 hour. Didn't request this? Just ignore it &mdash; your password won't change.
      </p>
    `);
}

type DeleteAccountEmailLocale = "en" | "zh" | "zh-Hant" | "ja" | "es";

type DeleteAccountEmailCopy = {
    subject: string;
    title: string;
    greeting: (name: string) => string;
    request: (name: string) => string;
    review: string;
    impact: string;
    cta: string;
    copyLink: string;
    expires: string;
    cooldown: string;
    ignored: string;
};

const DELETE_ACCOUNT_EMAIL_COPY: Record<DeleteAccountEmailLocale, DeleteAccountEmailCopy> = {
    en: {
        subject: "Confirm your Yumina account deletion",
        title: "Permanently delete your account?",
        greeting: (name) => `Hi ${name}. Open the secure page below to review the impact and complete one final confirmation.`,
        request: (name) => `Hi ${name},\n\nYou requested permanent deletion of your Yumina account.`,
        review: "Review and confirm account deletion:",
        impact: "Your profile, sign-in methods, creations, playthroughs, messages, uploads, remaining plan time, and Mushies will be deleted. Active subscriptions end immediately. Payment processors may retain billing and identity records where legally required, but they will no longer be linked to an active Yumina account. Pseudonymous security logs and limited analytics may remain for required periods, and existing cached copies may stay visible until their previous cache lifetime expires.",
        cta: "Review account deletion",
        copyLink: "Or copy this link into your browser:",
        expires: "This link expires in 1 hour.",
        cooldown: "After deletion, this email can register another account immediately through email, Google, or Discord. That recreated account cannot be deleted again until 3 days after this deletion.",
        ignored: "Didn't request this? Ignore this email and nothing will be deleted.",
    },
    zh: {
        subject: "确认注销你的 Yumina 账户",
        title: "确定要永久注销账户吗？",
        greeting: (name) => `${name}，请打开下方安全页面查看影响并完成最后一次确认。`,
        request: (name) => `${name}，你好：\n\n你申请了永久注销 Yumina 账户。`,
        review: "查看并确认账户注销：",
        impact: "你的个人资料、登录方式、创作内容、游玩记录、消息、上传文件、剩余订阅时间和 Mushies 都会被删除。有效订阅将立即终止。支付处理商可能按法律要求保留账单和身份记录，但这些记录将不再关联有效的 Yumina 账户。化名化安全日志和有限分析数据可能在必要期限内保留，已有缓存副本也可能在原缓存期限届满前继续可见。",
        cta: "查看账户注销",
        copyLink: "也可以将此链接复制到浏览器：",
        expires: "此链接将在 1 小时后失效。",
        cooldown: "删除后，此邮箱可以立即通过邮箱、Google 或 Discord 重新注册。但重新注册的账户在本次删除后的 3 天内不能再次注销。",
        ignored: "如果这不是你的操作，请忽略此邮件，你的账户不会被删除。",
    },
    "zh-Hant": {
        subject: "確認註銷你的 Yumina 賬戶",
        title: "確定要永久註銷賬戶嗎？",
        greeting: (name) => `${name}，請開啟下方安全頁面查看影響並完成最後一次確認。`,
        request: (name) => `${name}，你好：\n\n你申請了永久註銷 Yumina 賬戶。`,
        review: "查看並確認賬戶註銷：",
        impact: "你的個人資料、登入方式、創作內容、遊玩記錄、訊息、上載檔案、剩餘訂閱時間和 Mushies 都會被刪除。有效訂閱將立即終止。付款處理商可能按法律要求保留帳單和身份記錄，但這些記錄將不再連結至有效的 Yumina 賬戶。化名化安全日誌及有限分析資料可能在必要期限內保留，已有快取副本也可能在原快取期限屆滿前繼續可見。",
        cta: "查看賬戶註銷",
        copyLink: "也可以將此連結複製到瀏覽器：",
        expires: "此連結將於 1 小時後失效。",
        cooldown: "刪除後，此電郵可以立即透過電郵、Google 或 Discord 重新註冊。但重新註冊的賬戶在本次刪除後的 3 天內不能再次註銷。",
        ignored: "如果這不是你的操作，請忽略此電郵，你的賬戶不會被刪除。",
    },
    ja: {
        subject: "Yuminaアカウント削除の確認",
        title: "アカウントを完全に削除しますか？",
        greeting: (name) => `${name}さん、下の安全なページを開き、影響を確認して最後の確認を完了してください。`,
        request: (name) => `${name}さん\n\nYuminaアカウントの完全削除がリクエストされました。`,
        review: "アカウント削除を確認する：",
        impact: "プロフィール、ログイン方法、作成したコンテンツ、プレイ履歴、メッセージ、アップロード、残りのプラン期間、Mushiesが削除されます。有効なサブスクリプションは直ちに終了します。決済事業者は法令上必要な請求情報や本人確認記録を保持する場合がありますが、有効なYuminaアカウントとの関連付けは解除されます。仮名化されたセキュリティログと限定的な分析情報は必要な期間保持され、既存のキャッシュは以前の有効期限まで表示される場合があります。",
        cta: "アカウント削除を確認",
        copyLink: "または、このリンクをブラウザにコピーしてください：",
        expires: "このリンクは1時間で期限切れになります。",
        cooldown: "削除後、このメールアドレスですぐにメール、Google、Discordから再登録できます。ただし、再登録したアカウントは今回の削除から3日間は再度削除できません。",
        ignored: "心当たりがない場合は、このメールを無視してください。アカウントは削除されません。",
    },
    es: {
        subject: "Confirma la eliminación de tu cuenta de Yumina",
        title: "¿Eliminar tu cuenta permanentemente?",
        greeting: (name) => `Hola, ${name}. Abre la página segura para revisar las consecuencias y completar una última confirmación.`,
        request: (name) => `Hola, ${name}:\n\nSolicitaste eliminar permanentemente tu cuenta de Yumina.`,
        review: "Revisar y confirmar la eliminación de la cuenta:",
        impact: "Se eliminarán tu perfil, métodos de inicio de sesión, creaciones, partidas, mensajes, archivos subidos, tiempo restante del plan y Mushies. Las suscripciones activas finalizarán de inmediato. Los procesadores de pago pueden conservar registros de facturación e identidad cuando la ley lo exija, pero dejarán de estar vinculados a una cuenta activa de Yumina. Los registros de seguridad seudónimos y análisis limitados pueden conservarse durante los plazos necesarios, y las copias en caché existentes pueden seguir visibles hasta que caduquen.",
        cta: "Revisar la eliminación",
        copyLink: "También puedes copiar este enlace en tu navegador:",
        expires: "Este enlace caduca en 1 hora.",
        cooldown: "Después de eliminarla, este correo puede registrarse de nuevo de inmediato mediante correo, Google o Discord. Sin embargo, la cuenta nueva no podrá eliminarse hasta que hayan pasado 3 días desde esta eliminación.",
        ignored: "Si no solicitaste esto, ignora el correo y no se eliminará nada.",
    },
};

export function normalizeDeleteAccountEmailLocale(locale?: string | null): DeleteAccountEmailLocale {
    const normalized = locale?.trim().toLowerCase() ?? "";
    if (/^zh-(hant|tw|hk|mo)/.test(normalized)) return "zh-Hant";
    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("ja")) return "ja";
    if (normalized.startsWith("es")) return "es";
    return "en";
}

function deleteAccountEmailCopy(locale?: string | null): DeleteAccountEmailCopy {
    return DELETE_ACCOUNT_EMAIL_COPY[normalizeDeleteAccountEmailLocale(locale)];
}

export function deleteAccountEmailSubject(locale?: string | null): string {
    return deleteAccountEmailCopy(locale).subject;
}

export function deleteAccountEmailText(url: string, name: string, locale?: string | null) {
    const copy = deleteAccountEmailCopy(locale);
    return `${copy.request(name)}\n\n${copy.review}\n${url}\n\n${copy.expires} ${copy.impact}\n\n${copy.cooldown}\n\n${copy.ignored}`;
}

export function deleteAccountEmailHtml(url: string, name: string, locale?: string | null) {
    const copy = deleteAccountEmailCopy(locale);
    const safeName = escapeHtml(name);
    return baseTemplate(`
      <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#FCA5A5;letter-spacing:-0.01em;text-align:center;">
        ${copy.title}
      </h1>
      <p style="margin:0 0 20px;font-size:14px;color:#A09D95;line-height:1.7;text-align:center;">
        ${copy.greeting(safeName)}
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;background:#2A1517;border:1px solid rgba(248,113,113,0.25);border-radius:12px;">
        <tr>
          <td style="padding:16px 18px;font-size:12px;color:#FECACA;line-height:1.7;">
            ${copy.impact}
            <br><br><strong>${copy.cooldown}</strong>
          </td>
        </tr>
      </table>

      ${dangerCtaButton(url, copy.cta)}

      <p style="margin:24px 0 0;font-size:12px;color:#7A776F;line-height:1.6;text-align:center;">
        ${copy.copyLink}
      </p>
      <p style="margin:6px 0 0;font-size:11px;color:#F87171;line-height:1.5;word-break:break-all;text-align:center;">
        ${url}
      </p>

      <p style="margin:28px 0 0;font-size:11px;color:#5C5950;line-height:1.5;text-align:center;">
        ${copy.expires} ${copy.ignored}
      </p>
    `);
}
