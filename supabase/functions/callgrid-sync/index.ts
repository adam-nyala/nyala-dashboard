// callgrid-sync v13-nyala — Nyala Labs build of OmniSure's v13.
// NYALA MONEY MODEL (partner feed): Nyala reads the partner's (FourJ's)
// CallGrid. Every call's BuyerName is "Nyala Health" (Nyala itself) and the
// call's revenue is what FourJ's charges Nyala. So before any matching:
//   • VendorName := the partner (NYALA_PARTNER_NAME secret, default FourJ's)
//   • payout     := CallGrid revenue   (Nyala's cost)
//   • revenue    := 0, BuyerName := ""  (no clients from CallGrid)
// Buyer attribution (client campaign, revenue, billable) is done afterwards
// by the DB function nyala_attribute_calls(): DestinationNumber → HubSpot DID
// → Buyer Offer rate/billable duration. That function also rebuilds the
// client-side daily totals, campaign links and actuals for the window.
// Publisher side (FourJ's lanes per CallGrid campaign, pub totals, pub
// actuals) is OmniSure's v13 logic unchanged.
//
// (OmniSure v13 notes follow.)
// callgrid-sync v13 — campaign identity by CallGrid campaign ID: calls carry
// cg_campaign_id, matching tries the ID before names, a renamed CallGrid
// campaign updates its existing row in place (no more duplicate rows and no
// duplicate Zoho offers from renames), and name-matched rows adopt their ID.
// v12.2 — TV attribution reads the dialed TFN from SourceNumber
// (InboundNumber is the caller). v12.1: publisher campaigns broken out PER CALLGRID CAMPAIGN,
// mirroring the client side: the publisher row holds the relationship, each
// (vendor × CallGrid campaign) gets its own publisher_campaign with its own
// rate (modal observed payout for that lane), terms and target. Matching
// uses the new callgrid_campaign_name column; vendor-level records without
// it act as legacy fallback only. v11: call_status + telco_cost per call.
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
      dbGet("client_campaigns?select=id,name,callgrid_campaign_name,callgrid_target_name,client_id,cg_campaign_id"),
      dbGet("publisher_campaigns?select=id,name,publisher_id,callgrid_publisher_name,callgrid_campaign_name,billing_frequency,billing_type,net_terms,cg_campaign_id"),
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
      // v13: identity by CallGrid campaign ID — survives renames
      const cgPairIdx = new Map<string, string>();
      const cgOnlyIdx = new Map<string, string>();
      const ccById = new Map<string, any>();
      for (const cc of list) {
        ccById.set(cc.id, cc);
        const campKeys = nameKeys(cc.name, cc.callgrid_campaign_name);
        const buyerKeys = new Set<string>();
        for (const t of String(cc.callgrid_target_name || "").split(",")) { const k = t.trim().toLowerCase(); if (k) buyerKeys.add(k); }
        const cl: any = cc.client_id ? clientById.get(cc.client_id) : null;
        if (cl) for (const k of nameKeys(cl.name, cl.callgrid_buyer_name)) buyerKeys.add(k);
        if (buyerKeys.size) {
          for (const ck2 of campKeys) { pairCamps.add(ck2); for (const bk2 of buyerKeys) { if (!pairIndex.has(`${ck2}||${bk2}`)) pairIndex.set(`${ck2}||${bk2}`, cc.id); } }
        } else {
          for (const ck2 of campKeys) if (!campOnlyIndex.has(ck2)) campOnlyIndex.set(ck2, cc.id);
        }
        const cgid = String(cc.cg_campaign_id ?? "").trim();
        if (cgid) {
          if (buyerKeys.size) { for (const bk2 of buyerKeys) if (!cgPairIdx.has(`${cgid}||${bk2}`)) cgPairIdx.set(`${cgid}||${bk2}`, cc.id); }
          else if (!cgOnlyIdx.has(cgid)) cgOnlyIdx.set(cgid, cc.id);
        }
      }
      return { pairIndex, campOnlyIndex, pairCamps, cgPairIdx, cgOnlyIdx, ccById };
    }
    let { pairIndex, campOnlyIndex, pairCamps, cgPairIdx, cgOnlyIdx, ccById } = indexCcs(ccs);
    const linkSet = new Set(links0.map((l: any) => `${l.client_campaign_id}|${l.publisher_campaign_id}`));
    // v12: primary index is (vendor × CallGrid campaign); vendor-level rows
    // without callgrid_campaign_name are the legacy fallback
    let pcPair = new Map<string, { id: string; publisher_id: string | null }>();
    let pcLegacy = new Map<string, { id: string; publisher_id: string | null }>();
    let legacyTerms = new Map<string, any>();
    let pcCg = new Map<string, { id: string; publisher_id: string | null }>();
    let pcById = new Map<string, any>();
    function indexPcs(list: any[]) {
      pcPair = new Map(); pcLegacy = new Map(); legacyTerms = new Map(); pcCg = new Map(); pcById = new Map();
      for (const pc of list) {
        pcById.set(pc.id, pc);
        if (pc.callgrid_campaign_name) {
          const vks = nameKeys(pc.callgrid_publisher_name);
          for (const vk of vks) pcPair.set(`${vk}\u0001${String(pc.callgrid_campaign_name).trim().toLowerCase()}`, { id: pc.id, publisher_id: pc.publisher_id });
          const cgid = String(pc.cg_campaign_id ?? "").trim();
          if (cgid) for (const vk of vks) pcCg.set(`${vk}\u0001${cgid}`, { id: pc.id, publisher_id: pc.publisher_id });
        } else {
          for (const k of nameKeys(pc.name, pc.callgrid_publisher_name)) {
            pcLegacy.set(k, { id: pc.id, publisher_id: pc.publisher_id });
            legacyTerms.set(k, { billing_frequency: pc.billing_frequency, billing_type: pc.billing_type, net_terms: pc.net_terms });
          }
        }
      }
    }
    indexPcs(pcs);
    const numIndex = new Map<string, string>();
    for (const n of tvNums) numIndex.set(digits(n.number).slice(-10), n.id);
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

    // ── 2a. Nyala: re-express partner calls in Nyala's money model ──────
    const PARTNER = (Deno.env.get("NYALA_PARTNER_NAME") ?? "FourJ's").trim() || "FourJ's";
    for (const c of all) {
      const partnerCharge = Number(c.revenue ?? c.RevenueAmount ?? 0) || 0;
      c._sourceBillable = Number(c.billable ?? 0) > 0 || Number(c.paid ?? 0) > 0;
      c.VendorName = String(c.VendorName ?? "").trim() || PARTNER;
      c.payout = partnerCharge;   // what the partner bills Nyala for this call
      c.revenue = 0;              // Nyala's revenue: set by DID attribution
      c.BuyerName = "";           // "Nyala Health" is Nyala, never a client
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
      const cid0 = String(c.CampaignId ?? "").trim();
      const rev = Number(c.revenue ?? 0), pay = Number(c.payout ?? 0);
      if (cn && rev > 0) { const pk = cn + "\u0001" + bn; const s = pairStats.get(pk) ?? { cn, bn, revs: [], cid: cid0 }; s.revs.push(rev); if (!s.cid) s.cid = cid0; pairStats.set(pk, s); }
      if (vn && cn) { const vk = vn + "\u0001" + cn; const s = vendStats.get(vk) ?? { vn, cn, n: 0, pays: [], cid: cid0 }; s.n++; if (pay > 0) s.pays.push(pay); if (!s.cid) s.cid = cid0; vendStats.set(vk, s); }
      if (bn && rev > 0) buyerRev.set(bn, (buyerRev.get(bn) ?? 0) + rev);
    }
    const created = { clients: [] as string[], campaigns: [] as string[], publishers: [] as string[], renamed: [] as string[], adopted: 0 };
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
      const cid = String(s.cid ?? "").trim();
      // v13 identity order: CallGrid campaign ID first. A hit under another
      // name is a RENAME in CallGrid → update the existing row, never create.
      if (cid) {
        const hitId = (s.bn ? cgPairIdx.get(`${cid}||${bk}`) : null) ?? cgOnlyIdx.get(cid) ?? null;
        if (hitId) {
          const row = ccById.get(hitId);
          if (row && String(row.callgrid_campaign_name || "").trim() !== s.cn) {
            const patch: any = { callgrid_campaign_name: s.cn };
            if (String(row.name || "").trim() === String(row.callgrid_campaign_name || "").trim()) patch.name = s.cn;
            await db("PATCH", `client_campaigns?id=eq.${hitId}`, patch);
            created.renamed.push(`${row.callgrid_campaign_name} → ${s.cn} (buyer)`);
            row.callgrid_campaign_name = s.cn; if (patch.name) row.name = s.cn;
          }
          continue;
        }
      }
      // name hit on a row that predates IDs → adopt the ID onto it
      const nameHitId = s.bn ? (pairIndex.get(`${ck}||${bk}`) ?? null)
        : ((pairCamps.has(ck) || campOnlyIndex.has(ck)) ? (campOnlyIndex.get(ck) ?? "KEEP") : null);
      if (nameHitId) {
        if (cid && nameHitId !== "KEEP") {
          const row = ccById.get(nameHitId);
          if (row && !String(row.cg_campaign_id ?? "").trim()) {
            await db("PATCH", `client_campaigns?id=eq.${nameHitId}`, { cg_campaign_id: cid });
            row.cg_campaign_id = cid; created.adopted++;
            const bks = s.bn ? [bk] : [];
            if (bks.length) { for (const b2 of bks) cgPairIdx.set(`${cid}||${b2}`, nameHitId); } else cgOnlyIdx.set(cid, nameHitId);
          }
        }
        continue;
      }
      await db("POST", "client_campaigns", [{
        name: s.cn, callgrid_campaign_name: s.cn,
        cg_campaign_id: cid || null,
        callgrid_target_name: s.bn || null,
        client_id: s.bn ? (clientIdx.get(bk) ?? null) : null,
        price_per_call: mode(s.revs), vertical: vertOf(s.cn), duration_seconds: durOf(s.cn),
        // default buyer terms until the real ones are set (per Emily)
        billing_frequency: "weekly", billing_type: "net_terms", net_terms: 7,
        start_date: today, active: true,
      }]);
      created.campaigns.push(s.bn ? `${s.cn} — ${s.bn}` : s.cn);
    }
    for (const [, s] of vendStats) {
      // one publisher_campaign per (vendor × CallGrid campaign), like clients;
      // skip trickles (under 3 calls and no payout) so stray tests don't spawn rows
      const cid = String(s.cid ?? "").trim();
      const vk0 = s.vn.toLowerCase();
      if (cid) {
        const hit = pcCg.get(`${vk0}\u0001${cid}`);
        if (hit) {
          const row = pcById.get(hit.id);
          if (row && String(row.callgrid_campaign_name || "").trim() !== s.cn) {
            const patch: any = { callgrid_campaign_name: s.cn };
            if (String(row.name || "").trim() === String(row.callgrid_campaign_name || "").trim()) patch.name = s.cn;
            await db("PATCH", `publisher_campaigns?id=eq.${hit.id}`, patch);
            created.renamed.push(`${row.callgrid_campaign_name} → ${s.cn} (${s.vn})`);
            row.callgrid_campaign_name = s.cn; if (patch.name) row.name = s.cn;
          }
          continue;
        }
      }
      const nameHit = pcPair.get(`${vk0}\u0001${s.cn.toLowerCase()}`);
      if (nameHit) {
        if (cid) {
          const row = pcById.get(nameHit.id);
          if (row && !String(row.cg_campaign_id ?? "").trim()) {
            await db("PATCH", `publisher_campaigns?id=eq.${nameHit.id}`, { cg_campaign_id: cid });
            row.cg_campaign_id = cid; created.adopted++;
            pcCg.set(`${vk0}\u0001${cid}`, nameHit);
          }
        }
        continue;
      }
      if (s.n < 3 && !s.pays.length) continue;
      const enc = encodeURIComponent(s.vn);
      let pub = (await dbGet(`publishers?select=id&name=ilike.${enc}`))[0];
      if (!pub) {
        await db("POST", "publishers", [{ name: s.vn, is_internal: /internal/i.test(s.vn) }]);
        pub = (await dbGet(`publishers?select=id&name=ilike.${enc}`))[0];
      }
      // inherit billing terms from the vendor's legacy record when one exists
      const lt = legacyTerms.get(s.vn.toLowerCase()) ?? {};
      await db("POST", "publisher_campaigns", [{
        name: s.cn, callgrid_publisher_name: s.vn, callgrid_campaign_name: s.cn,
        cg_campaign_id: cid || null,
        publisher_id: pub?.id ?? null,
        cost_per_call: mode(s.pays), vertical: vertOf(s.cn),
        // inherit legacy terms; otherwise default pub terms (per Emily)
        billing_frequency: lt.billing_frequency ?? "monthly",
        billing_type: lt.billing_type ?? "net_terms",
        net_terms: lt.net_terms ?? 30,
        start_date: today, active: true,
      }]);
      created.publishers.push(`${s.vn} — ${s.cn}`);
    }
    if (created.campaigns.length || created.publishers.length) {
      const [ccs2, pcs2] = await Promise.all([
        dbGet("client_campaigns?select=id,name,callgrid_campaign_name,callgrid_target_name,client_id,cg_campaign_id"),
        dbGet("publisher_campaigns?select=id,name,publisher_id,callgrid_publisher_name,callgrid_campaign_name,billing_frequency,billing_type,net_terms,cg_campaign_id"),
      ]);
      for (const c of clientRows) clientById.set(c.id, c);
      ({ pairIndex, campOnlyIndex, pairCamps, cgPairIdx, cgOnlyIdx, ccById } = indexCcs(ccs2));
      indexPcs(pcs2);
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
      const cgId = String(c.CampaignId ?? "").trim();
      // Nyala: the client campaign comes from DID attribution (step 6), never
      // from CallGrid names — the partner's buyer is always Nyala itself.
      const ccId: string | null = null;
      void ckey; void bkey; void cgPairIdx; void cgOnlyIdx; void pairIndex; void pairCamps; void campOnlyIndex;
      const pc = (cgId ? pcCg.get(`${vendorName.toLowerCase()}\u0001${cgId}`) : null) ?? pcPair.get(`${vendorName.toLowerCase()}\u0001${campaignName.toLowerCase()}`) ?? pcLegacy.get(vendorName.toLowerCase()) ?? null;
      void unmatchedCampaigns;
      if (vendorName && !pc) unmatchedPublishers.add(vendorName);

      const date = etDate(iso);
      // TV attribution via the dialed tracking number
      let tv: any = { tv_network_id: null, tv_campaign_id: null, tv_creative_id: null, is_tv_call: false };
      // v12.2: the dialed TFN lives in SourceNumber (InboundNumber is the
      // CALLER's number). RTB sources carry "Variable" and never match.
      const srcDigits = digits(c.SourceNumber);
      const numId = srcDigits.length >= 10 ? numIndex.get(srcDigits.slice(-10)) : undefined;
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
        billable: false,                          // buyer-billable: set by attribution
        source_billable: c._sourceBillable,       // partner billed Nyala for it
        destination_number: String(c.DestinationNumber ?? "").trim() || null,
        call_length_seconds: Number(c.callDuration ?? 0),
        revenue: Number(c.revenue ?? 0),
        payout: Number(c.payout ?? 0),
        // v11: line health + per-call telco cost for the daily brief
        call_status: String(c.CallStatus ?? c.callStatus ?? "").trim() || null,
        telco_cost: Number(c.cost ?? 0),
        cg_campaign_id: cgId || null,
        // Nyala: the partner feed has no SourceNumber, and InboundNumber is the
        // caller — never store the caller as a dialed TFN
        dialed_number: digits(c.SourceNumber).length >= 10 ? c.SourceNumber : null,
        caller_id: c.CallerId ?? null,
        _billable: c._sourceBillable,
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
    const aggPub = new Map<string, any>();
    for (const r of rows) {
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

    // ── 6. Nyala: attribute the window's calls to buyers by DID ─────────
    //        (also rebuilds client daily totals, campaign links and actuals)
    const rpc = await sbFetch(`${SB_URL}/rest/v1/rpc/nyala_attribute_calls`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_from: winStart, p_to: winEnd }),
    });
    if (!rpc.ok) throw new Error(`nyala_attribute_calls: ${rpc.status} ${(await rpc.text()).slice(0, 200)}`);
    const attribution = await rpc.json();

    await logEvent("ok", `Call sync — ${clean.length} records (${etDate(startDate.toISOString())} → ${etDate(endDate.toISOString())})`);
    for (const n of created.clients) await logEvent("ok", `Auto-created client: ${n}`);
    for (const n of created.campaigns) await logEvent("ok", `Auto-created campaign: ${n}`);
    for (const n of created.publishers) await logEvent("ok", `Auto-created publisher: ${n}`);
    return json({
      inserted: clean.length,
      attribution,                       // {attributed, unattributed, changed}
      renamed_campaigns: created.renamed,
      adopted_ids: created.adopted,
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
  } catch (e: any) {
    await logEvent("error", "Call sync failed", String(e?.message ?? e));
    return json({ error: String(e?.message ?? e) }, 500);
  }
});