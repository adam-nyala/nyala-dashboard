// io-match v2-nyala — signed IO → campaign association through HubSpot
// Agreement Campaign Link records (Nyala build of OmniSure's io-match v2;
// the matching rules below are OmniSure's, unchanged).
//
//   { dry_run: true } (or empty)  → READ-ONLY report: unlinked recent IOs
//       (no direct link AND no active Agreement Campaign Link), candidates
//       with exact ids, outcome classification. Writes nothing.
//   { auto_link: true }            → creates a link ONLY for
//       single_high_confidence outcomes, Link Source "Auto High Confidence".
//       Idempotent; everything else stays in the review queue. Hourly cron.
//   { apply: true, links: [{ contract_crm_id, campaign_crm_id, coverage_note? }] }
//       → signed-in staff: one link per pair after verifying both records,
//       account match, side match, and no existing active link.
//   { apply: true, supersede: [{ link_crm_id, status, note? }] }
//       → marks a link Amended/Superseded/Removed (status only, record kept).
//
// Rules: stable HubSpot ids only; no duplicates; no overwrites; every write
// logged who/what/when.
// ---- shared helpers (inlined so this function is one file) ----
// [db.ts]
// db.ts — Supabase REST helpers shared by Nyala's edge functions.
// Service-role access; every call retries Supabase's occasional cold-start
// 401/5xx before giving up (same pattern as callgrid-sync).

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
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

async function db(method: string, path: string, body?: unknown, prefer?: string): Promise<Response> {
  const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json",
      Prefer: prefer ?? (method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=minimal"),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}

// GET every row (pages of 1000, Supabase's per-request cap)
async function dbAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await sbFetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    });
    if (!r.ok) throw new Error(`DB GET ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// upsert in chunks
async function upsert(table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 200) {
    await db("POST", `${table}?on_conflict=${onConflict}`, rows.slice(i, i + 200), "resolution=merge-duplicates,return=minimal");
  }
}

async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const r = await sbFetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`RPC ${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const STAFF_ROLES = ["admin", "staff", "operations", "finance", "sales"];

// The signed-in dashboard user behind a request (the anon key has none).
async function requireUser(req: Request): Promise<{ id: string; email: string; role: string } | null> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u?.id) return null;
    const prof = await dbAll(`user_profiles?user_id=eq.${u.id}&select=role`);
    return { id: u.id, email: String(u.email ?? ""), role: String(prof?.[0]?.role ?? "") };
  } catch (_e) { return null; }
}

async function logEvent(system: string, status: "ok" | "error", event: string, detail?: string,
  direction: "inbound" | "outbound" | "internal" = "inbound", entity?: { type?: string; id?: string }) {
  try {
    await db("POST", "integration_log", [{
      system, direction, event, status,
      detail: detail ? String(detail).slice(0, 800) : null,
      entity_type: entity?.type ?? null, entity_id: entity?.id ?? null,
    }], "return=minimal");
  } catch (_e) { /* best-effort */ }
}
async function markSystem(system: string, ok: boolean, err?: string) {
  try {
    await db("PATCH", `integration_systems?id=eq.${system}`, ok
      ? { last_ok_at: new Date().toISOString(), last_error: null }
      : { last_error_at: new Date().toISOString(), last_error: String(err ?? "").slice(0, 500) });
  } catch (_e) { /* best-effort */ }
}

// [hubspot.ts]
// hubspot.ts — HubSpot API helpers for Nyala's edge functions.
// Secret: HUBSPOT_TOKEN — a HubSpot private-app access token. Scopes needed:
//   crm.objects.companies.read/write, crm.objects.contacts.read,
//   crm.objects.custom.read/write, crm.schemas.custom.read/write,
//   crm.schemas.companies.read/write, crm.objects.owners.read

const HUBSPOT_API = "https://api.hubapi.com";

