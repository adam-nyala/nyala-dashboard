// callgrid-sync v10 — full sync engine (replaces the v1 proxy)
// v10: stores the full CallGrid DestinationName (buyer + offer + rate,
// e.g. "Clarifying Financial - Final Expense - CTV - $55/30s") on every
// call as destination_name; target_name stays the plain buyer.
// Fetches calls from CallGrid, matches campaigns/publishers/TV numbers,
// upserts callgrid_calls, rebuilds daily totals + pub actuals, then calls
// rebuild_callgrid_actuals(). The CallGrid API key and all DB writes stay
// server-side. POST body (optional): { days_back }
//
// Matching mirrors FE Finance behavior: a campaign/publisher matches if the
// CallGrid name equals the record's own name OR any comma-separated variant
// in its callgrid_campaign_name / callgrid_publisher_name field
// (case-insensitive, trimmed).

const CALLGRID_API = "https://api.callgrid.com/api/call";
const ET = "America/New_York";

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

// Supabase's gateway occasionally rejects the first calls of a cold run
// with a transient 401/5xx (observed in production logs). Retry briefly
// with backoff before treating any DB call as fatal.
async function sbFetch(url: string, opts: RequestInit): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < 3; i++) {
    last = await fetch(url, opts);
    if (last.ok || ![401, 408, 429, 500, 502, 503, 504].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 350 * (i + 1)));
  }
  return last!;
}

async function db(method: string, path: string, body?: unknown) {
  const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

async function dbGet(path: string) {
  const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`DB GET ${path.split("?")[0]}: ${r.status}`);
  return r.json();
}

// Integration status-page plumbing: every run reports into integration_log
// and updates the callgrid row in integration_systems. Logging is
// best-effort — a logging failure never fails the sync itself.
async function logEvent(status: "ok" | "error", event: string, detail?: string) {
  try {
    await db("POST", "integration_log", [{
      system: "callgrid", direction: "inbound", event, status,
      detail: detail ? String(detail).slice(0, 800) : null,
    }]);
    await db("PATCH", "integration_systems?id=eq.callgrid",
      status === "ok"
        ? { last_ok_at: new Date().toISOString() }
        : { last_error_at: new Date().toISOString(), last_error: String(detail ?? event).slice(0, 500) });
  } catch (_e) { /* best-effort */ }
}

// "Name A, name-b" → ["name a","name-b"]; matching keys for a record
function nameKeys(...fields: (string | null | undefined)[]) {
  const keys = new Set<string>();
  for (const f of fields) {
    for (const part of String(f ?? "").split(",")) {
      const k = part.trim().toLowerCase();
      if (k) keys.add(k);
    }
  }
  return keys;
}

const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

