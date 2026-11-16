// hubspot-setup v1 — creates Nyala's HubSpot data model from crm_model.ts:
// six custom objects (Buyer Offer, Publisher Campaign, Agreement, Campaign
// Match, Agreement Campaign Link, DID), their properties, the company
// properties the dashboard uses, and the associations between them.
//
// Idempotent: it only ever ADDS what is missing (objects, properties,
// association definitions) and never edits or deletes anything in HubSpot.
// Admin only — run it from Configuration → Integrations → "Set up HubSpot".
//
// POST body: { dry_run: true } → report what it would create, change nothing
//            {}                → create what's missing
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

// [crm_model.ts]
// crm_model.ts — the ONE description of Nyala's HubSpot data model.
//
// hubspot-setup creates every object and property listed here, hubspot-sync
// mirrors them into the dashboard tables, and onboarding-write / hubspot-write
// write back through the same map. Change a field here and all three follow.
//
// Each object: the HubSpot object (standard "companies" or a custom object
// name), the dashboard mirror table, and its fields. A field maps one mirror
// column to one HubSpot property (same name unless `hs` says otherwise).
//   type: string (one line) | text (multi-line) | number | date | datetime |
//         bool | enum (with options)
//   std:  a standard HubSpot property — read/written, never created
//   ro:   read-only from the dashboard (onboarding-write refuses it)
//
// Status fields are plain text on purpose: the dashboard writes several
// different value sets, and HubSpot rejects any dropdown value it doesn't
// know. Turn one into a dropdown by changing its type to "enum" with options.

type FieldType = "string" | "text" | "number" | "date" | "datetime" | "bool" | "enum";
interface Field { col: string; hs?: string; type: FieldType; label: string; options?: string[]; std?: boolean; ro?: boolean }
interface CrmObject {
  key: string;                 // our name for it (crm_meta type:<key>)
  hubspot: string;             // "companies" or the custom object's name
  singular?: string; plural?: string;   // custom objects only
  primary?: string;            // custom objects: primary display property
  table: string;               // mirror table
  fields: Field[];
  assoc?: Record<string, string>;  // mirror column → associated object key
}

const s = (col: string, label: string, extra: Partial<Field> = {}): Field => ({ col, type: "string", label, ...extra });
const t = (col: string, label: string): Field => ({ col, type: "text", label });
const n = (col: string, label: string): Field => ({ col, type: "number", label });
const d = (col: string, label: string): Field => ({ col, type: "date", label });
const dt = (col: string, label: string): Field => ({ col, type: "datetime", label });
const b = (col: string, label: string): Field => ({ col, type: "bool", label });
const e = (col: string, label: string, options: string[]): Field => ({ col, type: "enum", label, options });

const PARTNER_STATUS = ["Prospect", "Active", "Inactive"];

