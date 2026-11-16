// hubspot-write v2 — pushes a dashboard client's Active/Inactive status to
// its linked HubSpot company (company property: account_status), then
// mirrors it. Staff only. The ONLY dashboard→HubSpot write outside the
// onboarding editor, and it touches nothing but account_status.
// Body: { client_id: uuid, status: "Active" | "Inactive" }
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = await requireUser(req);
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!STAFF_ROLES.includes(user.role)) return json({ error: "Not allowed" }, 403);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const clientId = String(body?.client_id ?? ""), status = String(body?.status ?? "");
  if (!clientId || !["Active", "Inactive"].includes(status)) return json({ error: "client_id and status (Active|Inactive) are required" }, 400);
  try {
    const [link] = await dbAll(`integration_links?system=eq.hubspot&entity_type=eq.client&local_id=eq.${clientId}&select=external_id`);
    if (!link) return json({ error: "This client isn't linked to a HubSpot company yet" }, 400);
    try {
      await hs(`/crm/v3/objects/companies/${link.external_id}`, { method: "PATCH", body: JSON.stringify({ properties: { account_status: status } }) });
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 400) {
        throw new Error(`HubSpot rejected account_status "${status}" — run Set up HubSpot on the Integrations tab so the Account Status property exists.`);
      }
      throw e;
    }
    await db("PATCH", `hubspot_companies?external_id=eq.${link.external_id}`, { account_status: status });
    await logEvent("hubspot", "ok", `Client set ${status} → HubSpot company ${link.external_id} (by ${user.email})`, undefined, "outbound", { type: "client", id: clientId });
    return json({ ok: true, saved: true });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await logEvent("hubspot", "error", "HubSpot status write failed", msg, "outbound", { type: "client", id: clientId });
    return json({ error: msg }, 500);
  }
});