function hubspotToken(): string {
  const t = Deno.env.get("HUBSPOT_TOKEN");
  if (!t) throw new Error("HUBSPOT_TOKEN secret is not set in Supabase (Edge Functions → Secrets).");
  return t;
}

class HubSpotError extends Error {
  status: number; category?: string; body?: any;
  constructor(msg: string, status: number, body?: any) { super(msg); this.status = status; this.category = body?.category; this.body = body; }
}

// One HubSpot call. Retries rate limits (429) and transient 5xx with backoff.
async function hs(path: string, init: RequestInit = {}): Promise<any> {
  let last: HubSpotError | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${HUBSPOT_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${hubspotToken()}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    const text = await r.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 300) }; }
    if (r.ok) return body;
    last = new HubSpotError(body?.message || `HubSpot ${r.status}`, r.status, body);
    if (r.status === 429 || r.status >= 500) {
      const wait = Number(r.headers.get("Retry-After") ?? 0) * 1000 || 800 * (attempt + 1);
      await new Promise((res) => setTimeout(res, Math.min(wait, 10000)));
      continue;
    }
    throw last;
  }
  throw last ?? new Error("HubSpot: retries exhausted");
}

// Every record of an object type (companies, contacts, or a custom object id),
// with the given properties. Property lists are split across requests when
// long, so URLs stay well under HubSpot's limit; results are merged by id.
async function listAll(objectType: string, properties: string[]): Promise<{ id: string; properties: Record<string, any> }[]> {
  const props = [...new Set(properties.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < props.length; i += 120) chunks.push(props.slice(i, i + 120));
  if (!chunks.length) chunks.push([]);
  const byId = new Map<string, { id: string; properties: Record<string, any> }>();
  for (const chunk of chunks) {
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "100", archived: "false" });
      if (chunk.length) q.set("properties", chunk.join(","));
      if (after) q.set("after", after);
      const page = await hs(`/crm/v3/objects/${objectType}?${q}`);
      for (const r of page.results ?? []) {
        const id = String(r.id);
        const cur = byId.get(id) ?? { id, properties: {} };
        Object.assign(cur.properties, r.properties ?? {});
        byId.set(id, cur);
      }
      after = page.paging?.next?.after;
    } while (after);
  }
  return [...byId.values()];
}

// Associations from → to for a set of record ids: Map<fromId, toId[]>.
async function associations(fromType: string, toType: string, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 1000) {
    const inputs = ids.slice(i, i + 1000).map((id) => ({ id }));
    if (!inputs.length) continue;
    const r = await hs(`/crm/v4/associations/${fromType}/${toType}/batch/read`, { method: "POST", body: JSON.stringify({ inputs }) });
    for (const row of r.results ?? []) {
      const from = String(row.from?.id ?? "");
      const to = (row.to ?? []).map((t: any) => String(t.toObjectId ?? t.id));
      if (from) out.set(from, to);
    }
  }
  return out;
}

async function accountInfo(): Promise<{ portalId: string; uiDomain: string }> {
  const a = await hs("/account-info/v3/details");
  return { portalId: String(a.portalId), uiDomain: String(a.uiDomain || "app.hubspot.com") };
}

// Custom object schemas keyed by our object name → {objectTypeId, fqn}
async function schemaMap(): Promise<Map<string, { objectTypeId: string; fqn: string; properties: any[] }>> {
  const r = await hs("/crm/v3/schemas");
  const m = new Map<string, { objectTypeId: string; fqn: string; properties: any[] }>();
  for (const s of r.results ?? []) m.set(String(s.name), { objectTypeId: String(s.objectTypeId), fqn: String(s.fullyQualifiedName ?? ""), properties: s.properties ?? [] });
  return m;
}

const recordUrl = (uiDomain: string, portalId: string, typeId: string, id: string) =>
  `https://${uiDomain}/contacts/${portalId}/record/${typeId}/${id}`;

// ---- function ----

