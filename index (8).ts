// alert-engine — evaluates the alert_rules table against today's synced data
// and writes fired alerts into the alerts table (the dashboard bell feed),
// emailing the Configuration → Notifications recipients via Resend.
//
// Rules (v1 metrics):
//   buyer_accept_rate — a buyer's ping accept % today has dropped threshold%+
//                       below its own trailing 7-day average (min_volume =
//                       minimum pings today AND in the baseline window);
//                       buyers that are chronically near-zero never alert
//   publisher_pace    — a publisher campaign's billable calls today are
//                       below threshold% of its time-adjusted daily target
//   rpc_drop          — a client campaign's revenue-per-billable-call today
//                       is threshold%+ below its trailing 7-day average
//   low_billable_pct  — a publisher campaign's billable-to-connected % today
//                       is below the threshold (short-call signal)
//   volume_drop       — a client campaign's billable calls today run
//                       threshold%+ behind its 7-day-average pace
//   overdue_invoices  — daily digest when AR invoices / AP bills are past
//                       due (threshold = minimum overdue $ total to fire)
//   launch_no_calls   — a campaign whose launch date (start_date) is today
//                       has taken ZERO calls (fires from not_before_hour,
//                       set it to 12 for the by-noon rule), or launched in
//                       the last 3 days and still has no calls at all
// Every alert type honors each recipient's per-type email toggle
// (Configuration → Notifications); unset toggles default to on.
//
// Noise control: each rule has a quiet period (not_before_hour, ET), a
// minimum-volume guard, and a cooldown. ACK = handled for now: if the
// condition persists, the alert re-fires once the cooldown elapses.
// IGNORE = silenced: no re-fires for that subject for the rest of the
// day (kept on record with status 'ignored').
//
// POST body (optional): {} → evaluate + write + email
//                       { dry_run: true } → evaluate only, return candidates

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
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
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

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function etNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hour = Number(g("hour")); if (hour === 24) hour = 0;
  const minute = Number(g("minute"));
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    hour, dayFrac: (hour * 60 + minute) / 1440,
  };
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt$ = (v: number) => `$${v.toFixed(2)}`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;