// Companies feed three mirrors: hubspot_companies (CRM tab), ob_accounts
// (partner status not Prospect) and ob_prospects (partner status Prospect).
const COMPANY_FIELDS: Field[] = [
  s("name", "Company name", { std: true }),
  s("website", "Website", { std: true }), s("phone", "Phone", { std: true }),
  s("address_line1", "Address", { hs: "address", std: true }), s("city", "City", { std: true }),
  s("state", "State", { std: true }), s("zip", "Zip", { std: true }),
  { col: "intake_notes", hs: "description", type: "text", label: "Description", std: true },
  e("partner_status", "Partner Status", PARTNER_STATUS),
  e("partner_type", "Partner Type", ["Buyer", "Publisher", "Buyer & Publisher", "Undetermined"]),
  e("account_status", "Account Status", ["Active", "Inactive"]),
  s("dba", "DBA"),
  // prospect-stage fields
  s("intake_status", "Intake Status"), s("msa_status", "MSA Status"), s("contract_status", "Contract Status"),
  s("contract_doc_link", "Contract Document Link"),
  d("last_contact_date", "Last Contact Date"), d("next_follow_up_date", "Next Follow-up Date"),
  t("next_action", "Next Action"), t("onboarding_notes", "Onboarding Notes"), t("campaign_details", "Campaign Details"),
  s("primary_contact", "Primary Contact"), s("email", "Primary Email"), s("who_closed", "Who Closed the Deal"),
  // account-stage fields
  s("buyer_account_status", "Buyer Account Status"), s("publisher_account_status", "Publisher Account Status"),
  s("buyer_msa_signed", "Buyer MSA Signed"), s("publisher_msa_signed", "Publisher MSA Signed"),
  s("publisher_msa_status", "Publisher MSA Status"), s("msa_type", "MSA Type"),
  s("overall_paperwork_status", "Overall Paperwork Status"),
  s("buyer_paperwork_status", "Buyer Paperwork Status"), s("publisher_paperwork_status", "Publisher Paperwork Status"),
  s("paperwork_used_buyer", "Paperwork Used (Buyer)"), s("paperwork_used_publisher", "Paperwork Used (Publisher)"),
  s("buyer_owner", "Buyer Account Owner"), s("publisher_owner", "Publisher Account Owner"),
  s("closed_the_deal", "Closed the Deal"),
  t("buyer_notes", "Buyer Notes"), t("publisher_notes", "Publisher Notes"),
  s("verticals", "Call Types / Verticals", { hs: "call_types" }), s("traffic_type", "Traffic Type"),
  s("buyer_payment_terms", "Buyer Payment Terms", { hs: "payment_terms" }), s("publisher_payment_terms", "Publisher Payment Terms"),
  // contacts on the CRM tab
  s("billing_contact_name", "Billing Contact Name"), s("billing_contact_email", "Billing Contact Email"),
  s("billing_contact_phone", "Billing Contact Phone"),
  s("operations_contact_name", "Operations Contact Name"), s("operations_contact_email", "Operations Contact Email"),
  s("operations_contact_phone", "Operations Contact Phone"),
  s("tax_form_status", "Tax Form Status"), s("onboarding_status", "Onboarding Status"), s("payment_method", "Payment Method"),
  s("call_types", "Call Types (CRM tab)", { hs: "call_types", ro: true }),
  { col: "created_time", hs: "createdate", type: "datetime", label: "Created", std: true, ro: true },
  { col: "modified_time", hs: "hs_lastmodifieddate", type: "datetime", label: "Last modified", std: true, ro: true },
  { col: "last_activity_time", hs: "notes_last_updated", type: "datetime", label: "Last activity", std: true, ro: true },
];

// Buyer Offers and Publisher Campaigns share one shape (ob_campaigns, side).
function campaignFields(side: "buyer" | "publisher"): Field[] {
  const f: Field[] = [
    s("name", "Name"), s("dashboard_id", "Dashboard ID", { ro: true }),
    s("offer_status", "Offer Status"), t("next_action", "Next Action"),
    d("follow_up_date", "Follow-up Date"), s("follow_up_owner", "Follow-up Owner"),
    s("campaign_status", "Campaign Status"), s("campaign_link_status", "Campaign Link Status"),
    s("io_status", "IO Status"), d("io_date_signed", "IO Date Signed"), b("io_attached", "IO Attached / Uploaded"),
    s("io_doc_link", "IO Document Link"), s("io_campaign_name", "IO Campaign Name"),
    n("io_rate", "IO Contracted Rate"), n("io_duration", "IO Contracted Duration (sec)"),
    s("io_payment_terms", "IO Payment Terms"), b("io_sync_hold", "IO Sync Hold"),
    s("io_did", "IO DID"), s("io_call_hours", "IO Call Hours"), n("io_daily_cap", "IO Daily Cap"),
    n("io_concurrency", "IO Concurrency"), s("io_states", "IO State Coverage"),
    n("rate", side === "buyer" ? "Rate per Billable Call" : "Cost per Call"),
    n("billable_duration", "Billable Duration (sec)"),
    s("payment_terms", "Payment Terms"), s("synced_payment_terms", "Synced Payment Terms", { ro: true }),
    s("vertical", "Vertical"), s("lead_type", "Lead Type"), s("traffic_type", "Traffic Type"),
    s("callgrid_campaign", "CallGrid Campaign"), s("callgrid_buyer_publisher", side === "buyer" ? "CallGrid Buyer" : "CallGrid Publisher"),
    s("endpoint_name", side === "buyer" ? "Destination Name" : "Source Name"),
    s("did", "DID (summary)", { ro: true }), n("daily_cap", "Daily Cap"), n("concurrency", "Concurrency"),
    s("call_hours", "Call Hours"), t("campaign_notes", "Campaign Notes"), b("active", "Active"),
    { col: "created_time", hs: "hs_createdate", type: "datetime", label: "Created", std: true, ro: true },
    { col: "modified_time", hs: "hs_lastmodifieddate", type: "datetime", label: "Last modified", std: true, ro: true },
  ];
  if (side === "buyer") f.push(s("buyer_cpa_goal", "Buyer CPA Goal"));
  return f;
}

