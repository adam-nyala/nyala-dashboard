// alert-mailer v2 — sends queued alert_outbox rows to SUBSCRIBERS from
// notification_prefs (Decision 8). Nothing is hardcoded as the only recipient:
// users subscribe themselves per kind. Critical missing-contract kinds fall
// back to the addresses in integration_secrets alert_default_recipients
// (comma list) when a kind has no subscriber at all. (Nyala: no addresses
// are hard-coded; OmniSure's defaults were removed.)
//
// GATED: sends nothing unless integration_secrets email_alerts_enabled='true'.
// Sender identity comes from the RESEND_FROM secret (a Resend-verified
// address) and is never invented.
//
// POST body:
//   {}                → process up to 20 queued rows (no-op while gated)
//   { test: true }    → ONE labeled test email to the default recipients
//                       (works while gated — the required delivery test)
//   { preview: true } → list queued rows + resolved recipients, no sending

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
let DEFAULTS: string[] = [];   // loaded from integration_secrets alert_default_recipients
// outbox kind → preference kind(s); an intro with unverified terms also goes
// to missing-terms subscribers (one email, union of recipients, deduped)
const KIND_PREFS: Record<string, string[]> = {
  campaign_introduced: ["new_campaigns"],
  missing_terms: ["missing_terms"],
  golive_missing_docs: ["missing_docs"],
  verified_golive: ["verified_golive"],
};
const CRITICAL = new Set(["golive_missing_docs", "missing_terms"]);

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function db(method: string, path: string, body?: unknown, prefer?: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: prefer ?? "return=minimal" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
async function dbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) throw new Error(`DB GET ${path.split("?")[0]}: ${r.status}`);
  return r.json();
}
async function sendEmail(from: string, to: string[], subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY secret is not set");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const kv = (l: string, v: unknown) => `<tr><td style="padding:3px 10px 3px 0;color:#667;font-size:13px">${l}</td><td style="padding:3px 0;font-size:13px"><b>${esc(v ?? "—")}</b></td></tr>`;
function compose(row: any): { subject: string; html: string; alsoMissingTerms: boolean } {
  const p = row.payload || {};
  const links = p.links || {};
  const linkHtml = Object.entries(links).filter(([, u]) => u).map(([k, u]) => `<a href="${esc(u)}">${esc(k)}</a>`).join(" · ");
  const foot = `<p style="font-size:11px;color:#999">Manage these alerts under Notifications in the dashboard sidebar.</p>`;
  if (row.kind === "campaign_introduced") {
    const unverified = !p.payment_terms || p.payment_terms === "Not found" || /not verified|unknown/i.test(String(p.terms_provenance || ""));
    return {
      subject: `New campaign introduced: ${p.account || "?"} / ${p.campaign || "?"}${unverified ? " (verify payment terms)" : ""}`,
      html: `<p>A new ${esc(p.side)} campaign appeared. Verify its payment terms against the signed agreement.</p>
<table>${kv("Account", p.account)}${kv("Side", p.side)}${kv("Campaign", p.campaign)}${kv("Vertical", p.vertical)}${kv("Rate", p.rate != null ? "$" + p.rate : "Not found")}${kv("IO status", p.io_status)}${kv("Payment terms", p.payment_terms)}${kv("Provenance", p.terms_provenance)}</table>
<p style="font-size:12px;color:#866">A configured or synced value is NOT a verified contractual term.</p><p>${linkHtml}</p>${foot}`,
      alsoMissingTerms: unverified,
    };
  }
  if (row.kind === "missing_terms") {
    return {
      subject: `Payment terms need verification: ${p.campaign || "?"}`,
      html: `<p>${esc(p.note || "A campaign has no verified payment terms.")}</p>
<table>${kv("Campaign", p.campaign)}${kv("Side", p.side)}</table><p>${linkHtml}</p>${foot}`,
      alsoMissingTerms: false,
    };
  }
  if (row.kind === "golive_missing_docs") {
    return {
      subject: `${p.classification || "Missing documents"}: ${p.account || "?"} / ${p.campaign || "?"} went live`,
      html: `<p>A campaign was verified live (calls are arriving), but an executed document could not be found or confidently associated in HubSpot.</p>
<table>${kv("Classification", p.classification)}${kv("Account", p.account)}${kv("Campaign", p.campaign)}${kv("Side", p.side)}${kv("First detected live", p.first_detected_live)}</table>
<p style="font-size:12px;color:#866">"Signed" as a text status is not sufficient without an executed document. The flag stays visible in Completed History until documents are matched.</p><p>${linkHtml}</p>${foot}`,
      alsoMissingTerms: false,
    };
  }
  if (row.kind === "verified_golive") {
    return {
      subject: `Verified go-live: ${p.account || "?"} / ${p.campaign || "?"}`,
      html: `<p>A campaign was verified live (buyer: a current DID with attributed calls; publisher: a CallGrid lane with observed calls) and its onboarding was completed automatically.</p>
<table>${kv("Account", p.account)}${kv("Campaign", p.campaign)}${kv("Side", p.side)}${kv("First call", p.first_call_at)}${kv("First detected live", p.first_detected_live)}</table><p>${linkHtml}</p>${foot}`,
      alsoMissingTerms: false,
    };
  }
  return { subject: `Dashboard alert: ${row.kind}`, html: `<pre>${esc(JSON.stringify(p, null, 2))}</pre>${foot}`, alsoMissingTerms: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* fine */ }

  try {
    const secrets = await dbGet("integration_secrets?key=in.(email_alerts_enabled,resend_from,alert_default_recipients)&select=key,value");
    DEFAULTS = String(secrets.find((s: any) => s.key === "alert_default_recipients")?.value || "").split(",").map((x: string) => x.trim()).filter(Boolean);
    const enabled = secrets.find((s: any) => s.key === "email_alerts_enabled")?.value === "true";
    const from = Deno.env.get("RESEND_FROM") || secrets.find((s: any) => s.key === "resend_from")?.value;
    const prefs = await dbGet("notification_prefs?enabled=eq.true&select=email,kind").catch(() => []);
    const subsOf = (kinds: string[]): string[] => [...new Set<string>(prefs.filter((p: any) => kinds.includes(p.kind)).map((p: any) => String(p.email)))];
    const recipientsFor = (row: any) => {
      const { alsoMissingTerms } = compose(row);
      const kinds = [...(KIND_PREFS[row.kind] || [])];
      if (alsoMissingTerms) kinds.push("missing_terms");
      let to = subsOf(kinds);
      if (!to.length && CRITICAL.has(row.kind)) to = DEFAULTS; // critical alerts always reach someone
      return to;
    };

    if (body.preview === true) {
      const rows = await dbGet("alert_outbox?status=eq.queued&select=id,kind,dedupe_key,payload,created_at&order=created_at.asc&limit=50");
      return json({ enabled, queued: rows.length, rows: rows.map((r: any) => ({ kind: r.kind, key: r.dedupe_key, recipients: recipientsFor(r) })) });
    }
    if (body.test === true) {
      if (!DEFAULTS.length) return json({ error: "No test recipients — add integration_secrets alert_default_recipients (comma-separated emails) first." }, 400);
      if (!from) return json({ error: "No sender configured — set the RESEND_FROM secret (or integration_secrets resend_from) to a Resend-verified address. A sender identity is never invented." }, 400);
      const r = await sendEmail(from, DEFAULTS, "TEST — Nyala Labs dashboard alert delivery check",
        `<p>This is a delivery test of the dashboard's onboarding alerts. No production alerts are enabled${enabled ? "" : " yet"}. Subscriptions are managed per user under Notifications in the dashboard sidebar.</p>`);
      return json({ ok: true, test_sent_to: DEFAULTS, resend_id: r?.id ?? null });
    }
    if (!enabled) {
      const n = await dbGet("alert_outbox?status=eq.queued&select=id");
      return json({ enabled: false, queued: n.length, note: "email_alerts_enabled is not 'true' — nothing sent, queue preserved" });
    }
    if (!from) return json({ error: "No sender configured — set the RESEND_FROM secret (or integration_secrets resend_from)." }, 400);

    const rows = await dbGet("alert_outbox?status=eq.queued&select=*&order=created_at.asc&limit=20");
    const results: any[] = [];
    for (const row of rows) {
      try {
        const to = recipientsFor(row);
        if (!to.length) {
          await db("PATCH", `alert_outbox?id=eq.${row.id}&status=eq.queued`, { status: "suppressed", last_error: "no subscribers for this kind" });
          results.push({ key: row.dedupe_key, suppressed: "no subscribers" });
          continue;
        }
        const { subject, html } = compose(row);
        const r = await sendEmail(from, to, subject, html);
        await db("PATCH", `alert_outbox?id=eq.${row.id}&status=eq.queued`, {
          status: "sent", sent_at: new Date().toISOString(), attempts: (row.attempts || 0) + 1,
          payload: { ...row.payload, sent_to: to },
        });
        results.push({ key: row.dedupe_key, sent: true, to, resend_id: r?.id ?? null });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        await db("PATCH", `alert_outbox?id=eq.${row.id}`, { attempts: (row.attempts || 0) + 1, last_error: msg.slice(0, 300) });
        results.push({ key: row.dedupe_key, sent: false, error: msg });
      }
    }
    return json({ enabled: true, processed: results.length, results });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});