let CUTOFF = "2026-11-01";   // integration_secrets onboarding_cutoff overrides

async function typeIds(): Promise<Record<string, string>> {
  const rows = await dbAll("crm_meta?key=like.type:*&select=key,value");
  const m: Record<string, string> = {};
  for (const r of rows) m[String(r.key).slice(5)] = String(r.value);
  return m;
}
async function assocType(from: string, to: string) {
  const r = await hs(`/crm/v4/associations/${from}/${to}/labels`);
  const first = (r.results ?? [])[0];
  if (!first?.typeId) throw new Error(`No association defined between ${from} and ${to} — run Set up HubSpot`);
  return { associationCategory: String(first.category ?? "USER_DEFINED"), associationTypeId: Number(first.typeId) };
}
async function createJunction(T: Record<string, string>, kon: any, camp: any, by: string, source: string, note?: string) {
  if (!T.agreement_link) throw new Error("HubSpot isn't set up yet (run Set up HubSpot)");
  const nowIso = new Date().toISOString();
  const name = `${camp.name} / ${String(kon.name || "").slice(0, 60)}`.slice(0, 120);
  const campType = camp.side === "buyer" ? T.buyer_offer : T.publisher_campaign;
  const created = await hs(`/crm/v3/objects/${T.agreement_link}`, {
    method: "POST",
    body: JSON.stringify({
      properties: { name, link_status: "Active", link_source: source, sign_document_id: kon.sign_document_id || "",
        coverage_note: note || "", linked_by: by, linked_at: nowIso },
      associations: [
        { to: { id: kon.crm_id }, types: [await assocType(T.agreement_link, T.agreement)] },
        { to: { id: camp.crm_id }, types: [await assocType(T.agreement_link, campType)] },
      ],
    }),
  });
  const newId = String(created.id);
  // mirror at once so dedupe holds before the next hubspot-sync
  await db("POST", "ob_agreement_links?on_conflict=crm_id", [{
    crm_id: newId, name, agreement_crm_id: kon.crm_id,
    buyer_campaign_crm_id: camp.side === "buyer" ? camp.crm_id : null,
    publisher_campaign_crm_id: camp.side === "publisher" ? camp.crm_id : null,
    link_status: "Active", link_source: source, sign_document_id: kon.sign_document_id || null,
    coverage_note: note || null, linked_by: by, linked_at: nowIso, synced_at: nowIso,
  }]);
  return newId;
}