const OBJECTS: CrmObject[] = [
  {
    key: "buyer_offer", hubspot: "nyala_buyer_offer", singular: "Buyer Offer", plural: "Buyer Offers", primary: "name",
    table: "ob_campaigns", fields: campaignFields("buyer"), assoc: { account_crm_id: "companies" },
  },
  {
    key: "publisher_campaign", hubspot: "nyala_publisher_campaign", singular: "Publisher Campaign", plural: "Publisher Campaigns", primary: "name",
    table: "ob_campaigns", fields: campaignFields("publisher"), assoc: { account_crm_id: "companies" },
  },
  {
    key: "agreement", hubspot: "nyala_agreement", singular: "Agreement", plural: "Agreements", primary: "name",
    table: "ob_contracts",
    fields: [
      s("name", "Name"), s("document_type", "Document Type"), s("partner_side", "Partner Side"),
      s("status", "Status"), d("signed_date", "Signed Date"), s("source", "Source"), s("paperwork_source", "Paperwork Source"),
      s("campaign_name", "Campaign Name"), s("dashboard_campaign_id", "Dashboard Campaign ID"),
      s("doc_file_link", "Document Link"), s("signed_pdf_link", "Signed PDF Link"), s("sign_document_id", "Signing Document ID"),
      s("io_sync_status", "IO Sync Status"), b("io_sync_hold", "IO Sync Hold"),
      { col: "created_time", hs: "hs_createdate", type: "datetime", label: "Created", std: true, ro: true },
      { col: "modified_time", hs: "hs_lastmodifieddate", type: "datetime", label: "Last modified", std: true, ro: true },
    ],
    assoc: { account_crm_id: "companies", buyer_campaign_crm_id: "buyer_offer", publisher_campaign_crm_id: "publisher_campaign" },
  },
  {
    key: "campaign_match", hubspot: "nyala_campaign_match", singular: "Campaign Match", plural: "Campaign Matches", primary: "name",
    table: "ob_campaign_matches",
    fields: [
      s("name", "Name"),
      e("match_stage", "Match Stage", ["Proposed", "Under Review", "Confirmed", "Ready for Launch", "Live", "Inactive", "Rejected"]),
      s("match_source", "Match Source"), s("match_owner", "Match Owner"),
      s("confirmed_by", "Confirmed By"), dt("confirmed_on", "Confirmed On"),
      t("rejection_reason", "Rejection Reason"), t("match_notes", "Match Notes"),
      { col: "created_time", hs: "hs_createdate", type: "datetime", label: "Created", std: true, ro: true },
      { col: "modified_time", hs: "hs_lastmodifieddate", type: "datetime", label: "Last modified", std: true, ro: true },
    ],
    assoc: { buyer_campaign_crm_id: "buyer_offer", publisher_campaign_crm_id: "publisher_campaign" },
  },
  {
    key: "agreement_link", hubspot: "nyala_agreement_link", singular: "Agreement Campaign Link", plural: "Agreement Campaign Links", primary: "name",
    table: "ob_agreement_links",
    fields: [
      s("name", "Name"),
      e("link_status", "Link Status", ["Active", "Amended", "Superseded", "Removed"]),
      s("link_source", "Link Source"), s("sign_document_id", "Signing Document ID"), t("coverage_note", "Coverage Note"),
      s("linked_by", "Linked By"), dt("linked_at", "Linked At"),
      { col: "created_time", hs: "hs_createdate", type: "datetime", label: "Created", std: true, ro: true },
      { col: "modified_time", hs: "hs_lastmodifieddate", type: "datetime", label: "Last modified", std: true, ro: true },
    ],
    assoc: { agreement_crm_id: "agreement", buyer_campaign_crm_id: "buyer_offer", publisher_campaign_crm_id: "publisher_campaign" },
  },
  {
    key: "did", hubspot: "nyala_did", singular: "DID", plural: "DIDs", primary: "did",
    table: "crm_dids",
    fields: [
      s("did", "Phone Number (DID)"), s("status", "Status"),
      d("start_date", "Start Date"), d("end_date", "End Date"),
      s("label", "Label"), t("notes", "Notes"),
    ],
    assoc: { buyer_offer_crm_id: "buyer_offer", account_crm_id: "companies" },
  },
];

