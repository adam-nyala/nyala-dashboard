// callgrid-ping-sync v5 — ping/bid acceptance stats + raw bid capture.
// v5 adds, on top of v4's daily rollups and live intraday rows:
//   • ping_bid_hourly — per (date, ET hour, destination) aggregates built
//     from the raw stream: pings, accepted, bids, bid $/duration sums,
//     winning bids (PingWonBid), calls won (PingWonCall), ping response
//     times overall and when bidding, timeouts, and bids that arrived
//     after the ping timeout (count, $ sum, response-time sum). Powers the
//     buyer bid-performance report with hour/day/week/month rollups.
//   • ping_bids — one row per ping that drew a bid (or won), with the key
//     fields extracted and the FULL raw CallGrid record as jsonb for the
//     ping explorer. Rolling retention: 30 days, pruned on every run.
//   Both fill from the live stream going forward; history is loaded one
//   day at a time with { raw_backfill: "YYYY-MM-DD" }, repeated calls
//   resume via a per-day watermark until caught_up is true.
//
//  CLOSED DAYS (authoritative): CallGrid's daily rollup endpoints
//    GET /api/reports/pingStats            — per destination, per day
//    GET /api/reports/bidStats             — per source (queried day by day)
//    GET /api/reports/bidStats/rejections  — per source (queried day by day)
//  These only publish COMPLETED days, so:
//
//  TODAY (live, best-effort): raw /api/ping records are streamed
//  INCREMENTALLY — each run only reads the window since the last run's
//  watermark (stored in ping_sync_state), aggregates per buyer, and ADDS
//  into "live:" rows for today. Small windows keep us far away from the
//  worker resource limits that a full raw day hits. When the day closes,
//  the rollup replaces the live rows with final numbers, so any live-row
//  drift self-heals within a day. Bid (publisher-side) stats have no raw
//  intraday equivalent light enough to stream, so they remain end-of-day.
//
// READ-ONLY toward CallGrid.
//
// POST body (optional):
//   {}                       → rollups for the last 3 days + live update for today
//   { days: 7 }              → rollups for the last N days (max 31) + live today
//   { date: "YYYY-MM-DD" }   → that one day; if it's today, rebuilds live rows
//                              from midnight (resets the watermark)
//   { start: "...", end: "..." } → rollups for that range (max 31 days)
//   { live_only: true }      → skip rollups, only advance today's live rows
//
// The live phase works in 30-minute slices and stops after a per-invocation
// cap, saving its watermark after every slice — so a large backlog (like a
// from-midnight rebuild) is caught up by calling repeatedly; the response's
// live_today.caught_up says whether another call is needed.