type Candidate = {
  rule: any; subject: string; message: string; value: number;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let dryRun = false;
  try { const b = await req.json(); dryRun = b?.dry_run === true; } catch { /* fine */ }

  try {
    const now = etNow();
    const today = now.date;
    const d7 = addDays(today, -7), d1 = addDays(today, -1);

    const rules = await dbGet("alert_rules?enabled=eq.true&select=*");
    if (!rules.length) return json({ evaluated: 0, fired: 0, note: "no enabled rules" });
    const byMetric = (m: string) => rules.filter((r: any) => r.metric === m && now.hour >= num(r.not_before_hour));

    // ── Load today's data (only what the enabled rules need) ──
    const [pingToday, pingPrior, totToday, totPrior, pubToday, pcs, pubs, ccs, clients, revRows, arRows, apRows, launchCC, launchPub] = await Promise.all([
      byMetric("buyer_accept_rate").length
        ? dbGet(`ping_daily_stats?date=eq.${today}&select=destination_name,total_pings,accepted`) : [],
      byMetric("buyer_accept_rate").length
        ? dbGet(`ping_daily_stats?date=gte.${d7}&date=lte.${d1}&select=destination_name,total_pings,accepted`) : [],
      (byMetric("rpc_drop").length || byMetric("volume_drop").length)
        ? dbGet(`callgrid_daily_totals?date=eq.${today}&select=client_campaign_id,billable_calls`) : [],
      (byMetric("rpc_drop").length || byMetric("volume_drop").length)
        ? dbGet(`callgrid_daily_totals?date=gte.${d7}&date=lte.${d1}&select=client_campaign_id,billable_calls`) : [],
      (byMetric("publisher_pace").length || byMetric("low_billable_pct").length)
        ? dbGet(`callgrid_daily_totals_pub?date=eq.${today}&select=publisher_campaign_id,callgrid_publisher_name,total_calls,billable_calls`) : [],
      dbGet("publisher_campaigns?select=id,name,publisher_id,daily_call_target,active,start_date"),
      dbGet("publishers?select=id,name"),
      dbGet("client_campaigns?select=id,name,client_id,callgrid_target_name,active,start_date"),
      dbGet("clients?select=id,name"),
      byMetric("rpc_drop").length
        ? dbGet(`callgrid_calls?date=gte.${d7}&select=date,client_campaign_id,revenue`) : [],
      byMetric("overdue_invoices").length
        ? dbGet("ar_ledger?select=client,amount_billed,amount_received,status,due_date") : [],
      byMetric("overdue_invoices").length
        ? dbGet("ap_ledger?select=publisher,amount_billed,amount_paid,status,due_date") : [],
      byMetric("launch_no_calls").length
        ? dbGet(`callgrid_daily_totals?date=gte.${addDays(today, -3)}&select=date,client_campaign_id,total_calls`) : [],
      byMetric("launch_no_calls").length
        ? dbGet(`callgrid_daily_totals_pub?date=gte.${addDays(today, -3)}&select=date,publisher_campaign_id,total_calls`) : [],
    ]);
    const pubName = new Map(pubs.map((p: any) => [p.id, p.name]));
    const clientName = new Map(clients.map((c: any) => [c.id, c.name]));
    const ccById = new Map(ccs.map((c: any) => [c.id, c]));

    const candidates: Candidate[] = [];

    // 0. Launch day with zero calls (by noon via not_before_hour), or a
    //    launch in the last 3 days that still has no calls at all
    for (const rule of byMetric("launch_no_calls")) {
      const sum = (rows: any[], idKey: string, sinceDate: string, id: string) =>
        rows.reduce((s: number, r: any) => s + ((r[idKey] === id && String(r.date) >= sinceDate) ? num(r.total_calls) : 0), 0);
      const check = (camp: any, side: string, parent: string, idKey: string, rows: any[]) => {
        if (camp.active === false) return;
        const sd = String(camp.start_date || "").slice(0, 10);
        if (!sd || sd > today || sd < addDays(today, -3)) return;
        const since = sum(rows, idKey, sd, camp.id);
        if (since > 0) return;
        const subj = `${parent} · ${camp.name}`;
        candidates.push({
          rule, subject: subj, value: 0,
          message: sd === today
            ? `Launch day, still zero calls: ${subj} (${side}) launched today and has not taken a call as of ${now.hour}:00 ET. Check CallGrid routing, the campaign link, and whether the ${side === "buyer campaign" ? "publisher side is sending" : "destination is accepting"}.`
            : `Launched ${sd} and still zero calls: ${subj} (${side}). The campaign is active but nothing has flowed since launch.`,
        });
      };
      for (const c of ccs) check(c, "buyer campaign", clientName.get(c.client_id) ?? "?", "client_campaign_id", launchCC);
      for (const p of pcs) check(p, "publisher campaign", pubName.get(p.publisher_id) ?? "?", "publisher_campaign_id", launchPub);
    }

    // 1. Buyer accept % dropped vs its own 7-day average
    for (const rule of byMetric("buyer_accept_rate")) {
      const roll = (rows: any[]) => {
        const m = new Map<string, { pings: number; acc: number; name: string }>();
        for (const r of rows) {
          const nm = String(r.destination_name || "").trim();
          const k = nm.toLowerCase();
          if (!k || k === "unknown") continue; // blank buyer names never alert
          const a = m.get(k) ?? { pings: 0, acc: 0, name: nm };
          a.pings += num(r.total_pings); a.acc += num(r.accepted);
          m.set(k, a);
        }
        return m;
      };
      const tod = roll(pingToday), base = roll(pingPrior);
      for (const [k, a] of tod) {
        if (a.pings < num(rule.min_volume)) continue;
        const b = base.get(k);
        if (!b || b.pings < num(rule.min_volume)) continue; // no meaningful baseline
        const rateNow = a.acc / a.pings * 100;
        const rateAvg = b.acc / b.pings * 100;
        if (rateAvg < 1) continue; // chronically ~0% — not news
        const drop = (1 - rateNow / rateAvg) * 100;
        if (drop >= num(rule.threshold)) {
          candidates.push({
            rule, subject: a.name, value: rateNow,
            message: `${a.name}: accepting ${pct1(rateNow)} of pings today vs ${pct1(rateAvg)} 7-day average — down ${pct1(drop)} (${a.acc.toLocaleString()} of ${a.pings.toLocaleString()} pings).`,
          });
        }
      }
    }

    // 2. Publisher behind pace vs daily target (time-adjusted)
    for (const rule of byMetric("publisher_pace")) {
      if (now.dayFrac <= 0) continue;
      const billByPc = new Map<string, number>();
      for (const r of pubToday) if (r.publisher_campaign_id) {
        billByPc.set(r.publisher_campaign_id, (billByPc.get(r.publisher_campaign_id) ?? 0) + num(r.billable_calls));
      }
      for (const pc of pcs) {
        if (pc.active === false) continue;
        const target = num(pc.daily_call_target);
        if (target <= 0) continue;
        const bill = billByPc.get(pc.id) ?? 0;
        const expected = target * now.dayFrac;
        const pace = expected > 0 ? bill / expected * 100 : 100;
        if (pace < num(rule.threshold)) {
          const who = `${pubName.get(pc.publisher_id) ?? "?"} — ${pc.name}`;
          candidates.push({
            rule, subject: who, value: pace,
            message: `${who}: ${bill.toLocaleString()} billable so far vs ~${Math.round(expected)} expected by now (target ${target}/day) — ${pct1(pace)} of pace.`,
          });
        }
      }
    }

    // 3. RPC drop vs trailing 7-day average (per client campaign)
    for (const rule of byMetric("rpc_drop")) {
      const billToday = new Map<string, number>();
      for (const r of totToday) if (r.client_campaign_id) {
        billToday.set(r.client_campaign_id, (billToday.get(r.client_campaign_id) ?? 0) + num(r.billable_calls));
      }
      const billPrior = new Map<string, number>();
      for (const r of totPrior) if (r.client_campaign_id) {
        billPrior.set(r.client_campaign_id, (billPrior.get(r.client_campaign_id) ?? 0) + num(r.billable_calls));
      }
      const revToday = new Map<string, number>(), revPrior = new Map<string, number>();
      for (const r of revRows) {
        if (!r.client_campaign_id) continue;
        const tgt = String(r.date).slice(0, 10) === today ? revToday : revPrior;
        tgt.set(r.client_campaign_id, (tgt.get(r.client_campaign_id) ?? 0) + num(r.revenue));
      }
      for (const [ccId, bToday] of billToday) {
        if (bToday < num(rule.min_volume)) continue;
        const bPrior = billPrior.get(ccId) ?? 0;
        if (bPrior < num(rule.min_volume)) continue; // no meaningful baseline
        const rpcNow = (revToday.get(ccId) ?? 0) / bToday;
        const rpcAvg = (revPrior.get(ccId) ?? 0) / bPrior;
        if (rpcAvg <= 0) continue;
        const drop = (1 - rpcNow / rpcAvg) * 100;
        if (drop >= num(rule.threshold)) {
          const cc = ccById.get(ccId);
          const who = `${clientName.get(cc?.client_id) ?? "?"} — ${cc?.name ?? ccId}`;
          candidates.push({
            rule, subject: who, value: rpcNow,
            message: `${who}: RPC today ${fmt$(rpcNow)} vs ${fmt$(rpcAvg)} 7-day average — down ${pct1(drop)}.`,
          });
        }
      }
    }

    // 4. Low billable % — short-call signal (per publisher campaign)
    for (const rule of byMetric("low_billable_pct")) {
      const agg = new Map<string, { tot: number; bill: number; name: string }>();
      for (const r of pubToday) {
        const k = r.publisher_campaign_id ?? `name:${r.callgrid_publisher_name}`;
        const pc = r.publisher_campaign_id ? pcs.find((x: any) => x.id === r.publisher_campaign_id) : null;
        const label = pc ? `${pubName.get(pc.publisher_id) ?? "?"} — ${pc.name}` : (r.callgrid_publisher_name ?? "Unknown publisher");
        const a = agg.get(k) ?? { tot: 0, bill: 0, name: label };
        a.tot += num(r.total_calls); a.bill += num(r.billable_calls);
        agg.set(k, a);
      }
      for (const [, a] of agg) {
        if (a.tot < num(rule.min_volume)) continue;
        const rate = a.bill / a.tot * 100;
        if (rate < num(rule.threshold)) {
          candidates.push({
            rule, subject: a.name, value: rate,
            message: `${a.name}: only ${pct1(rate)} of connected calls billable today (${a.bill} of ${a.tot}) — short-call pattern below the ${num(rule.threshold)}% floor.`,
          });
        }
      }
    }

    // 5. Volume drop — client campaign billable pace vs 7-day average
    for (const rule of byMetric("volume_drop")) {
      if (now.dayFrac <= 0) continue;
      const bT = new Map<string, number>(), bP = new Map<string, number>();
      for (const r of totToday) if (r.client_campaign_id) bT.set(r.client_campaign_id, (bT.get(r.client_campaign_id) ?? 0) + num(r.billable_calls));
      for (const r of totPrior) if (r.client_campaign_id) bP.set(r.client_campaign_id, (bP.get(r.client_campaign_id) ?? 0) + num(r.billable_calls));
      for (const [ccId, prior] of bP) {
        const avg = prior / 7;
        if (avg < num(rule.min_volume)) continue;
        const todayBill = bT.get(ccId) ?? 0;
        const expected = avg * now.dayFrac;
        if (expected <= 0) continue;
        const drop = (1 - todayBill / expected) * 100;
        if (drop >= num(rule.threshold)) {
          const cc = ccById.get(ccId);
          const who = `${clientName.get(cc?.client_id) ?? "?"} — ${cc?.name ?? ccId}`;
          candidates.push({
            rule, subject: who, value: todayBill,
            message: `${who}: ${todayBill.toLocaleString()} billable so far vs ~${Math.round(expected)} expected by now (7-day avg ${Math.round(avg)}/day) — volume down ${pct1(drop)}.`,
          });
        }
      }
    }

    // 6. Overdue invoices — one AR digest + one AP digest per day
    for (const rule of byMetric("overdue_invoices")) {
      const isOver = (r: any, received: number) => {
        const bal = num(r.amount_billed) - received;
        return bal > 0 && (r.status === "Overdue" ||
          (r.due_date && String(r.due_date).slice(0, 10) < today && r.status !== "Paid"));
      };
      const overAR = arRows.filter((r: any) => isOver(r, num(r.amount_received)));
      const overAP = apRows.filter((r: any) => isOver(r, num(r.amount_paid)));
      const arTot = overAR.reduce((s: number, r: any) => s + num(r.amount_billed) - num(r.amount_received), 0);
      const apTot = overAP.reduce((s: number, r: any) => s + num(r.amount_billed) - num(r.amount_paid), 0);
      if (overAR.length && arTot >= num(rule.threshold)) {
        const names = [...new Set(overAR.map((r: any) => r.client).filter(Boolean))];
        candidates.push({
          rule, subject: "Client invoices overdue", value: arTot,
          message: `${overAR.length} client invoice${overAR.length === 1 ? "" : "s"} overdue totaling ${fmt$(arTot)} — ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}.`,
        });
      }
      if (overAP.length && apTot >= num(rule.threshold)) {
        const names = [...new Set(overAP.map((r: any) => r.publisher).filter(Boolean))];
        candidates.push({
          rule, subject: "Publisher bills overdue", value: apTot,
          message: `${overAP.length} publisher bill${overAP.length === 1 ? "" : "s"} overdue totaling ${fmt$(apTot)} — ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}.`,
        });
      }
    }

    // ── Cooldown / ack dedupe ──
    const existing = await dbGet(`alerts?date=eq.${today}&select=dedupe_key,fired_at,status`);
    const lastFired = new Map<string, number>();
    const ignoredKeys = new Set<string>();
    for (const a of existing) {
      const t = Date.parse(a.fired_at);
      if (!lastFired.has(a.dedupe_key) || t > lastFired.get(a.dedupe_key)!) lastFired.set(a.dedupe_key, t);
      if (a.status === "ignored") ignoredKeys.add(a.dedupe_key);
    }
    const toFire: any[] = [];
    let cooled = 0, ignored = 0;
    for (const c of candidates) {
      const key = `${c.rule.metric}|${c.subject.toLowerCase()}|${today}`;
      if (ignoredKeys.has(key)) { ignored++; continue; } // silenced for the day
      const last = lastFired.get(key);
      // acked or open alike: re-fire only once the cooldown has elapsed
      if (last && Date.now() - last < num(c.rule.cooldown_minutes) * 60000) { cooled++; continue; }
      toFire.push({
        rule_id: c.rule.id, metric: c.rule.metric, severity: c.rule.severity ?? "warning",
        subject: c.subject.slice(0, 200), message: c.message.slice(0, 500),
        value: Math.round(c.value * 100) / 100, threshold: num(c.rule.threshold),
        date: today, dedupe_key: key, emailed: false,
      });
    }

    if (dryRun) {
      return json({
        dry_run: true, hour_et: now.hour,
        candidates: candidates.length, would_fire: toFire.length,
        suppressed_cooldown: cooled, suppressed_ignored: ignored,
        detail: toFire.map((t) => t.message),
      });
    }

    if (toFire.length) {
      await db("POST", "alerts", toFire);
    }

    // ── Email the new ones (grouped by each recipient's toggles) ──
    let emailedTo = 0;
    const emailable = toFire.filter((t) => rules.find((r: any) => r.id === t.rule_id)?.email !== false);
    const RESEND = Deno.env.get("RESEND_API_KEY");
    if (emailable.length && RESEND) {
      const prefs = await dbGet("notification_preferences?select=email,alert_buyer_accept,alert_publisher_pace,alert_rpc_drop,alert_low_billable,alert_volume_drop,alert_overdue_invoices,alert_launch");
      const COL: Record<string, string> = {
        buyer_accept_rate: "alert_buyer_accept", publisher_pace: "alert_publisher_pace",
        rpc_drop: "alert_rpc_drop", low_billable_pct: "alert_low_billable",
        volume_drop: "alert_volume_drop", overdue_invoices: "alert_overdue_invoices",
        launch_no_calls: "alert_launch",
      };
      const itemsFor = (p: any) => emailable.filter((t) => p[COL[t.metric] ?? ""] !== false);
      const groups = new Map<string, { to: string[]; items: any[] }>();
      for (const p of prefs) {
        if (!p.email) continue;
        const items = itemsFor(p);
        if (!items.length) continue;
        const sig = items.map((t) => t.dedupe_key).join("|");
        const g = groups.get(sig) ?? { to: [], items };
        g.to.push(p.email); groups.set(sig, g);
      }
      const from = Deno.env.get("RESEND_FROM") || "Nyala Labs Alerts <onboarding@resend.dev>";
      const sentKeys = new Set<string>();
      for (const [, g] of groups) {
        const items = g.items.map((t) => `<li style="margin-bottom:8px">${t.message}</li>`).join("");
        const er = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from, to: g.to,
            subject: `Dashboard alerts (${g.items.length}) — ${today}`,
            html: `<div style="font-family:sans-serif;font-size:14px"><p><b>${g.items.length} alert${g.items.length === 1 ? "" : "s"}</b> fired on the Nyala Labs dashboard:</p><ul>${items}</ul><p style="color:#888;font-size:12px">Thresholds and recipients are managed in the dashboard (Configuration → Notifications). Alerts stop re-firing once acknowledged in the app.</p></div>`,
          }),
        });
        if (er.ok) { emailedTo += g.to.length; g.items.forEach((t: any) => sentKeys.add(t.dedupe_key)); }
        else await logEvent("error", "Alert email failed", (await er.text()).slice(0, 300));
      }
      if (sentKeys.size) {
        const keys = [...sentKeys].map((k) => `"${k}"`).join(",");
        await db("PATCH", `alerts?date=eq.${today}&dedupe_key=in.(${encodeURIComponent(keys).replace(/%22/g, '"')})&emailed=eq.false`, { emailed: true }).catch(() => {});
      }
    }

    if (toFire.length) {
      await logEvent("ok", `Alerts fired: ${toFire.length} (${cooled} in cooldown, ${ignored} ignored)`,
        toFire.map((t) => t.subject).slice(0, 8).join(" | "));
    }
    // Stamp the run so the dashboard bell can show "last checked".
    await db("POST", "ping_sync_state?on_conflict=key", [{
      key: "alert_engine",
      value: { last_run: new Date().toISOString(), candidates: candidates.length, fired: toFire.length },
      updated_at: new Date().toISOString(),
    }], "resolution=merge-duplicates,return=minimal").catch(() => {});
    return json({
      hour_et: now.hour, candidates: candidates.length, fired: toFire.length,
      suppressed_cooldown: cooled, suppressed_ignored: ignored, emailed_to: emailedTo,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await logEvent("error", "Alert engine failed", msg);
    return json({ error: msg }, 500);
  }
});