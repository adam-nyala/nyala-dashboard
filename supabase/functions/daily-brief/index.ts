// daily-brief v1 — the 7 AM morning brief. Emails a per-buyer and
// per-publisher scoreboard for YESTERDAY to the Configuration →
// Notifications recipients (toggle column: daily_brief), compared
// like-for-like against the SAME WEEKDAY last week, plus a week-to-date
// "needs attention" bullet list. Red / yellow / green flag and one
// suggested action per row — the format from the call-floor action plan.
//
// Data: callgrid_calls (billable rule matches the dashboard) joined with
// call_analysis (Kaliper AI: sales heard on the call, dead air, QC
// critical fails — the overnight bucket has normally finished by 7 AM).
//
// Scheduling: cron fires at 11:07 and 12:07 UTC daily; the function only
// sends when it is the 7 AM hour in ET and it hasn't already sent for the
// date (state key daily_brief_last_date in ping_sync_state), so daylight
// saving never double-sends or skips.
//
// POST body (optional):
//   {}                  → normal: send only in the 7 AM ET hour, once per day
//   { force: true }     → send now regardless of hour (manual run)
//   { dry_run: true }   → build everything, send nothing, return the HTML
//   { background: true }→ reply at once, finish via EdgeRuntime.waitUntil
//                         (what the cron sends; survives pg_net's 5s hangup)

