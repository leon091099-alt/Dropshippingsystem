import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

type Content = HtmlEscapedString | Promise<HtmlEscapedString>;

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--line:#e3e2dd;--accent:#1f4e79;--ok:#2e7d32;--warn:#b26a00;--bad:#b3261e}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--card);border-bottom:1px solid var(--line);padding:12px 24px;display:flex;gap:24px;align-items:center}
header b{font-size:16px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;background:#eee}
.s-accepted,.s-shipped{background:#e6f2e7;color:var(--ok)}.s-on_hold,.s-cancel_requested{background:#fdf0dc;color:var(--warn)}
.s-error,.s-rejected{background:#fbe5e3;color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
form.inline{display:inline}button,.btn{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary,.btn.secondary{background:#fff;color:var(--accent)}button.danger{background:#fff;color:var(--bad);border-color:var(--bad)}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 3px}input,select,textarea{font:inherit;width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:#fff}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.row{grid-template-columns:1fr}}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.note{color:var(--muted);font-size:13px}.flash{padding:10px 14px;border-radius:6px;margin-bottom:16px;background:#e8f0f8;border:1px solid #c5d7ea}
.flash.bad{background:#fbe5e3;border-color:#f0c2bd}ul.plain{margin:4px 0;padding-left:18px}
`;

export function layout(title: string, body: Content, nav?: Content) {
  return html`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · PearlRhine Dropship</title><style>${raw(CSS)}</style></head>
<body><header><b>PearlRhine Dropship</b>${nav ?? ''}</header><main>${body}</main></body></html>`;
}

export const statusBadge = (s: string) => {
  const labels: Record<string, string> = {
    on_hold: 'Prüfung', accepted: 'angenommen', shipped: 'versendet', rejected: 'abgelehnt', error: 'Fehler',
    cancel_requested: 'Storno angefragt', cancelled: 'storniert', returned: 'retourniert',
  };
  return html`<span class="badge s-${s}">${labels[s] ?? s}</span>`;
};

export const trackingCell = (t: { company: string | null; number: string | null; url: string | null }[]) =>
  t.length ? t.map((x) => (x.url ? html`<a href="${x.url}" target="_blank" rel="noopener">${x.company ?? ''} ${x.number ?? ''}</a><br>` : html`${x.company ?? ''} ${x.number ?? ''}<br>`)) : '–';
