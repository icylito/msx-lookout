// Shared email sending + one email-safe HTML shell for all four send sites
// (digest, listing heads-up, price alert, ops-failure). Ported from the design in
// `new ui updates/MSX Lookout Digest Email.html` — table layout, inline styles, no
// flexbox/JS/<style> reliance, so Gmail/Outlook render it the same. Each type fills
// the body; the masthead + footer + palette are shared.
//
// Deployed like msx-client.ts: each Edge Function directory that sends mail keeps a
// 4-line `./email.ts` stub re-exporting `../../../email.ts` so local type-checking resolves.

// clay-on-cream palette from the design system
export const C = {
  page: "#efeade",
  card: "#f5f4ee",
  inset: "#efeade",
  clay: "#b85c3e",
  ink: "#1f1e1d",
  body: "#55534e",
  faint: "#8a8778",
  rule: "#dedbd0",
  rowRule: "#e6e3d8",
  green: "#0ca30c",
  red: "#d03b3b",
};

const SANS = "Arial,Helvetica,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

// Every outbound mail uses the address saved in Settings. Blank/wiped
// digest_email means skip the send. DIGEST_EMAIL / MAINTAINER_EMAIL are not
// read — those were a testing-era fallback and must not receive shipped mail.
export function resolveSavedRecipient(digestEmail?: string | null): string | null {
  const saved = (digestEmail ?? "").trim();
  return saved || null;
}

// Compact masthead date: "2026-09-06" -> "SUN 6 SEP" (shorter than the ISO string, so it
// doesn't crowd the title on a narrow phone). Anything not in ISO yyyy-mm-dd is shown as-is.
function fmtMastDate(s?: string): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${days[d.getUTCDay()]} ${+m[3]} ${months[+m[2] - 1]}`;
}

type ShellOpts = {
  label: string; // small clay kicker, e.g. "DAILY DIGEST"
  dateText?: string; // masthead date; ISO yyyy-mm-dd is auto-formatted to "SUN 6 SEP"
  bodyHtml: string; // the type-specific content
  action?: { text: string; href: string }; // optional outlined pill
  footerNote?: string; // optional extra line above the standard footer
};

// The shared shell: cream page, 600px card, clay-monogram masthead, body slot, footer.
export function emailShell(o: ShellOpts): string {
  const px = `padding-left:40px;padding-right:40px`;
  const action = o.action
    ? `<tr><td align="right" style="padding:34px 40px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
          <td bgcolor="${C.card}" style="border:1px solid ${C.clay};border-radius:999px;padding:9px 18px;font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:1.3px;line-height:12px;">
            <a href="${o.action.href}" style="color:${C.clay};text-decoration:none;display:block;">${o.action.text}</a>
          </td></tr></tbody></table>
      </td></tr>`
    : "";
  const extraNote = o.footerNote
    ? `<div style="font-family:${SANS};font-size:11px;line-height:19px;color:${C.body};padding-top:20px;">${o.footerNote}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>MSX Lookout</title>
<!--[if mso]><style>body,table,td,a{font-family:Arial,Helvetica,sans-serif !important}</style><![endif]-->
<style>
  /* Phone: drop the masthead date onto its own line so it stops crowding the title.
     Progressive enhancement — clients that ignore this keep the desktop row layout,
     which the compact date + left gap already keep readable. */
  @media only screen and (max-width:480px) {
    .mast-main { display:block !important; width:100% !important; }
    .mast-date { display:block !important; width:100% !important; text-align:left !important; padding:12px 0 0 0 !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.page};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${C.page};">
<tbody><tr><td align="center" style="padding:28px 12px 48px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:${C.card};">

  <tbody><tr><td style="${px};padding-top:34px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody><tr>
      <td class="mast-main" style="vertical-align:middle;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
          <td width="30" style="width:30px;padding-right:11px;vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
              <td width="30" height="30" align="center" valign="middle" bgcolor="${C.clay}" style="width:30px;height:30px;border-radius:9px;font-family:${SERIF};font-size:16px;color:${C.card};">M</td>
            </tr></tbody></table>
          </td>
          <td style="vertical-align:middle;">
            <div style="font-family:${SANS};font-size:9px;font-weight:bold;letter-spacing:1.4px;color:${C.faint};padding-bottom:3px;">${o.label}</div>
            <div style="font-family:${SERIF};font-size:15px;color:${C.ink};white-space:nowrap;">MSX Lookout</div>
          </td>
        </tr></tbody></table>
      </td>
      <td class="mast-date" align="right" style="vertical-align:middle;padding-left:14px;white-space:nowrap;font-family:${SANS};font-size:9px;font-weight:bold;letter-spacing:1.3px;color:${C.faint};">${fmtMastDate(o.dateText)}</td>
    </tr></tbody></table>
  </td></tr>

  <tr><td style="${px};padding-top:36px;">${o.bodyHtml}</td></tr>
  ${action}

  <tr><td style="${px};padding-top:34px;padding-bottom:36px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tbody><tr><td height="1" style="height:1px;background-color:${C.rule};font-size:1px;line-height:1px;">&nbsp;</td></tr></tbody></table>
    ${extraNote}
    <div style="font-family:${SANS};font-size:10.5px;line-height:18px;color:${C.body};padding-top:12px;">
      MSX Lookout · Muscat, Oman<br>Prices are as published by the exchange and may be revised. Change or turn off emails in the app's Settings.
    </div>
  </td></tr>

</tbody></table>
</td></tr>
</tbody></table>
</body></html>`;
}

type Attachment = { filename: string; content: string };

// The one Resend call. Returns Resend's message id on success; throws on a non-2xx so the
// caller can log/report. `to` must already be resolved (see resolveSavedRecipient) and non-null.
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: Attachment[];
}): Promise<string> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not configured");
  // `from` must be an address on a domain you've verified in Resend. Until you verify one,
  // the default `onboarding@resend.dev` works but Resend only delivers to your own account
  // email (test mode). Set the RESEND_FROM secret to e.g. "MSX Lookout <noreply@adlresearchoman.com>"
  // once the domain verifies. Format: "Display Name <address@verified-domain>".
  const from = Deno.env.get("RESEND_FROM") ?? "MSX Lookout <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body.id ?? "";
}