const ET = "America/New_York";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
async function sbFetch(url: string, opts: RequestInit): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < 3; i++) {
    last = await fetch(url, opts);
    if (last.ok || ![401, 408, 429, 500, 502, 503, 504].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 350 * (i + 1)));
  }
  return last!;
}
async function db(method: string, path: string, body?: unknown, prefer?: string) {
  const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json", Prefer: prefer ?? "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
async function dbGet(path: string): Promise<any[]> {
  const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!r.ok) throw new Error(`DB GET ${path.split("?")[0]}: ${r.status}`);
  return r.json();
}
async function logEvent(status: "ok" | "error", event: string, detail?: string) {
  try {
    await db("POST", "integration_log", [{
      system: "alerts", direction: "internal", event, status,
      detail: detail ? String(detail).slice(0, 800) : null,
    }]);
  } catch (_e) { /* best-effort */ }
}
function etNow() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  let hour = Number(g("hour")); if (hour === 24) hour = 0;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour };
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isBill = (c: any) => c.billable != null ? !!c.billable : (Number(c.revenue || 0) > 0);
const isConn = (c: any) => c.connected != null ? !!c.connected : (Number(c.call_length_seconds || 0) > 0 || Number(c.revenue || 0) > 0);
const money = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
const pc = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`;

async function callsOn(dates: string[]): Promise<any[]> {
  const out: any[] = [];
  for (const d of dates) {
    for (let off = 0; off < 20000; off += 1000) {
      const page = await dbGet(`callgrid_calls?date=eq.${d}&select=inbound_call_id,date,publisher_name,target_name,campaign_name,connected,billable,call_length_seconds,revenue,payout&limit=1000&offset=${off}`);
      out.push(...page);
      if (page.length < 1000) break;
    }
  }
  return out;
}
async function analysisFor(ids: string[]): Promise<Map<string, any>> {
  const m = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map((x) => `"${x}"`).join(",");
    try {
      const got = await dbGet(`call_analysis?inbound_call_id=in.(${chunk})&status=eq.ANALYSED&select=inbound_call_id,disposition,conversion,qc_crit_pass`);
      for (const g of got) m.set(g.inbound_call_id, g);
    } catch (_e) { /* fine */ }
  }
  return m;
}

type Row = {
  name: string; n: number; conn: number; unans: number; cut: number; bill: number;
  rev: number; pay: number; aiSales: number; dead: number; aiN: number; crit: number;
  prevRev: number;
};
function scoreboard(calls: any[], prev: any[], ai: Map<string, any>, keyF: (c: any) => string): Row[] {
  const m = new Map<string, Row>();
  const get = (k: string) => {
    let r = m.get(k);
    if (!r) { r = { name: k, n: 0, conn: 0, unans: 0, cut: 0, bill: 0, rev: 0, pay: 0, aiSales: 0, dead: 0, aiN: 0, crit: 0, prevRev: 0 }; m.set(k, r); }
    return r;
  };
  for (const c of calls) {
    const k = keyF(c); if (!k) continue;
    const r = get(k); r.n++;
    const cn = isConn(c), b = isBill(c);
    if (cn) r.conn++; else r.unans++;
    if (cn && !b) r.cut++;
    if (b) r.bill++;
    r.rev += Number(c.revenue || 0); r.pay += Number(c.payout || 0);
    const a = ai.get(c.inbound_call_id);
    if (a) {
      r.aiN++;
      if (a.conversion === true) r.aiSales++;
      if (/^dead air$/i.test(String(a.disposition || "").trim())) r.dead++;
      if (a.qc_crit_pass === false) r.crit++;
    }
  }
  for (const c of prev) {
    const k = keyF(c); if (!k || !m.has(k)) continue;
    m.get(k)!.prevRev += Number(c.revenue || 0);
  }
  return [...m.values()].filter((r) => r.rev > 0 || r.n >= 10).sort((a, b) => b.rev - a.rev);
}
function buyerFlag(r: Row): [string, string] {
  const ur = r.n ? r.unans / r.n : 0, cr = r.conn ? r.cut / r.conn : 0;
  if (r.rev > 0 && r.rev - r.pay < 0) return ["red", "Margin negative. Set a floor or pause."];
  if (ur >= 0.2 && r.unans >= 10) return ["red", "Ask for peak-hour staffing; roll unanswered to next buyer."];
  if (cr >= 0.35 && r.cut >= 10) return ["yellow", "Calls cut before billing mark. Pull clips; ask for credit."];
  if (ur >= 0.1 && r.unans >= 10) return ["yellow", "Watch unanswered; confirm staffed hours."];
  return ["green", "Healthy."];
}
function pubFlag(r: Row): [string, string] {
  const connR = r.n ? r.conn / r.n : 1, dar = r.aiN >= 10 ? r.dead / r.aiN : null;
  if (dar != null && dar >= 0.25) return ["red", "Send dead-air list; set a threshold."];
  if (connR < 0.55 && r.n >= 30) return ["red", "Low connect rate. Check routing and hours."];
  if (r.rev > 0 && r.rev - r.pay < 0) return ["red", "Margin negative. Reprice or pause."];
  if (dar != null && dar >= 0.15) return ["yellow", "Dead air creeping up."];
  return ["green", "Healthy."];
}
const DOT: Record<string, string> = { red: "#C0392B", yellow: "#C9941A", green: "#1E7D4F" };
function dot(f: string) { return `<span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:${DOT[f]}"></span>`; }
const TD = 'style="padding:5px 8px;border-bottom:1px solid #E5EAF1;font-size:12px;white-space:nowrap"';
const TDR = 'style="padding:5px 8px;border-bottom:1px solid #E5EAF1;font-size:12px;text-align:right;white-space:nowrap"';
const TH = 'style="padding:6px 8px;background:#0F1F35;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;text-align:left"';
const THR = 'style="padding:6px 8px;background:#0F1F35;color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;text-align:right"';

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let force = false, dryRun = false, background = false;
  try { const b = await req.json(); force = b?.force === true; dryRun = b?.dry_run === true; background = b?.background === true; } catch { /* fine */ }

  try {
    const now = etNow();
    if (!force && !dryRun) {
      if (now.hour !== 7) return json({ skipped: "outside the 7 AM ET hour", hour_et: now.hour });
      const st = await dbGet(`ping_sync_state?key=eq.daily_brief_last_date&select=value`).catch(() => []);
      if (String(st?.[0]?.value || "") === now.date) return json({ skipped: "already sent today" });
    }
    // The build takes well past pg_net's ~5s hangup, so the cron calls with
    // { background: true }: reply immediately, finish via EdgeRuntime.waitUntil.
    if (background && !dryRun) {
      const task = runBrief(now, false).catch(async (e) => {
        await logEvent("error", "Daily brief failed (background)", String((e as Error)?.message ?? e));
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er && typeof er.waitUntil === "function") { er.waitUntil(task); return json({ started: true, mode: "background" }); }
      return json(await task);
    }
    return json(await runBrief(now, dryRun));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await logEvent("error", "Daily brief failed", msg);
    return json({ error: msg }, 500);
  }
});