const objectByKey = (k: string) => OBJECTS.find((o) => o.key === k);

// HubSpot property definition for a field (used by hubspot-setup)
function propertyDef(f: Field, groupName: string) {
  const name = f.hs ?? f.col;
  const base: Record<string, unknown> = { name, label: f.label, groupName };
  switch (f.type) {
    case "string": return { ...base, type: "string", fieldType: "text" };
    case "text": return { ...base, type: "string", fieldType: "textarea" };
    case "number": return { ...base, type: "number", fieldType: "number" };
    case "date": return { ...base, type: "date", fieldType: "date" };
    case "datetime": return { ...base, type: "datetime", fieldType: "date" };
    case "bool": return { ...base, type: "bool", fieldType: "booleancheckbox",
      options: [{ label: "Yes", value: "true", displayOrder: 0 }, { label: "No", value: "false", displayOrder: 1 }] };
    case "enum": return { ...base, type: "enumeration", fieldType: "select",
      options: (f.options ?? []).map((o, i) => ({ label: o, value: o, displayOrder: i })) };
  }
}

// HubSpot value (always a string or null) → mirror column value
function fromHs(f: Field, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  const str = String(v);
  switch (f.type) {
    case "number": { const x = Number(str); return Number.isFinite(x) ? x : null; }
    case "bool": return str === "true" ? true : str === "false" ? false : null;
    case "date": return /^\d+$/.test(str) ? new Date(Number(str)).toISOString().slice(0, 10) : str.slice(0, 10);
    case "datetime": return /^\d+$/.test(str) ? new Date(Number(str)).toISOString() : str;
    default: return str;
  }
}

// mirror column value → HubSpot property value
function toHs(f: Field, v: unknown): string {
  if (v === null || v === undefined) return "";
  switch (f.type) {
    case "bool": return v === true || v === "true" ? "true" : "false";
    case "date": return String(v).slice(0, 10);
    case "datetime": return new Date(String(v)).toISOString();
    default: return String(v);
  }
}

