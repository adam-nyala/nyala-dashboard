// dispo-ingest v2.4 — ingests a client disposition report (parsed client-side
// from the CSV) into dispo_leads / dispo_uploads, joining each lead to the
// publisher that delivered it via callgrid_calls (matched on phone number).
//
// Semantics:
//   • Calls collapse to one lead per phone. A lead is SOLD if ANY of its
//     calls (including agent callbacks) dispo'd SUCCESS.
//   • CALLGRID SCOPING (v2): only calls routed to THIS client's buyer
//     (target_name matches the client's callgrid_buyer_name variants, or
//     the client's name as fallback) are joined. publisher/campaign come
//     from the first such call; `billed` sums only the BILLABLE ones
//     (billable flag, falling back to revenue>0 for pre-flag rows), so
//     lead-level billing ties to CallGrid's view of this client.
//   • Upserts are UPGRADE-ONLY per (client, phone): a later rolling export
//     that no longer contains an old sale row can never un-sell a lead;
//     dead-air/refused flags accumulate; first-call fields keep the
//     earliest; last_result takes the newest; billed takes the max.
//   • Caller must be a signed-in staff user (upload comes from the app).
//   • v2.2: created_at may be DATE-ONLY (e.g. "10/01/2026") for clients
//     whose reports carry no times — the lead's first-call time/hour is
//     then taken from their earliest CallGrid call in range (ET).
//   • v2.3: rows may carry a per-row `sales` count (integer) — the app's
//     normalizers compute it per format (Clarifying: Result contains
//     "Application Submitted", "...Double Sale" = 2). A lead's sales is the
//     sum across its rows; sold = sales > 0. Rows without `sales` fall back
//     to result_category SUCCESS = 1 sale. Merges take max(existing, new).
//   • v2.4: dry runs return a `debug` block (buyer keys, window, fetched
//     row counts, targets seen) for diagnosing low match rates.
//
// POST {
//   client_id, filename,
//   dry_run?: true,            → full computation, no writes
//   rows: [{ phone, created_at, direction, result, result_category,
//            state, queue }]   → one entry per CSV row
// }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

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
  const r = await db("GET", path, undefined, "return=representation");
  return await r.json();
}
async function logEvent(status: "ok" | "error", event: string, detail?: string) {
  try {
    await db("POST", "integration_log", [{
      system: "dispo", direction: "inbound", event, status,
      detail: detail ? String(detail).slice(0, 800) : null,
    }]);
  } catch (_e) { /* best-effort */ }
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-10);
// ET clock parts for a UTC timestamp — used when a date-only file borrows
// its lead times from CallGrid.
function etClock(ms: number): { time: string; hour: number } {
  const d = new Date(ms);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: true, hour: "numeric", minute: "2-digit" }).format(d);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "numeric" }).format(d)) % 24;
  return { time, hour };
}
function parseDt(s: string): { ms: number; date: string; time: string | null; hour: number | null } | null {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)/i.exec(String(s ?? ""));
  if (!m) {
    // date-only fallback: "10/01/2026" or "2026-10-01"
    const d1 = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(s ?? ""));
    const d2 = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(String(s ?? ""));
    const date = d1 ? `${d1[3]}-${d1[1].padStart(2, "0")}-${d1[2].padStart(2, "0")}` : d2 ? `${d2[1]}-${d2[2]}-${d2[3]}` : null;
    if (!date) return null;
    return { ms: Date.parse(`${date}T12:00:00Z`), date, time: null, hour: null };
  }
  let h = parseInt(m[4]) % 12;
  if (m[7].toUpperCase() === "PM") h += 12;
  const date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const ms = Date.parse(`${date}T${String(h).padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}Z`); // wall-clock ordering only
  const time = `${((h + 11) % 12) + 1}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
  return { ms, date, time, hour: h };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // ── caller must be signed in AND staff ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const who = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: authHeader },
    });
    if (!who.ok) return json({ error: "Not signed in" }, 401);
    const caller = await who.json();
    const prof = await dbGet(`user_profiles?user_id=eq.${caller.id}&select=role`);
    if (!["admin", "staff", "operations", "finance", "sales"].includes(prof?.[0]?.role)) {
      return json({ error: "Staff only" }, 403);
    }

    const body = await req.json();
    const clientId = String(body?.client_id ?? "");
    const filename = String(body?.filename ?? "upload.csv").slice(0, 200);
    const dryRun = body?.dry_run === true;
    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    if (!clientId) return json({ error: "client_id required" }, 400);
    if (!rows.length) return json({ error: "no rows in payload" }, 400);
    if (rows.length > 50000) return json({ error: "file too large (max 50k rows)" }, 400);

    // the client's CallGrid buyer name(s) — scopes which calls we join
    const cli = await dbGet(`clients?id=eq.${clientId}&select=name,callgrid_buyer_name`);
    if (!cli.length) return json({ error: "client not found" }, 400);
    const buyerKeys = String(cli[0].callgrid_buyer_name || cli[0].name || "")
      .split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);

    // ── collapse calls → leads ──
    type Lead = {
      phone: string; firstMs: number; date: string; time: string | null; hour: number | null;
      state: string; queue: string; sold: boolean; salesN: number; trashed: boolean;
      dead_air: boolean; refused: boolean; lastMs: number; last_result: string;
    };
    const leads = new Map<string, Lead>();
    let parsed = 0;
    for (const r of rows) {
      const key = digits(r.phone);
      if (key.length !== 10) continue;
      const dt = parseDt(r.created_at);
      if (!dt) continue;
      parsed++;
      const cat = String(r.result_category ?? "").toUpperCase();
      const res = String(r.result ?? "").trim();
      const isInbound = String(r.direction ?? "").toLowerCase() === "incoming";
      let L = leads.get(key);
      if (!L) {
        L = { phone: key, firstMs: Infinity, date: "", time: null, hour: null,
          state: "", queue: "", sold: false, salesN: 0, trashed: false,
          dead_air: false, refused: false, lastMs: -1, last_result: "" };
        leads.set(key, L);
      }
      if (isInbound && dt.ms < L.firstMs) {
        L.firstMs = dt.ms; L.date = dt.date; L.time = dt.time; L.hour = dt.hour;
        L.state = String(r.state ?? "").trim(); L.queue = String(r.queue ?? "").trim();
      }
      const rowSales = Number.isFinite(Number(r.sales))
        ? Math.max(0, Math.round(Number(r.sales)))
        : (cat === "SUCCESS" ? 1 : 0);
      if (rowSales > 0) { L.sold = true; L.salesN += rowSales; }
      if (cat === "TRASH") L.trashed = true;
      if (res === "Dead Air") L.dead_air = true;
      if (res === "Client refuses to give info") L.refused = true;
      if (res && dt.ms > L.lastMs) { L.lastMs = dt.ms; L.last_result = res.slice(0, 120); }
    }
    // drop leads that never had an inbound call (pure outbound dial lists)
    for (const [k, L] of leads) if (!isFinite(L.firstMs)) leads.delete(k);
    for (const L of leads.values()) if (L.sold) L.trashed = false;
    if (!leads.size) return json({ error: "no inbound leads found in file — wrong format?" }, 400);

    // ── join to CallGrid by phone (date-windowed, padded a week back) ──
    const dates = [...leads.values()].map((l) => l.date).sort();
    const start = new Date(`${dates[0]}T12:00:00Z`); start.setUTCDate(start.getUTCDate() - 7);
    const padStart = start.toISOString().slice(0, 10);
    const end = dates[dates.length - 1];
    // paginate — PostgREST caps unpaginated reads at 1,000 rows, and a two-
    // week window holds far more than that
    const cg: any[] = [];
    for (let off = 0; off < 100000; off += 1000) {
      const page = await dbGet(
        `callgrid_calls?date=gte.${padStart}&date=lte.${end}&caller_id=not.is.null&select=caller_id,publisher_name,campaign_name,revenue,date,call_datetime,target_name,billable&order=date.asc,id.asc&limit=1000&offset=${off}`);
      cg.push(...page);
      if (page.length < 1000) break;
    }
    // only calls routed to THIS client's buyer; billable per the app's rule
    const isBill = (c: any) => c.billable != null ? !!c.billable : Number(c.revenue ?? 0) > 0;
    const scoped = cg.filter((c: any) =>
      buyerKeys.includes(String(c.target_name ?? "").trim().toLowerCase()));
    const match = new Map<string, { pub: string; camp: string; billed: number; hasBill: boolean; dtMs: number }>();
    for (const c of scoped) {
      const k = digits(c.caller_id);
      if (k.length !== 10) continue;
      const bill = isBill(c);
      let m = match.get(k);
      if (!m) { m = { pub: "", camp: "", billed: 0, hasBill: false, dtMs: Infinity }; match.set(k, m); }
      const cms = Date.parse(c.call_datetime ?? "");
      if (isFinite(cms) && cms < m.dtMs) m.dtMs = cms;
      // publisher/campaign: first BILLABLE call wins; else first call of any kind
      if ((bill && !m.hasBill) || !m.pub) {
        m.pub = c.publisher_name ?? ""; m.camp = c.campaign_name ?? "";
        if (bill) m.hasBill = true;
      }
      if (bill) m.billed += Number(c.revenue ?? 0);
    }
    let matched = 0;
    for (const L of leads.values()) if (match.has(L.phone)) matched++;

    // ── merge with existing rows (upgrade-only) ──
    const phones = [...leads.keys()].map((p) => `"+1${p}"`);
    const existing = new Map<string, any>();
    for (let i = 0; i < phones.length; i += 150) {
      const chunk = phones.slice(i, i + 150).join(",").replace(/\+/g, "%2B");
      const got = await dbGet(`dispo_leads?client_id=eq.${clientId}&phone=in.(${chunk})&select=*`);
      for (const g of got) existing.set(digits(g.phone), g);
    }

    let newCount = 0, updCount = 0;
    const upserts: any[] = [];
    const now = new Date().toISOString();
    for (const L of leads.values()) {
      const ex = existing.get(L.phone);
      const m = match.get(L.phone);
      if (ex) updCount++; else newCount++;
      // date-only files: borrow the lead's time from its first CallGrid call
      if (L.time == null && m && isFinite(m.dtMs)) {
        const c = etClock(m.dtMs);
        L.time = c.time; L.hour = c.hour;
      }
      const salesTot = Math.max(Number(ex?.sales ?? 0), L.salesN);
      const sold = (ex?.sold === true) || salesTot > 0;
      upserts.push({
        client_id: clientId,
        phone: `+1${L.phone}`,
        first_call_date: ex?.first_call_date && ex.first_call_date <= L.date ? ex.first_call_date : L.date,
        first_call_time: ex?.first_call_date && ex.first_call_date <= L.date ? ex.first_call_time : L.time,
        first_call_hour: ex?.first_call_date && ex.first_call_date <= L.date ? ex.first_call_hour : L.hour,
        state: L.state || ex?.state || null,
        queue: L.queue || ex?.queue || null,
        sold,
        sales: salesTot,
        trashed: sold ? false : ((ex?.trashed === true) || L.trashed),
        dead_air: (ex?.dead_air === true) || L.dead_air,
        refused: (ex?.refused === true) || L.refused,
        last_result: L.last_result || ex?.last_result || null,
        publisher_name: m?.pub || ex?.publisher_name || null,
        campaign_name: m?.camp || ex?.campaign_name || null,
        billed: Math.max(Number(ex?.billed ?? 0), m?.billed ?? 0),
        first_upload_id: ex?.first_upload_id ?? null, // filled below for new rows
        updated_at: now,
      });
    }

    const summary = {
      rows_in_file: rows.length, rows_parsed: parsed,
      leads_in_file: leads.size,
      sales_in_file: [...leads.values()].reduce((t, l) => t + l.salesN, 0),
      matched_to_publisher: matched,
      matched_pct: Math.round(matched / leads.size * 1000) / 10,
      leads_new: newCount, leads_updated: updCount,
      period: { start: dates[0], end },
    };
    if (dryRun) {
      // diagnostics: everything needed to see WHY a match rate is low
      const targetCounts: Record<string, number> = {};
      for (const c of cg) {
        const t = String(c.target_name ?? "").trim() || "(null)";
        targetCounts[t] = (targetCounts[t] ?? 0) + 1;
      }
      const debug = {
        buyer_keys: buyerKeys,
        window: { start: padStart, end },
        callgrid_rows_fetched: cg.length,
        scoped_rows: scoped.length,
        unique_scoped_callers: match.size,
        targets_in_window: Object.fromEntries(
          Object.entries(targetCounts).sort((a, b) => b[1] - a[1]).slice(0, 25)),
        sample_scoped: scoped.slice(0, 2).map((c: any) => ({ caller_id: c.caller_id, date: c.date, target_name: c.target_name })),
        sample_lead_phones: [...leads.keys()].slice(0, 3),
      };
      return json({ dry_run: true, ...summary, debug, sample: upserts.slice(0, 2) });
    }

    // upload record first, so lead rows can reference it
    const ins = await db("POST", "dispo_uploads", [{
      client_id: clientId, filename,
      period_start: dates[0], period_end: end,
      rows_in_file: rows.length, leads_in_file: leads.size,
      leads_new: newCount, leads_updated: updCount,
      matched_pct: summary.matched_pct, uploaded_by: caller.id,
    }], "return=representation");
    const uploadId = (await ins.json())[0]?.id ?? null;
    for (const u of upserts) {
      if (!u.first_upload_id) u.first_upload_id = uploadId;
      u.last_upload_id = uploadId;
    }
    for (let i = 0; i < upserts.length; i += 300) {
      await db("POST", "dispo_leads?on_conflict=client_id,phone",
        upserts.slice(i, i + 300), "resolution=merge-duplicates,return=minimal");
    }
    await logEvent("ok",
      `Dispo upload — ${filename}: ${leads.size} leads (${newCount} new, ${updCount} updated), ${summary.matched_pct}% matched`,
      `period ${dates[0]} → ${end}`);
    return json({ upload_id: uploadId, ...summary });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await logEvent("error", "Dispo ingest failed", msg);
    return json({ error: msg }, 500);
  }
});