const STOP = new Set(["the", "and", "pub", "buyer", "universal", "email"]);
function tokensOf(name: string): Set<string> {
  const t = new Set(String(name || "").toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
  if (t.has("fe")) { t.add("final"); t.add("expense"); }
  if (t.has("final") && t.has("expense")) t.add("fe");
  if (t.has("med")) t.add("medicare");
  return t;
}
function score(aName: string, bName: string): number {
  const a = tokensOf(aName), b = tokensOf(bName);
  let s = 0;
  for (const w of b) if (w.length > 2 && a.has(w)) s++;
  return s;
}
const isNewIO = (k: any) =>
  /IO/i.test(k.document_type || "") && ["Sent", "Signed"].includes(k.status || "") && String(k.created_time || "") >= CUTOFF;

async function loadState() {
  const [contracts, camps, links] = await Promise.all([
    dbAll("ob_contracts?select=*"),
    dbAll("ob_campaigns?select=crm_id,side,account_crm_id,account_name,name,offer_status,campaign_status,io_status,created_time"),
    dbAll("ob_agreement_links?select=*").catch(() => []),
  ]);
  const activeLinks = links.filter((l: any) => !["Removed", "Superseded"].includes(l.link_status || ""));
  const linkedAgreements = new Set(activeLinks.map((l: any) => l.agreement_crm_id).filter(Boolean));
  const pairSet = new Set(activeLinks.map((l: any) => `${l.agreement_crm_id}|${l.buyer_campaign_crm_id || l.publisher_campaign_crm_id}`));
  return { contracts, camps, links, activeLinks, linkedAgreements, pairSet };
}
function classify(st: any) {
  const graduated = (c: any) => c.offer_status === "Complete" || c.campaign_status === "Active";
  const recent = st.contracts.filter(isNewIO);
  const unlinked = recent.filter((k: any) =>
    !k.buyer_campaign_crm_id && !k.publisher_campaign_crm_id && !st.linkedAgreements.has(k.crm_id));
  const rows = unlinked.map((k: any) => {
    const ps = String(k.partner_side || "").toLowerCase();
    const sides = ps.startsWith("buy") ? ["buyer"] : ps.startsWith("pub") ? ["publisher"] : ["buyer", "publisher"];
    const cands = st.camps
      .filter((c: any) => sides.includes(c.side) && c.account_crm_id === k.account_crm_id && !graduated(c))
      .map((c: any) => ({ campaign_crm_id: c.crm_id, side: c.side, name: c.name, offer_status: c.offer_status, io_status: c.io_status, score: score(k.name, c.name) }))
      .sort((a: any, b: any) => b.score - a.score).slice(0, 5);
    const strong = cands.filter((c: any) => c.score >= 2);
    const outcome =
      cands.length === 0 ? "no_open_campaigns_on_account"
      : strong.length === 1 && (cands.length < 2 || strong[0].score > cands[1].score) ? "single_high_confidence"
      : strong.length >= 2 ? "multi_campaign_or_ambiguous (review; approved lists apply individually)"
      : "needs_review (no strong name match)";
    return {
      contract_crm_id: k.crm_id, contract: k.name, document_type: k.document_type, status: k.status,
      signed_date: k.signed_date, created_time: k.created_time,
      account_crm_id: k.account_crm_id, account: k.account_name, partner_side: k.partner_side || "(unknown)",
      candidates: cands, outcome,
      proposed_link: outcome === "single_high_confidence" ? { contract_crm_id: k.crm_id, campaign_crm_id: strong[0].campaign_crm_id, campaign: strong[0].name } : null,
    };
  });
  return { recent, unlinked, rows };
}

async function verifyPair(st: any, cid: string, kidIn: string) {
  const kon = st.contracts.find((k: any) => k.crm_id === cid);
  if (!kon) throw new Error("agreement not in the mirror");
  const camp = st.camps.find((c: any) => c.crm_id === kidIn);
  if (!camp) throw new Error("campaign not in the mirror");
  if (camp.account_crm_id !== kon.account_crm_id) throw new Error("account mismatch — refusing cross-account link");
  const ps = String(kon.partner_side || "").toLowerCase();
  if (ps && !ps.startsWith(camp.side.slice(0, 3))) throw new Error(`side mismatch: agreement is ${kon.partner_side}, campaign is ${camp.side}`);
  if (st.pairSet.has(`${cid}|${kidIn}`)) return { kon, camp, dup: "already linked via junction" };
  if (kon.buyer_campaign_crm_id === kidIn || kon.publisher_campaign_crm_id === kidIn) return { kon, camp, dup: "already linked via the agreement's own lookup" };
  return { kon, camp, dup: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* empty = dry run */ }
  try {
    const cut = await dbAll("integration_secrets?key=eq.onboarding_cutoff&select=value").catch(() => []);
    if (cut?.[0]?.value) CUTOFF = String(cut[0].value);
    const st = await loadState();

    if (body.auto_link === true) {
      const { rows } = classify(st);
      const made: any[] = [];
      const T = rows.some((r: any) => r.proposed_link) ? await typeIds() : {};
      for (const r of rows) {
        if (!r.proposed_link) continue;
        try {
          const v = await verifyPair(st, r.proposed_link.contract_crm_id, r.proposed_link.campaign_crm_id);
          if (v.dup) { made.push({ ...r.proposed_link, skipped: v.dup }); continue; }
          const id = await createJunction(T, v.kon, v.camp, "io-match auto", "Auto High Confidence");
          st.pairSet.add(`${r.proposed_link.contract_crm_id}|${r.proposed_link.campaign_crm_id}`);
          await logEvent("hubspot", "ok", "IO auto-linked to campaign", JSON.stringify({ link: id, contract: r.contract, campaign: r.proposed_link.campaign }), "outbound");
          made.push({ ...r.proposed_link, linked: true, link_crm_id: id });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          await logEvent("hubspot", "error", "IO auto-link failed", JSON.stringify({ contract: r.contract_crm_id, error: msg }), "outbound");
          made.push({ ...r.proposed_link, error: msg });
        }
      }
      return json({ auto_link: true, considered: rows.length, high_confidence: made.length, results: made });
    }

    if (body.apply === true) {
      const user = await requireUser(req);
      if (!user || !STAFF_ROLES.includes(user.role)) return json({ error: "apply requires a signed-in staff user" }, 401);
      const T = await typeIds();
      const results: any[] = [];
      for (const s2 of (Array.isArray(body.supersede) ? body.supersede : []).slice(0, 10)) {
        const res: any = { link_crm_id: s2.link_crm_id };
        try {
          const status = ["Amended", "Superseded", "Removed"].includes(s2.status) ? s2.status : null;
          if (!status) throw new Error("status must be Amended, Superseded or Removed");
          await hs(`/crm/v3/objects/${T.agreement_link}/${s2.link_crm_id}`, { method: "PATCH",
            body: JSON.stringify({ properties: { link_status: status, ...(s2.note ? { coverage_note: s2.note } : {}) } }) });
          await db("PATCH", `ob_agreement_links?crm_id=eq.${encodeURIComponent(s2.link_crm_id)}`, { link_status: status });
          await logEvent("hubspot", "ok", `Agreement link ${status}`, JSON.stringify({ by: user.email, link: s2.link_crm_id, note: s2.note }), "outbound");
          res.updated = status;
        } catch (e) { res.error = String((e as Error)?.message ?? e); }
        results.push(res);
      }
      for (const l of (Array.isArray(body.links) ? body.links : []).slice(0, 20)) {
        const res: any = { contract_crm_id: l?.contract_crm_id, campaign_crm_id: l?.campaign_crm_id };
        try {
          const v = await verifyPair(st, String(l.contract_crm_id || ""), String(l.campaign_crm_id || ""));
          if (v.dup) { res.skipped = v.dup; results.push(res); continue; }
          const id = await createJunction(T, v.kon, v.camp, user.email, "Dashboard Confirmed", l.coverage_note);
          st.pairSet.add(`${l.contract_crm_id}|${l.campaign_crm_id}`);
          await logEvent("hubspot", "ok", "IO linked to campaign", JSON.stringify({ by: user.email, link: id, contract: v.kon.name, campaign: v.camp.name }), "outbound");
          res.linked = true; res.link_crm_id = id; res.agreement = v.kon.name; res.campaign = v.camp.name;
        } catch (e) {
          res.error = String((e as Error)?.message ?? e);
          await logEvent("hubspot", "error", "IO link failed", JSON.stringify({ by: user.email, contract: l?.contract_crm_id, campaign: l?.campaign_crm_id, error: res.error }), "outbound");
        }
        results.push(res);
      }
      if (!results.length) return json({ error: "apply needs { links: [...] } and/or { supersede: [...] }" }, 400);
      return json({ applied: results.filter((r) => r.linked || r.updated).length, results });
    }

    const { recent, unlinked, rows } = classify(st);
    return json({
      dry_run: true, cutoff: CUTOFF, wrote: "nothing",
      recent_io_agreements: recent.length, linked: recent.length - unlinked.length, unlinked: unlinked.length,
      junction_links_active: st.activeLinks.length, report: rows,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