const digits10 = (x: unknown) => String(x ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1").slice(-10);

// ---- function ----

const COMPANY_GROUP = "nyala_partner";
const OBJECT_GROUP = "nyala_fields";

// unique non-standard fields by HubSpot property name
function creatable(fields: Field[]): Field[] {
  const seen = new Set<string>();
  return fields.filter((f) => {
    const name = f.hs ?? f.col;
    if (f.std || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

async function ensureGroup(objectType: string, name: string, label: string, dry: boolean, log: string[]) {
  try {
    const g = await hs(`/crm/v3/properties/${objectType}/groups/${name}`);
    if (g?.name) return;
  } catch (e) { if (!(e instanceof HubSpotError) || e.status !== 404) throw e; }
  log.push(`create property group "${label}" on ${objectType}`);
  if (dry) return;
  try { await hs(`/crm/v3/properties/${objectType}/groups`, { method: "POST", body: JSON.stringify({ name, label, displayOrder: -1 }) }); }
  catch (e) { if (!(e instanceof HubSpotError) || e.status !== 409) throw e; }
}

async function ensureProperties(objectType: string, fields: Field[], group: string, dry: boolean, log: string[], label: string) {
  const have = new Set(((await hs(`/crm/v3/properties/${objectType}`)).results ?? []).map((p: any) => String(p.name)));
  let added = 0;
  for (const f of creatable(fields)) {
    const name = f.hs ?? f.col;
    if (have.has(name)) continue;
    log.push(`add property "${f.label}" (${name}) to ${label}`);
    added++;
    if (dry) continue;
    try { await hs(`/crm/v3/properties/${objectType}`, { method: "POST", body: JSON.stringify(propertyDef(f, group)) }); }
    catch (e) { if (!(e instanceof HubSpotError) || e.status !== 409) throw e; }
  }
  return added;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const user = await requireUser(req);
  if (!user) return json({ error: "Sign in to the dashboard first." }, 401);
  if (user.role !== "admin") return json({ error: "Only an admin can set up HubSpot." }, 403);
  let dry = false;
  try { dry = (await req.json())?.dry_run === true; } catch { /* {} */ }

  const log: string[] = [];
  try {
    const { portalId, uiDomain } = await accountInfo();
    let schemas = await schemaMap();

    // 1. company properties
    await ensureGroup("companies", COMPANY_GROUP, "Nyala Partner", dry, log);
    await ensureProperties("companies", COMPANY_FIELDS, COMPANY_GROUP, dry, log, "Companies");

    // 2. custom objects (created with their properties in one call)
    for (const o of OBJECTS) {
      if (schemas.has(o.hubspot)) continue;
      const props = creatable(o.fields);
      const assocCompanies = Object.values(o.assoc ?? {}).includes("companies");
      log.push(`create custom object "${o.plural}" with ${props.length} properties`);
      if (dry) continue;
      await hs("/crm/v3/schemas", {
        method: "POST",
        body: JSON.stringify({
          name: o.hubspot,
          labels: { singular: o.singular, plural: o.plural },
          primaryDisplayProperty: o.primary,
          requiredProperties: [o.primary],
          searchableProperties: [o.primary],
          secondaryDisplayProperties: [],
          properties: props.map((f) => { const p: any = propertyDef(f, OBJECT_GROUP); delete p.groupName; return p; }),
          associatedObjects: assocCompanies ? ["COMPANY"] : [],
        }),
      });
    }
    if (!dry) schemas = await schemaMap();

    // 3. properties added to crm_model.ts after an object already existed
    for (const o of OBJECTS) {
      const sc = schemas.get(o.hubspot);
      if (!sc) continue;   // dry run, object not created yet
      await ensureGroup(sc.objectTypeId, OBJECT_GROUP, "Nyala Fields", dry, log);
      await ensureProperties(sc.objectTypeId, o.fields, OBJECT_GROUP, dry, log, o.plural!);
    }

    // 4. association definitions (custom↔custom, and custom↔company when the
    //    object predates its company association)
    const typeOf = (key: string) => key === "companies" ? "0-2" : schemas.get(OBJECTS.find((x) => x.key === key)?.hubspot ?? "")?.objectTypeId;
    for (const o of OBJECTS) {
      const from = typeOf(o.key);
      for (const target of new Set(Object.values(o.assoc ?? {}))) {
        const to = typeOf(target);
        if (!from || !to) { log.push(`associate ${o.plural} ↔ ${target} (after objects exist)`); continue; }
        const labels = await hs(`/crm/v4/associations/${from}/${to}/labels`).catch(() => ({ results: [] }));
        if ((labels.results ?? []).length) continue;
        log.push(`create association ${o.plural} ↔ ${target}`);
        if (dry) continue;
        try {
          await hs(`/crm/v3/schemas/${from}/associations`, {
            method: "POST",
            body: JSON.stringify({ fromObjectTypeId: from, toObjectTypeId: to, name: `${o.key}_to_${target}`.slice(0, 60) }),
          });
        } catch (e) { if (!(e instanceof HubSpotError) || e.status !== 409) throw e; }
      }
    }

    // 5. record what the dashboard needs for links and syncs
    if (!dry) {
      const meta = [
        { key: "portal_id", value: portalId }, { key: "ui_domain", value: uiDomain },
        ...OBJECTS.map((o) => ({ key: `type:${o.key}`, value: schemas.get(o.hubspot)?.objectTypeId ?? null })).filter((m) => m.value),
      ].map((m) => ({ ...m, updated_at: new Date().toISOString() }));
      await db("POST", "crm_meta?on_conflict=key", meta, "resolution=merge-duplicates,return=minimal");
      await logEvent("hubspot", "ok", `HubSpot setup: ${log.length ? log.length + " change(s)" : "already complete"} (by ${user.email})`, log.join("\n"), "outbound");
      await markSystem("hubspot", true);
    }
    return json({ dry_run: dry, portal_id: portalId, changes: log, complete: log.length === 0 });
  } catch (e) {
    const msg = e instanceof HubSpotError
      ? `${e.message}${e.status === 403 ? " — the HubSpot private app is missing a scope (see the setup step)." : ""}`
      : String((e as Error)?.message ?? e);
    await logEvent("hubspot", "error", "HubSpot setup failed", msg, "outbound");
    return json({ error: msg, changes_before_error: log }, 500);
  }
});