// Date of a UTC instant in Eastern Time, as YYYY-MM-DD
function etDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: ET });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const KEY = Deno.env.get("CALLGRID_API_KEY");
  if (!KEY) return json({ error: "CALLGRID_API_KEY secret is not set" }, 500);

  let daysBack = 7;
  let explicitStart: string | null = null;
  let explicitEnd: string | null = null;
  try {
    const b = await req.json();
    if (b && b.days_back) daysBack = Math.max(1, Math.min(21, Number(b.days_back)));
    if (b && b.start_date && b.end_date) {
      explicitStart = String(b.start_date);
      explicitEnd = String(b.end_date);
      const spanDays = (Date.parse(explicitEnd) - Date.parse(explicitStart)) / 86400e3;
      if (!(spanDays > 0) || spanDays > 21) {
        return json({ error: "start_date/end_date span must be 1–21 days — send larger backfills as multiple slices" }, 400);
      }
    }
  } catch { /* empty body (auto-sync) is fine */ }

  try {
    // ── 1. Load matching config ─────────────────────────────────────────
    const [ccs, pcs, tvNums, tvAssigns, clientRows0, links0] = await Promise.all([
      dbGet("client_campaigns?select=id,name,callgrid_campaign_name,callgrid_target_name,client_id"),
      dbGet("publisher_campaigns?select=id,name,publisher_id,callgrid_publisher_name"),
      dbGet("tv_phone_numbers?select=id,number"),
      dbGet("tv_number_assignments?select=phone_number_id,network_id,tv_campaign_id,creative_id,valid_from,valid_to"),
      dbGet("clients?select=id,name,callgrid_buyer_name"),
      dbGet("campaign_links?select=client_campaign_id,publisher_campaign_id"),
    ]);
    // Buyer×campaign matching: in CallGrid the buyer IS the client and
    // campaigns are shared across buyers, so a call attaches to the client
    // campaign for its (campaign, buyer) PAIR. A campaign row with a buyer
    // (an explicit CallGrid buyer name, or its client's) is pair-scoped;
    // rows with neither stay campaign-only fallbacks.
    const clientById = new Map(clientRows0.map((c: any) => [c.id, c]));
    function indexCcs(list: any[]) {
      const pairIndex = new Map<string, string>();
      const campOnlyIndex = new Map<string, string>();
      const pairCamps = new Set<string>();
      for (const cc of list) {
        const campKeys = nameKeys(cc.name, cc.callgrid_campaign_name);
        const buyerKeys = new Set<string>();
        for (const t of String(cc.callgrid_target_name || "").split(",")) { const k = t.trim().toLowerCase(); if (k) buyerKeys.add(k); }
        const cl = cc.client_id ? clientById.get(cc.client_id) : null;
        if (cl) for (const k of nameKeys(cl.name, cl.callgrid_buyer_name)) buyerKeys.add(k);
        if (buyerKeys.size) {
          for (const ck2 of campKeys) { pairCamps.add(ck2); for (const bk2 of buyerKeys) { if (!pairIndex.has(`${ck2}||${bk2}`)) pairIndex.set(`${ck2}||${bk2}`, cc.id); } }
        } else {
          for (const ck2 of campKeys) if (!campOnlyIndex.has(ck2)) campOnlyIndex.set(ck2, cc.id);
        }
      }
      return { pairIndex, campOnlyIndex, pairCamps };
    }
    let { pairIndex, campOnlyIndex, pairCamps } = indexCcs(ccs);
    const linkSet = new Set(links0.map((l: any) => `${l.client_campaign_id}|${l.publisher_campaign_id}`));
    const pcIndex = new Map<string, { id: string; publisher_id: string | null }>();
    for (const pc of pcs) for (const k of nameKeys(pc.name, pc.callgrid_publisher_name)) pcIndex.set(k, { id: pc.id, publisher_id: pc.publisher_id });
    const numIndex = new Map<string, string>();
    for (const n of tvNums) numIndex.set(digits(n.number), n.id);
    const assignsByNum = new Map<string, any[]>();
    for (const a of tvAssigns) {
      const arr = assignsByNum.get(a.phone_number_id) ?? [];
      arr.push(a); assignsByNum.set(a.phone_number_id, arr);
    }

    // ── 2. Fetch calls from CallGrid ────────────────────────────────────
    const endDate = explicitEnd ? new Date(explicitEnd) : new Date();
    const startDate = explicitStart ? new Date(explicitStart) : new Date(endDate.getTime() - daysBack * 24 * 3600e3);
    const all: any[] = [];
    let searchAfter: unknown = null;
    let retries = 0;
    for (let guard = 0; guard < 400; guard++) {
      const params = new URLSearchParams({
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        useCursor: "true",
        maxItems: "100",
        reportTimeZone: "US/Eastern",
      });
      if (searchAfter !== null) params.set("searchAfter", JSON.stringify(searchAfter));
      const r = await fetch(`${CALLGRID_API}?${params}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${KEY}` },
      });
      if (r.status === 429) {
        if (++retries > 5) { await logEvent("error", "Call sync failed", "CallGrid rate limit persisted"); return json({ error: "CallGrid rate limit persisted" }, 502); }
        const reset = Number(r.headers.get("RateLimit-Reset") ?? "2");
        await new Promise((res) => setTimeout(res, Math.min(reset, 15) * 1000));
        continue;
      }
      if (!r.ok) { const d = (await r.text()).slice(0, 400); await logEvent("error", "Call sync failed", `CallGrid HTTP ${r.status}: ${d}`); return json({ error: `CallGrid HTTP ${r.status}`, detail: d }, 502); }
      retries = 0;
      const payload = await r.json();
      const data = payload.data ?? [];
      all.push(...(Array.isArray(data) ? data : (data.items ?? [])));
      if (!payload.hasMore || payload.nextCursor == null) break;
      searchAfter = payload.nextCursor;
      await new Promise((res) => setTimeout(res, 400));
    }

    // ── 2b. Auto-create entities first seen in call traffic ─────────────
    // New buyers → clients; new campaigns → client_campaigns (dominant buyer,
    // modal observed revenue, parsed vertical/duration); new vendors →
    // publishers + publisher_campaigns (modal observed payout).
    const vertOf = (n: string) =>
      /final expense|(^|\W)fe(\W|$)/i.test(n) ? "Final Expense" :
      /medicare/i.test(n) ? "Medicare" :
      /(^|\W)aca(\W|$)/i.test(n) ? "ACA" :
      /u65/i.test(n) ? "U65" : null;
    const durOf = (n: string) => { const m = n.match(/\b(15|30|60)\s*s\b/i); return m ? m[1] : null; };
    const mode = (arr: number[]) => {
      if (!arr.length) return null;
      const f = new Map<number, number>(); let best: number | null = null, bc = 0;
      for (const v of arr) { const c = (f.get(v) ?? 0) + 1; f.set(v, c); if (c > bc) { bc = c; best = v; } }
      return best;
    };
    const today = new Date().toISOString().slice(0, 10);
    const pairStats = new Map<string, any>(), vendStats = new Map<string, any>(), buyerRev = new Map<string, number>();
    for (const c of all) {
      if (c.CallStatus === "IN_PROGRESS" || c.callStatus === "IN_PROGRESS" || c.live === 1) continue;
      const cn = (c.CampaignName ?? "").trim(), vn = (c.VendorName ?? "").trim(), bn = (c.BuyerName ?? "").trim();
      const rev = Number(c.revenue ?? 0), pay = Number(c.payout ?? 0);
      if (cn && rev > 0) { const pk = cn + "\u0001" + bn; const s = pairStats.get(pk) ?? { cn, bn, revs: [] }; s.revs.push(rev); pairStats.set(pk, s); }
      if (vn) { const s = vendStats.get(vn) ?? { pays: [] }; if (pay > 0) s.pays.push(pay); vendStats.set(vn, s); }
      if (bn && rev > 0) buyerRev.set(bn, (buyerRev.get(bn) ?? 0) + rev);
    }
    const created = { clients: [] as string[], campaigns: [] as string[], publishers: [] as string[] };
    let clientRows = await dbGet("clients?select=id,name,callgrid_buyer_name");
    function buildClientIdx(rows: any[]) {
      const m = new Map<string, string>();
      for (const c of rows) for (const k of nameKeys(c.name, c.callgrid_buyer_name)) m.set(k, c.id);
      return m;
    }
    let clientIdx = buildClientIdx(clientRows);
    for (const [bn] of buyerRev) {
      if (!clientIdx.has(bn.toLowerCase())) { await db("POST", "clients", [{ name: bn, callgrid_buyer_name: bn }]); created.clients.push(bn); }
    }
    if (created.clients.length) {
      clientRows = await dbGet("clients?select=id,name,callgrid_buyer_name");
      clientIdx = buildClientIdx(clientRows);
    }
    for (const [, s] of pairStats) {
      const ck = s.cn.toLowerCase(), bk = s.bn.toLowerCase();
      if (s.bn) {
        if (pairIndex.has(`${ck}||${bk}`)) continue;
      } else {
        if (pairCamps.has(ck) || campOnlyIndex.has(ck)) continue;
      }
      await db("POST", "client_campaigns", [{
        name: s.cn, callgrid_campaign_name: s.cn,
        callgrid_target_name: s.bn || null,
        client_id: s.bn ? (clientIdx.get(bk) ?? null) : null,
        price_per_call: mode(s.revs), vertical: vertOf(s.cn), duration_seconds: durOf(s.cn),
        start_date: today, active: true,
      }]);
      created.campaigns.push(s.bn ? `${s.cn} — ${s.bn}` : s.cn);
    }
    for (const [vn, s] of vendStats) {
      if (pcIndex.has(vn.toLowerCase())) continue;
      const enc = encodeURIComponent(vn);
      let pub = (await dbGet(`publishers?select=id&name=ilike.${enc}`))[0];
      if (!pub) {
        await db("POST", "publishers", [{ name: vn, is_internal: /internal/i.test(vn) }]);
        pub = (await dbGet(`publishers?select=id&name=ilike.${enc}`))[0];
      }
      await db("POST", "publisher_campaigns", [{
        name: vn, callgrid_publisher_name: vn, publisher_id: pub?.id ?? null,
        cost_per_call: mode(s.pays), start_date: today, active: true,
      }]);
      created.publishers.push(vn);
    }
    if (created.campaigns.length || created.publishers.length) {
      const [ccs2, pcs2] = await Promise.all([
        dbGet("client_campaigns?select=id,name,callgrid_campaign_name,callgrid_target_name,client_id"),
        dbGet("publisher_campaigns?select=id,name,publisher_id,callgrid_publisher_name"),
      ]);
      for (const c of clientRows) clientById.set(c.id, c);
      ({ pairIndex, campOnlyIndex, pairCamps } = indexCcs(ccs2));
      pcIndex.clear();
      for (const pc of pcs2) for (const k of nameKeys(pc.name, pc.callgrid_publisher_name)) pcIndex.set(k, { id: pc.id, publisher_id: pc.publisher_id });
    }

    // ── 3. Map + match ──────────────────────────────────────────────────
    const unmatchedCampaigns = new Set<string>();
    const unmatchedPublishers = new Set<string>();
    const rows: any[] = [];
    for (const c of all) {
      if (c.CallStatus === "IN_PROGRESS" || c.callStatus === "IN_PROGRESS" || c.live === 1) continue; // settle first
      const iso = c.UTCISODate || c.createdAt;
      if (!iso || !(c.CallId || c.id)) continue;
      const campaignName = (c.CampaignName ?? "").trim();
      const vendorName = (c.VendorName ?? "").trim();
      const buyerName = (c.BuyerName ?? "").trim();
      const ckey = campaignName.toLowerCase(), bkey = buyerName.toLowerCase();
      let ccId: string | null = null;
      if (campaignName) {
        if (buyerName) ccId = pairIndex.get(`${ckey}||${bkey}`) ?? null;
        if (!ccId && !pairCamps.has(ckey)) ccId = campOnlyIndex.get(ckey) ?? null;
      }
      const pc = pcIndex.get(vendorName.toLowerCase()) ?? null;
      if (campaignName && !ccId) unmatchedCampaigns.add(buyerName ? `${campaignName} \u2190 ${buyerName}` : campaignName);
      if (vendorName && !pc) unmatchedPublishers.add(vendorName);

      const date = etDate(iso);
      // TV attribution via the dialed tracking number
      let tv: any = { tv_network_id: null, tv_campaign_id: null, tv_creative_id: null, is_tv_call: false };
      const numId = numIndex.get(digits(c.InboundNumber));
      if (numId) {
        const hit = (assignsByNum.get(numId) ?? []).find((a) =>
          (!a.valid_from || a.valid_from <= date) && (!a.valid_to || a.valid_to >= date)
        );
        if (hit) tv = { tv_network_id: hit.network_id, tv_campaign_id: hit.tv_campaign_id, tv_creative_id: hit.creative_id, is_tv_call: true };
      }

      rows.push({
        inbound_call_id: String(c.CallId || c.id),
        date,
        call_datetime: iso,
        campaign_name: campaignName || null,
        client_campaign_id: ccId,
        publisher_name: vendorName || null,
        publisher_campaign_id: pc?.id ?? null,
        target_name: (c.BuyerName ?? "").trim() || null,
        destination_name: (c.DestinationName ?? "").trim() || null,
        connected: Number(c.connected ?? 0) > 0 || c.CallConnected === true,
        billable: Number(c.billable ?? 0) > 0 || Number(c.paid ?? 0) > 0,
        call_length_seconds: Number(c.callDuration ?? 0),
        revenue: Number(c.revenue ?? 0),
        payout: Number(c.payout ?? 0),
        dialed_number: c.InboundNumber ?? null,
        caller_id: c.CallerId ?? null,
        _billable: Number(c.billable ?? 0) > 0 || Number(c.paid ?? 0) > 0,
        _pub: pc,
        ...tv,
      });
    }

    // ── 3b. Auto-create campaign links (client campaign ↔ publisher campaign)
    //        from observed traffic, so Configuration's Linked Pubs stay current.
    const newLinks: any[] = [];
    for (const r of rows) {
      if (!r.client_campaign_id || !r.publisher_campaign_id) continue;
      const lk = `${r.client_campaign_id}|${r.publisher_campaign_id}`;
      if (linkSet.has(lk)) continue;
      linkSet.add(lk);
      newLinks.push({ client_campaign_id: r.client_campaign_id, publisher_campaign_id: r.publisher_campaign_id });
    }
    for (let i = 0; i < newLinks.length; i += 200) await db("POST", "campaign_links", newLinks.slice(i, i + 200));

    // ── 4. Upsert calls (chunked) ───────────────────────────────────────
    const clean = rows.map(({ _billable, _pub, ...r }) => r);
    for (let i = 0; i < clean.length; i += 500) {
      await db("POST", "callgrid_calls?on_conflict=inbound_call_id", clean.slice(i, i + 500));
    }

    // ── 5. Rebuild daily totals + pub actuals for the window ────────────
    const winStart = etDate(startDate.toISOString());
    const winEnd = etDate(endDate.toISOString());
    const win = `date=gte.${winStart}&date=lte.${winEnd}`;
    const agg = new Map<string, any>();
    const aggPub = new Map<string, any>();
    for (const r of rows) {
      const ck = `${r.date}__${r.client_campaign_id ?? r.campaign_name ?? ""}`;
      const a = agg.get(ck) ?? { date: r.date, callgrid_campaign_name: r.campaign_name ?? "", client_campaign_id: r.client_campaign_id, total_calls: 0, billable_calls: 0 };
      if (r.connected) a.total_calls++; if (r._billable) a.billable_calls++;
      agg.set(ck, a);
      if (r.publisher_name) {
        const pk = `${r.date}__${r.publisher_campaign_id ?? r.publisher_name}`;
        const p = aggPub.get(pk) ?? {
          date: r.date, callgrid_publisher_name: r.publisher_name, publisher_campaign_id: r.publisher_campaign_id,
          publisher_id: r._pub?.publisher_id ?? null, total_calls: 0, billable_calls: 0, paid_calls: 0, pub_cost: 0,
        };
        if (r.connected) p.total_calls++; if (r._billable) p.billable_calls++;
        if (r.payout > 0) { p.paid_calls++; p.pub_cost += r.payout; }
        aggPub.set(pk, p);
      }
    }
    await db("DELETE", `callgrid_daily_totals?${win}`);
    if (agg.size) await db("POST", "callgrid_daily_totals", [...agg.values()]);
    await db("DELETE", `callgrid_daily_totals_pub?${win}`);
    if (aggPub.size) {
      await db("POST", "callgrid_daily_totals_pub",
        [...aggPub.values()].map(({ paid_calls, pub_cost, publisher_id, ...t }) => t));
    }
    await db("DELETE", `pub_actuals?source=eq.callgrid&${win}`);
    const pubActs = [...aggPub.values()].filter((p) => p.pub_cost > 0).map((p) => ({
      date: p.date, publisher_campaign_id: p.publisher_campaign_id, publisher_name: p.callgrid_publisher_name,
      publisher_id: p.publisher_id, paid_calls: p.paid_calls, pub_cost: Math.round(p.pub_cost * 100) / 100,
      source: "callgrid", callgrid_id: `${p.date}__${p.publisher_campaign_id ?? p.callgrid_publisher_name}`,
    }));
    for (let i = 0; i < pubActs.length; i += 500) {
      await db("POST", "pub_actuals?on_conflict=callgrid_id", pubActs.slice(i, i + 500));
    }

    // ── 6. Rebuild client-side actuals via DB function ──────────────────
    const rpc = await fetch(`${SB_URL}/rest/v1/rpc/rebuild_callgrid_actuals`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!rpc.ok) throw new Error(`rebuild_callgrid_actuals: ${rpc.status}`);

    await logEvent("ok", `Call sync — ${clean.length} records (${etDate(startDate.toISOString())} → ${etDate(endDate.toISOString())})`);
    for (const n of created.clients) await logEvent("ok", `Auto-created client: ${n}`);
    for (const n of created.campaigns) await logEvent("ok", `Auto-created campaign: ${n}`);
    for (const n of created.publishers) await logEvent("ok", `Auto-created publisher: ${n}`);
    return json({
      inserted: clean.length,
      created_clients: created.clients,
      created_campaigns: created.campaigns,
      created_publishers: created.publishers,
      created_links: newLinks.length,
      fetched: all.length,
      skipped_live: all.length - rows.length,
      unmatched_campaigns: unmatchedCampaigns.size,
      unmatched_campaign_names: [...unmatchedCampaigns].slice(0, 10),
      unmatched_publishers: unmatchedPublishers.size,
      unmatched_publisher_names: [...unmatchedPublishers].slice(0, 10),
    });
  } catch (e) {
    await logEvent("error", "Call sync failed", String(e?.message ?? e));
    return json({ error: String(e?.message ?? e) }, 500);
  }
});