async function runBrief(now: { date: string; hour: number }, dryRun = false) {
    const yday = addDays(now.date, -1);
    const prevSame = addDays(now.date, -8); // same weekday last week
    const wtdDates: string[] = []; const wtdPrev: string[] = [];
    { // Monday of this week through yesterday, and the same days last week
      const dow = new Date(`${now.date}T12:00:00Z`).getUTCDay();
      const mon = addDays(now.date, -((dow + 6) % 7));
      for (let d = mon; d <= yday; d = addDays(d, 1)) { wtdDates.push(d); wtdPrev.push(addDays(d, -7)); }
      if (!wtdDates.length) { wtdDates.push(yday); wtdPrev.push(addDays(yday, -7)); }
    }
    const [yCalls, pCalls, wCalls, wpCalls] = [
      await callsOn([yday]), await callsOn([prevSame]),
      await callsOn(wtdDates.filter((d) => d !== yday)).then((r) => r), await callsOn(wtdPrev),
    ];
    const wtdAll = wCalls.concat(yCalls);
    const ai = await analysisFor([...new Set(yCalls.filter(isConn).map((c) => String(c.inbound_call_id)).filter(Boolean))].slice(0, 4000));

    const buyers = scoreboard(yCalls, pCalls, ai, (c) => c.target_name);
    const pubsRows = scoreboard(yCalls, pCalls, ai, (c) => c.publisher_name);
    const tot = (rows: any[]) => rows.reduce((s, c) => s + Number(c.revenue || 0), 0);
    const yRev = tot(yCalls), pRev = tot(pCalls), wRev = tot(wtdAll), wpRev = tot(wpCalls);
    const yBill = yCalls.filter(isBill).length, pBill = pCalls.filter(isBill).length;
    const yPay = yCalls.reduce((s, c) => s + Number(c.payout || 0), 0);

    // week-to-date attention bullets (entity revenue vs same days last week)
    const sumBy = (rows: any[], keyF: (c: any) => string) => {
      const m = new Map<string, number>();
      for (const c of rows) { const k = keyF(c); if (k) m.set(k, (m.get(k) || 0) + Number(c.revenue || 0)); }
      return m;
    };
    const bullets: string[] = [];
    for (const [label, keyF] of [["Buyer", (c: any) => c.target_name], ["Source", (c: any) => c.publisher_name]] as [string, (c: any) => string][]) {
      const a = sumBy(wtdAll, keyF), b = sumBy(wpCalls, keyF);
      for (const k of new Set([...a.keys(), ...b.keys()])) {
        const av = a.get(k) || 0, bv = b.get(k) || 0;
        if (Math.max(av, bv) < 500) continue;
        if (bv > 0 && av === 0) bullets.push(`<b>${label} ${k}</b> went dark this week (was ${money(bv)})`);
        else if (bv > 0 && (av - bv) / bv <= -0.25) bullets.push(`<b>${label} ${k}</b> ${money(av)} WtD, <span style="color:#C0392B">${pc((av - bv) / bv)}</span> vs same days last week`);
        else if (bv > 0 && (av - bv) / bv >= 0.4) bullets.push(`<b>${label} ${k}</b> ${money(av)} WtD, <span style="color:#1E7D4F">${pc((av - bv) / bv)}</span> vs same days last week`);
      }
    }

    const bRows = buyers.slice(0, 15).map((r) => {
      const [f, act] = buyerFlag(r);
      const wow = r.prevRev > 0 ? (r.rev - r.prevRev) / r.prevRev : null;
      return `<tr><td ${TD}>${dot(f)} ${r.name}</td><td ${TDR}>${r.n}</td><td ${TDR}>${r.unans}</td><td ${TDR}>${r.cut}</td><td ${TDR}>${r.bill}</td><td ${TDR}>${money(r.rev)}</td><td ${TDR}>${wow == null ? "—" : `<span style="color:${wow >= 0 ? "#1E7D4F" : "#C0392B"}">${pc(wow)}</span>`}</td><td ${TDR}>${r.bill ? "$" + (r.rev / r.bill).toFixed(2) : "—"}</td>${hasAI ? `<td ${TDR}>${r.aiN ? r.aiSales : "—"}</td>` : ""}<td ${TD}>${act}</td></tr>`;
    }).join("");
    const pRows = pubsRows.slice(0, 15).map((r) => {
      const [f, act] = pubFlag(r);
      const wow = r.prevRev > 0 ? (r.rev - r.prevRev) / r.prevRev : null;
      const dar = r.aiN >= 5 ? Math.round(r.dead / r.aiN * 100) + "%" : "—";
      return `<tr><td ${TD}>${dot(f)} ${r.name}</td><td ${TDR}>${r.n}</td><td ${TDR}>${r.n ? Math.round(r.conn / r.n * 100) : 0}%</td><td ${TDR}>${r.bill}</td><td ${TDR}>${money(r.rev)}</td><td ${TDR}>${wow == null ? "—" : `<span style="color:${wow >= 0 ? "#1E7D4F" : "#C0392B"}">${pc(wow)}</span>`}</td><td ${TDR}>${money(r.rev - r.pay)}</td>${hasAI ? `<td ${TDR}>${dar}</td><td ${TDR}>${r.aiN ? r.crit : "—"}</td>` : ""}<td ${TD}>${act}</td></tr>`;
    }).join("");
    const aiCov = yCalls.filter(isConn).length;
    const aiHave = [...ai.keys()].length;
    // AI (Kaliper) columns only appear once call analysis data exists.
    const hasAI = aiHave > 0;

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1A2B44;max-width:960px">
<h2 style="margin:0 0 2px;color:#0F1F35">Nyala Labs Daily Brief — ${yday}</h2>
<div style="height:3px;background:linear-gradient(90deg,#5FC4CB,#3E96A0,#0F1F35);margin:6px 0 10px"></div>
<div style="color:#6B7686;font-size:12px;margin-bottom:12px">Compared with ${prevSame} (same weekday last week).${hasAI ? ` AI columns from Kaliper (${aiHave} of ${aiCov} connected calls analyzed).` : ""}</div>
<div style="font-size:13px;margin-bottom:14px"><b>${money(yRev)}</b> revenue (${pRev > 0 ? pc((yRev - pRev) / pRev) : "n/a"} vs last ${new Date(`${yday}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long" })}) · <b>${yBill}</b> billable (${pBill > 0 ? pc((yBill - pBill) / pBill) : "n/a"}) · <b>${money(yRev - yPay)}</b> margin · <b>${yBill ? "$" + (yRev / yBill).toFixed(2) : "—"}</b> per billable
<br/>Week to date: <b>${money(wRev)}</b> vs ${money(wpRev)} same days last week (${wpRev > 0 ? pc((wRev - wpRev) / wpRev) : "n/a"})</div>
${bullets.length ? `<div style="font-size:12px;font-weight:bold;text-transform:uppercase;color:#C0392B;margin:10px 0 4px">This week, worth eyes</div><ul style="margin:0 0 14px;padding-left:18px;font-size:13px">${bullets.slice(0, 8).map((b) => `<li style="margin-bottom:3px">${b}</li>`).join("")}</ul>` : ""}
<div style="font-size:12px;font-weight:bold;text-transform:uppercase;color:#2E8C96;margin:10px 0 4px">Buyers — yesterday</div>
<table style="border-collapse:collapse;width:100%"><tr><th ${TH}>Buyer</th><th ${THR}>Calls</th><th ${THR}>Unanswered</th><th ${THR}>Cut pre-bill</th><th ${THR}>Billable</th><th ${THR}>Revenue</th><th ${THR}>WoW</th><th ${THR}>$/Bill</th>${hasAI ? `<th ${THR}>AI sales</th>` : ""}<th ${TH}>Action</th></tr>${bRows}</table>
<div style="font-size:12px;font-weight:bold;text-transform:uppercase;color:#2E8C96;margin:16px 0 4px">Sources — yesterday</div>
<table style="border-collapse:collapse;width:100%"><tr><th ${TH}>Source</th><th ${THR}>Calls</th><th ${THR}>Connect</th><th ${THR}>Billable</th><th ${THR}>Revenue</th><th ${THR}>WoW</th><th ${THR}>Margin</th>${hasAI ? `<th ${THR}>AI dead air</th><th ${THR}>QC crit fails</th>` : ""}<th ${TH}>Action</th></tr>${pRows}</table>
<div style="color:#9AA5B1;font-size:11px;margin-top:14px">Flags: red = act today, yellow = watch, green = healthy. Full drill-down on the State of the Union page in the dashboard.</div>
</div>`;

    if (dryRun) return { dry_run: true, buyers: buyers.length, publishers: pubsRows.length, bullets: bullets.length, html };

    const RESEND = Deno.env.get("RESEND_API_KEY");
    if (!RESEND) throw new Error("RESEND_API_KEY secret is not set");
    const prefs = await dbGet("notification_preferences?select=email,daily_brief");
    const to = [...new Set(prefs.filter((p: any) => p.email && p.daily_brief !== false).map((p: any) => String(p.email)))];
    if (!to.length) { await logEvent("ok", "Daily brief built but no recipients opted in"); return { sent: 0, reason: "no recipients" }; }
    const from = Deno.env.get("RESEND_FROM") || "Nyala Labs Alerts <onboarding@resend.dev>";
    const er = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: `Daily Brief — ${yday}: ${money(yRev)} rev, ${yBill} billable`, html }),
    });
    if (!er.ok) { const msg = (await er.text()).slice(0, 300); await logEvent("error", "Daily brief email failed", msg); throw new Error(`Resend: ${msg}`); }
    await db("POST", "ping_sync_state?on_conflict=key", [{ key: "daily_brief_last_date", value: now.date }], "resolution=merge-duplicates,return=minimal");
    await logEvent("ok", `Daily brief sent for ${yday} to ${to.length} recipient(s)`);
    return { sent: to.length, date: yday };
}