const CALLGRID_API = "https://api.callgrid.com/api";
const ET = "America/New_York";
const TIME_BUDGET_MS = 300000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: ET });
}
function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: ET });
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Midnight ET for a YYYY-MM-DD, as epoch ms. The -04:00 offset is EDT;
// off by an hour during EST, which is harmless here because every raw
// record is still bucketed by its own ET date before counting.
function etMidnightMs(ymd: string): number {
  return new Date(`${ymd}T00:00:00-04:00`).getTime() - 3600e3;
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
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
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
      system: "callgrid", direction: "inbound", event, status,
      detail: detail ? String(detail).slice(0, 800) : null,
    }]);
  } catch (_e) { /* best-effort */ }
}
async function getState(key: string): Promise<any> {
  try {
    const rows = await dbGet(`ping_sync_state?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows[0]?.value ?? null;
  } catch (_e) { return null; }
}
async function setState(key: string, value: unknown) {
  await db("POST", "ping_sync_state?on_conflict=key",
    [{ key, value, updated_at: new Date().toISOString() }],
    "resolution=merge-duplicates,return=minimal");
}

// ── Rollup reader (page/limit pagination) ──
async function report(path: string, KEY: string, startYmd: string, endYmd: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      startDate: startYmd, endDate: endYmd,
      limit: "1000", page: String(page),
    });
    let r: Response | null = null;
    for (let i = 0; i < 4; i++) {
      r = await fetch(`${CALLGRID_API}${path}?${params}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${KEY}` },
      });
      if (r.status !== 429) break;
      const reset = Number(r.headers.get("RateLimit-Reset") ?? "2");
      await new Promise((res) => setTimeout(res, Math.min(reset, 15) * 1000));
    }
    if (!r!.ok) throw new Error(`${path} HTTP ${r!.status}: ${(await r!.text()).slice(0, 200)}`);
    const payload = await r!.json();
    const data = payload.data ?? payload;
    const items: any[] = Array.isArray(data) ? data : (data.items ?? []);
    out.push(...items);
    if (items.length < 1000) return out;
  }
  return out;
}

// ── Raw streamer (cursor pagination), feeding each page to onItems ──
async function streamRaw(
  path: string, KEY: string, startISO: string, endISO: string,
  t0: number, onItems: (items: any[]) => void,
): Promise<{ fetched: number; complete: boolean }> {
  let fetched = 0;
  let searchAfter: unknown = null;
  let retries = 0;
  for (let guard = 0; guard < 5000; guard++) {
    if (Date.now() - t0 > TIME_BUDGET_MS) return { fetched, complete: false };
    const params = new URLSearchParams({
      startDate: startISO, endDate: endISO,
      useCursor: "true", maxItems: "250", reportTimeZone: "US/Eastern",
    });
    if (searchAfter !== null) params.set("searchAfter", JSON.stringify(searchAfter));
    const r = await fetch(`${CALLGRID_API}${path}?${params}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${KEY}` },
    });
    if (r.status === 429) {
      if (++retries > 6) throw new Error(`${path}: rate limit persisted`);
      const reset = Number(r.headers.get("RateLimit-Reset") ?? "2");
      await new Promise((res) => setTimeout(res, Math.min(reset, 15) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    retries = 0;
    const payload = await r.json();
    const data = payload.data ?? [];
    const items: any[] = Array.isArray(data) ? data : (data.items ?? []);
    fetched += items.length;
    onItems(items);
    if (!payload.hasMore || payload.nextCursor == null) return { fetched, complete: true };
    searchAfter = payload.nextCursor;
    await new Promise((res) => setTimeout(res, 100));
  }
  return { fetched, complete: false };
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const LIVE_PREFIX = "live:";

// ── v5: raw bid capture ──
const BID_RETENTION_DAYS = 30;
const etHourFmtV5 = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", hour12: false });
const etHourOf = (ms: number) => Number(etHourFmtV5.format(new Date(ms))) % 24;
const hasBid = (p: any) =>
  p.PingBidAmount != null || p.PingRevenueAmount != null ||
  num(p.PingWonBid) > 0 || num(p.PingWonCall) > 0;
function collectRaw(p: any, ts: number, hourAgg: Map<string, any>, bids: any[]) {
  const date = etDate(new Date(ts).toISOString());
  const hour = etHourOf(ts);
  const destId = String(p.DestinationId ?? "unknown");
  const hk = `${date}|${hour}|${destId}`;
  const h = hourAgg.get(hk) ?? {
    date, hour, destination_id: destId,
    destination_name: String(p.DestinationName ?? "") || null,
    buyer_name: String(p.BuyerName ?? "") || null,
    pings: 0, accepted: 0, bids: 0, bid_amount_sum: 0, bid_duration_sum: 0,
    won_bids: 0, won_calls: 0, timeouts: 0,
    ping_ms_sum: 0, ping_ms_bid_sum: 0,
    timeout_bids: 0, timeout_bid_amount_sum: 0, timeout_bid_ping_ms_sum: 0,
  };
  h.pings++;
  const ms = num(p.PingMs);
  h.ping_ms_sum += ms;
  if (num(p.PingAccepted)) h.accepted++;
  const to = num(p.PingTimeout) > 0;
  if (to) h.timeouts++;
  if (hasBid(p)) {
    const amt = num(p.PingBidAmount ?? p.PingRevenueAmount);
    h.bids++;
    h.bid_amount_sum += amt;
    h.bid_duration_sum += num(p.PingDuration ?? p.PingRevenueDuration);
    h.ping_ms_bid_sum += ms;
    if (num(p.PingWonBid)) h.won_bids++;
    if (num(p.PingWonCall)) h.won_calls++;
    if (to) { h.timeout_bids++; h.timeout_bid_amount_sum += amt; h.timeout_bid_ping_ms_sum += ms; }
    bids.push({
      id: String(p.id), bid_id: p.BidId ?? null,
      ts: new Date(ts).toISOString(), date, hour,
      destination_id: destId, destination_name: p.DestinationName ?? null,
      buyer_name: p.BuyerName ?? null, campaign_name: p.CampaignName ?? null,
      source_name: p.SourceName ?? null, vendor_name: p.VendorName ?? null,
      state_code: p.InboundStateCode ?? p.StateCodeFromAreaCode ?? null,
      caller_id: p.CallerId ?? p.InboundNumber ?? null,
      bid_amount: p.PingBidAmount ?? p.PingRevenueAmount ?? null,
      bid_duration: p.PingDuration ?? p.PingRevenueDuration ?? null,
      revenue_amount: p.RevenueAmount ?? null,
      ping_ms: ms, ping_code: p.PingCode ?? null,
      accepted: num(p.PingAccepted) > 0, won_bid: num(p.PingWonBid) > 0,
      won_call: num(p.PingWonCall) > 0, ping_timeout: to,
      url: p.url ?? null, raw: p, synced_at: new Date().toISOString(),
    });
  }
  hourAgg.set(hk, h);
}
const HOURLY_FIELDS = ["pings","accepted","bids","bid_amount_sum","bid_duration_sum","won_bids","won_calls","timeouts","ping_ms_sum","ping_ms_bid_sum","timeout_bids","timeout_bid_amount_sum","timeout_bid_ping_ms_sum"];
async function flushRaw(hourAgg: Map<string, any>, bids: any[]) {
  if (hourAgg.size) {
    const rows = [...hourAgg.values()];
    for (const d of [...new Set(rows.map((h) => h.date))]) {
      const existing = await dbGet(`ping_bid_hourly?date=eq.${d}&select=*`);
      const exBy = new Map(existing.map((r: any) => [`${r.date}|${r.hour}|${r.destination_id}`, r]));
      const ups = rows.filter((h) => h.date === d).map((h) => {
        const ex: any = exBy.get(`${h.date}|${h.hour}|${h.destination_id}`) ?? {};
        const o: any = { ...h, updated_at: new Date().toISOString() };
        for (const f of HOURLY_FIELDS) o[f] = num(ex[f]) + h[f];
        return o;
      });
      for (let i = 0; i < ups.length; i += 300) {
        await db("POST", "ping_bid_hourly?on_conflict=date,hour,destination_id",
          ups.slice(i, i + 300), "resolution=merge-duplicates,return=minimal");
      }
    }
  }
  for (let i = 0; i < bids.length; i += 150) {
    await db("POST", "ping_bids?on_conflict=id",
      bids.slice(i, i + 150), "resolution=merge-duplicates,return=minimal");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const KEY = Deno.env.get("CALLGRID_API_KEY");
  if (!KEY) return json({ error: "CALLGRID_API_KEY secret is not set" }, 500);

  // Resolve the day range.
  const today = todayET();
  let start = addDays(today, -2), end = today;
  let rebuildToday = false;
  let liveOnly = false;
  let rawBackfill: string | null = null;
  try {
    const b = await req.json();
    liveOnly = b?.live_only === true;
    const ymd = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null;
    if (ymd(b?.date)) { start = end = ymd(b.date)!; rebuildToday = start === today; }
    else if (ymd(b?.start) && ymd(b?.end)) { start = ymd(b.start)!; end = ymd(b.end)!; }
    else if (b?.days) start = addDays(today, -Math.max(0, Math.min(30, num(b.days) - 1)));
    const rb = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null;
    if (rb(b?.raw_backfill)) rawBackfill = rb(b.raw_backfill);
  } catch { /* empty body fine */ }
  if (start > end) [start, end] = [end, start];
  const days: string[] = [];
  for (let d = start; d <= end && days.length <= 31; d = addDays(d, 1)) days.push(d);
  if (days.length > 31) return json({ error: "range too large — max 31 days" }, 400);
  const includesToday = days.includes(today);

  // ════ v5: RAW BACKFILL of one day (hourly aggregates + bid rows only) ════
  if (rawBackfill) {
    const t0b = Date.now();
    try {
      const day = rawBackfill;
      const dayStart = etMidnightMs(day);
      const dayEnd = etMidnightMs(addDays(day, 1));
      const skey = "raw_backfill_" + day;
      const st = await getState(skey);
      let fromMs = num(st?.watermark_ms);
      if (!(fromMs > dayStart && fromMs <= dayEnd)) {
        fromMs = dayStart;
        await db("DELETE", `ping_bid_hourly?date=eq.${day}`);
        await db("DELETE", `ping_bids?date=eq.${day}`);
        await setState(skey, { date: day, watermark_ms: fromMs });
      }
      let fetched = 0, caught = true;
      while (fromMs < dayEnd) {
        if (fetched >= 20000 || Date.now() - t0b > 240000) { caught = false; break; }
        const sliceFrom = fromMs, sliceEnd = Math.min(sliceFrom + 1800e3, dayEnd);
        const hourAgg = new Map<string, any>(); const bids: any[] = [];
        const res = await streamRaw("/ping", KEY,
          new Date(sliceFrom).toISOString(), new Date(sliceEnd).toISOString(), t0b, (items) => {
            for (const p of items) {
              const ts = Date.parse(p.UTCISODate || p.createdAt || p["@timestamp"] || "");
              if (!Number.isFinite(ts) || ts <= sliceFrom || ts > sliceEnd) continue;
              if (etDate(new Date(ts).toISOString()) !== day) continue;
              collectRaw(p, ts, hourAgg, bids);
            }
          });
        if (!res.complete) { caught = false; break; }
        await setState(skey, { date: day, watermark_ms: sliceEnd });
        await flushRaw(hourAgg, bids);
        fetched += res.fetched; fromMs = sliceEnd;
      }
      return json({ raw_backfill: day, fetched,
        caught_up: caught && fromMs >= dayEnd,
        resume_from: new Date(fromMs).toISOString() });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      await logEvent("error", "Ping raw backfill failed", msg);
      return json({ error: msg }, 500);
    }
  }

  const t0 = Date.now();
  try {
    // v5: rolling retention on raw bid rows (table may not exist pre-migration)
    try { await db("DELETE", `ping_bids?date=lt.${addDays(today, -BID_RETENTION_DAYS)}`); } catch (_e) { /* fine */ }

    // ════ 1. ROLLUPS for closed days (authoritative) ════
    const pingRaw = liveOnly ? [] : await report("/reports/pingStats", KEY, start, end);
    const pingRows: any[] = [];
    const seenPing = new Set<string>();
    const rollupDays = new Set<string>();
    for (const p of pingRaw) {
      const date = String(p.date ?? "").slice(0, 10);
      const destId = String(p.destinationId ?? "");
      if (!date || !destId || !days.includes(date)) continue;
      const k = `${date}|${destId}`;
      if (seenPing.has(k)) continue;
      seenPing.add(k);
      rollupDays.add(date);
      const row = {
        date, destination_id: destId,
        destination_name: p.destinationName ?? null,
        accepted: num(p.accepted),
        failed_acceptance: num(p.failedAcceptance),
        failed_tag_rules: num(p.failedTagRules),
        min_revenue: num(p.minRevenue),
        missing_amount: num(p.missingAmount),
        invalid_number: num(p.invalidNumber),
        duration_elapsed: num(p.durationElapsed),
        ping_timeout: num(p.pingTimeout),
        api_failed: num(p.apiFailed),
        rate_limited: num(p.rateLimited),
        suppressed: num(p.suppressed),
        agents: num(p.agents),
        total_pings: 0,
        updated_at: new Date().toISOString(),
      };
      row.total_pings = row.accepted + row.failed_acceptance + row.failed_tag_rules +
        row.min_revenue + row.missing_amount + row.invalid_number + row.duration_elapsed +
        row.ping_timeout + row.api_failed + row.rate_limited + row.suppressed;
      pingRows.push(row);
    }

    const bidRows: any[] = [];
    for (const day of liveOnly ? [] : days) {
      if (day === today) continue; // bid rollups don't exist for today
      const [stats, rejs] = await Promise.all([
        report("/reports/bidStats", KEY, day, day),
        report("/reports/bidStats/rejections", KEY, day, day),
      ]);
      const rejBy = new Map<string, any>();
      for (const r of rejs) rejBy.set(String(r.sourceId ?? ""), r);
      for (const s of stats) {
        const srcId = String(s.sourceId ?? "");
        if (!srcId) continue;
        const rej = rejBy.get(srcId) ?? {};
        bidRows.push({
          date: day, source_id: srcId,
          source_name: s.sourceName ?? rej.source?.name ?? null,
          total_pings: num(s.total),
          bids: num(s.bids),
          won: num(s.won),
          rated: num(s.rated),
          rejected: num(s.rejected),
          total_bid_amount: num(s.totalBidAmount),
          total_won_amount: num(s.totalWonAmount),
          rej_caller_id: num(rej.callerId),
          rej_closed: num(rej.closed),
          rej_paused: num(rej.paused),
          rej_duplicate: num(rej.duplicate),
          rej_duplicate_bids: num(rej.duplicateBids),
          rej_failed_acceptance: num(rej.failedAcceptance),
          rej_failed_tag_rules: num(rej.failedTagRules),
          updated_at: new Date().toISOString(),
        });
      }
      await new Promise((res) => setTimeout(res, 150));
    }

    for (let i = 0; i < pingRows.length; i += 300) {
      await db("POST", "ping_daily_stats?on_conflict=date,destination_id",
        pingRows.slice(i, i + 300), "resolution=merge-duplicates,return=minimal");
    }
    for (let i = 0; i < bidRows.length; i += 300) {
      await db("POST", "bid_daily_stats?on_conflict=date,source_id",
        bidRows.slice(i, i + 300), "resolution=merge-duplicates,return=minimal");
    }
    // A day with official rollup rows no longer needs its live rows.
    for (const d of rollupDays) {
      await db("DELETE", `ping_daily_stats?date=eq.${d}&destination_id=like.${encodeURIComponent(LIVE_PREFIX + "*")}`);
    }

    // ════ 2. LIVE intraday pings for today (incremental, sliced) ════
    const SLICE_MS = 600e3;          // 10 minutes of raw pings per slice
    const INVOKE_RECORD_CAP = 8000;  // stop the live phase after this many raw records
    const INVOKE_WALL_MS = 60000;    // ... or this much wall time in the live phase
    const live: any = { fetched: 0, buyers: 0, slices: 0, caught_up: true,
      window_start: "", window_end: "", skipped: !includesToday };
    if (includesToday) {
      const midnight = etMidnightMs(today);
      const st = await getState("intraday_pings");
      let fromMs = num(st?.watermark_ms);
      const isFreshDay = !(fromMs > 0) || String(st?.date) !== today;
      if (rebuildToday || isFreshDay) {
        fromMs = midnight;
        await db("DELETE", `ping_daily_stats?date=eq.${today}&destination_id=like.${encodeURIComponent(LIVE_PREFIX + "*")}`);
        try { await db("DELETE", `ping_bid_hourly?date=eq.${today}`); await db("DELETE", `ping_bids?date=eq.${today}`); } catch (_e) { /* pre-migration */ }
        await setState("intraday_pings", { date: today, watermark_ms: fromMs });
      }
      live.window_start = new Date(fromMs).toISOString();
      const tLive = Date.now();
      const buyersSeen = new Set<string>();
      // "Caught up" means within NEAR_NOW of real time — chasing the live
      // edge second by second is pointless and would never terminate.
      const NEAR_NOW_MS = 120000;
      while (fromMs < Date.now() - NEAR_NOW_MS) {
        if (live.fetched >= INVOKE_RECORD_CAP || Date.now() - tLive > INVOKE_WALL_MS ||
            Date.now() - t0 > TIME_BUDGET_MS - 30000) { live.caught_up = false; break; }
        const sliceFrom = fromMs;
        const sliceEnd = Math.min(sliceFrom + SLICE_MS, Date.now() - NEAR_NOW_MS);
        const agg = new Map<string, any>();
        const hourAgg = new Map<string, any>(); const sliceBids: any[] = [];
        const res = await streamRaw("/ping", KEY,
          new Date(sliceFrom).toISOString(), new Date(sliceEnd).toISOString(), t0, (items) => {
            for (const p of items) {
              const ts = Date.parse(p.UTCISODate || p.createdAt || p["@timestamp"] || "");
              if (!Number.isFinite(ts) || ts <= sliceFrom || ts > sliceEnd) continue;
              if (etDate(new Date(ts).toISOString()) !== today) continue;
              const buyer = String(p.BuyerName ?? "").trim() || "Unknown";
              const k = buyer.toLowerCase();
              const a = agg.get(k) ?? {
                name: buyer, total_pings: 0, accepted: 0, failed_acceptance: 0,
                failed_tag_rules: 0, min_revenue: 0, ping_timeout: 0,
                api_failed: 0, rate_limited: 0, suppressed: 0,
              };
              a.total_pings++;
              if (num(p.PingAccepted)) a.accepted++;
              if (num(p.PingFailedAcceptance)) a.failed_acceptance++;
              if (num(p.PingFailedTagRules)) a.failed_tag_rules++;
              if (num(p.PingMinRevenue)) a.min_revenue++;
              if (num(p.PingTimeout)) a.ping_timeout++;
              if (num(p.PingApiFailed)) a.api_failed++;
              if (num(p.PingRateLimited)) a.rate_limited++;
              if (num(p.PingSuppressed)) a.suppressed++;
              agg.set(k, a);
              collectRaw(p, ts, hourAgg, sliceBids);
            }
          });
        if (!res.complete) {
          // Watermark untouched — the next call retries this slice.
          live.caught_up = false;
          await logEvent("error", "Ping sync live slice incomplete",
            `${today}: budget hit mid-slice after ${res.fetched} raw pings — will retry next call.`);
          break;
        }
        // Guard against a concurrent run: if the stored watermark is no
        // longer ours, someone else is advancing it — stop rather than
        // double-count.
        const cur = await getState("intraday_pings");
        if (String(cur?.date) === today && num(cur?.watermark_ms) !== sliceFrom) {
          live.caught_up = false;
          live.note = "another sync run is active — stopped to avoid double-counting";
          break;
        }
        // Advance the watermark FIRST: a failure after this point loses one
        // slice (self-heals at day close) instead of double-counting it.
        await setState("intraday_pings", { date: today, watermark_ms: sliceEnd });
        await flushRaw(hourAgg, sliceBids);
        if (agg.size > 0) {
          const existing = await dbGet(
            `ping_daily_stats?date=eq.${today}&destination_id=like.${encodeURIComponent(LIVE_PREFIX + "*")}&select=*`);
          const exBy = new Map<string, any>();
          for (const r of existing) exBy.set(String(r.destination_id), r);
          const upserts: any[] = [];
          for (const [k, a] of agg) {
            const id = LIVE_PREFIX + k.slice(0, 180);
            const ex = exBy.get(id) ?? {};
            upserts.push({
              date: today, destination_id: id, destination_name: a.name,
              total_pings: num(ex.total_pings) + a.total_pings,
              accepted: num(ex.accepted) + a.accepted,
              failed_acceptance: num(ex.failed_acceptance) + a.failed_acceptance,
              failed_tag_rules: num(ex.failed_tag_rules) + a.failed_tag_rules,
              min_revenue: num(ex.min_revenue) + a.min_revenue,
              missing_amount: num(ex.missing_amount),
              invalid_number: num(ex.invalid_number),
              duration_elapsed: num(ex.duration_elapsed),
              ping_timeout: num(ex.ping_timeout) + a.ping_timeout,
              api_failed: num(ex.api_failed) + a.api_failed,
              rate_limited: num(ex.rate_limited) + a.rate_limited,
              suppressed: num(ex.suppressed) + a.suppressed,
              agents: num(ex.agents),
              updated_at: new Date().toISOString(),
            });
          }
          for (let i = 0; i < upserts.length; i += 300) {
            await db("POST", "ping_daily_stats?on_conflict=date,destination_id",
              upserts.slice(i, i + 300), "resolution=merge-duplicates,return=minimal");
          }
        }
        live.fetched += res.fetched;
        live.slices++;
        agg.forEach((_v, k) => buyersSeen.add(k));
        fromMs = sliceEnd;
      }
      live.buyers = buyersSeen.size;
      live.window_end = new Date(fromMs).toISOString();
    }

    await logEvent("ok",
      `Ping sync — ${start}→${end}: ${pingRows.length} rollup buyer-day rows, ${bidRows.length} publisher-day rows` +
      (includesToday ? `; live today: ${live.fetched} raw pings → ${live.buyers} buyers (${live.caught_up ? "caught up" : "more to do"})` : ""));
    return json({
      start, end, days: days.length,
      rollup_ping_rows: pingRows.length, rollup_bid_rows: bidRows.length,
      live_today: live,
      seconds: Math.round((Date.now() - t0) / 1000),
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await logEvent("error", "Ping sync failed", msg);
    return json({ error: msg }, 500);
  }
});