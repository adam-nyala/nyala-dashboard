// onboarding-write v2-hubspot — saves dashboard edits to HubSpot (HubSpot is
// the source of truth) and patches the mirror in the same call so the page
// updates at once instead of waiting for the next hubspot-sync.
//
// SIGN-IN REQUIRED (staff). Every write is logged to integration_log with the
// editor's email. Field rules come from crm_model.ts: only fields defined
// there, and not marked read-only, can be written.
//
// POST body (same shapes the dashboard has always sent):
//   { record_type, crm_id, changes: { mirror_column: value } }
//       record_type: prospect | account (HubSpot companies), buyer_campaign
//       (Buyer Offer), publisher_campaign, contract (Agreement). Columns that
//       are links (account_crm_id, buyer_campaign_crm_id, ...) set the
//       HubSpot association, replacing the previous one.
//   { record_type: "prospect", create: true, changes: {...} }
//       → new HubSpot company with Partner Status = Prospect
//   { record_type: "prospect", crm_id, match: "confirm"|"dismiss", account_crm_id }
//       → dashboard-only decision (prospect and account are both HubSpot
//         companies; merging duplicates is done in HubSpot by a person)
//   { cm: { action: "create", buyer_campaign_crm_id, publisher_campaign_crm_id, stage, source, notes, reason } }
//   { cm: { action: "stage", match_crm_id, stage, reason?, notes? } }
//       → Campaign Match records (who may act: integration_secrets
//         match_confirm_emails; empty = any staff)
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

const TYPE_MAP: Record<string, { key: string | "companies"; table: string; side?: string }> = {
  prospect: { key: "companies", table: "ob_prospects" },
  account: { key: "companies", table: "ob_accounts" },
  buyer_campaign: { key: "buyer_offer", table: "ob_campaigns", side: "buyer" },
  publisher_campaign: { key: "publisher_campaign", table: "ob_campaigns", side: "publisher" },
  contract: { key: "agreement", table: "ob_contracts" },
};
const STAGES = ["Proposed", "Under Review", "Confirmed", "Ready for Launch", "Live", "Inactive", "Rejected"];

async function typeIds(): Promise<Record<string, string>> {
  const rows = await dbAll("crm_meta?key=like.type:*&select=key,value");
  const m: Record<string, string> = { companies: "0-2" };
  for (const r of rows) m[String(r.key).slice(5)] = String(r.value);
  return m;
}

// Replace a single-value link: drop old associations to that object type,
// then associate the new record (if any).
async function setAssociation(fromType: string, fromId: string, toType: string, newId: string | null) {
  const cur = await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}`).catch(() => ({ results: [] }));
  for (const r of cur.results ?? []) {
    const id = String(r.toObjectId);
    if (id !== newId) await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${id}`, { method: "DELETE" });
  }
  if (newId && !(cur.results ?? []).some((r: any) => String(r.toObjectId) === newId)) {
    await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${newId}`, { method: "PUT" });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const user = await requireUser(req);
  if (!user) return json({ error: "Sign in to save changes." }, 401);
  if (!STAFF_ROLES.includes(user.role)) return json({ error: "Staff only." }, 403);

  let b: any = {};
  try { b = await req.json(); } catch { /* empty */ }
  const nowIso = new Date().toISOString();

  try {
    const T = await typeIds();

    // ── Campaign Matches ──
    if (b?.cm && typeof b.cm === "object") {
      const cm = b.cm;
      const permRows = await dbAll("integration_secrets?key=eq.match_confirm_emails&select=value").catch(() => []);
      const allow = String(permRows?.[0]?.value || "").split(",").map((x: string) => x.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(user.email.toLowerCase())) {
        return json({ error: "Your account is not authorized to manage matches. An admin can add you to match_confirm_emails in integration settings." }, 403);
      }
      if (!T.campaign_match) return json({ error: "HubSpot isn't set up yet (run Set up HubSpot on the Integrations tab)." }, 409);
      if (cm.action === "create") {
        const bId = String(cm.buyer_campaign_crm_id || ""), pId = String(cm.publisher_campaign_crm_id || "");
        if (!bId || !pId) return json({ error: "cm create needs buyer_campaign_crm_id and publisher_campaign_crm_id" }, 400);
        const [bc] = await dbAll(`ob_campaigns?crm_id=eq.${encodeURIComponent(bId)}&side=eq.buyer&select=crm_id,name`);
        const [pc] = await dbAll(`ob_campaigns?crm_id=eq.${encodeURIComponent(pId)}&side=eq.publisher&select=crm_id,name`);
        if (!bc || !pc) return json({ error: "both campaigns must exist in the mirror (one buyer, one publisher)" }, 400);
        const dup = await dbAll(`ob_campaign_matches?buyer_campaign_crm_id=eq.${bId}&publisher_campaign_crm_id=eq.${pId}&match_stage=not.in.(Rejected,Inactive)&select=crm_id`).catch(() => []);
        if (dup.length) return json({ error: "an active match already exists for this pair", existing: dup[0].crm_id }, 409);
        const stage = ["Proposed", "Under Review", "Confirmed", "Rejected"].includes(cm.stage) ? cm.stage : "Proposed";
        const props: Record<string, string> = {
          name: `${bc.name} / ${pc.name}`.slice(0, 120), match_stage: stage,
          match_source: cm.source === "suggestion" ? "Suggestion Engine" : "Manual",
          match_owner: user.email, match_notes: cm.notes || "",
        };
        if (stage === "Confirmed") { props.confirmed_by = user.email; props.confirmed_on = nowIso; }
        if (stage === "Rejected") props.rejection_reason = cm.reason || "rejected from suggestions";
        const created = await hs(`/crm/v3/objects/${T.campaign_match}`, {
          method: "POST",
          body: JSON.stringify({
            properties: props,
            associations: [
              { to: { id: bId }, types: [await assocType(T.campaign_match, T.buyer_offer)] },
              { to: { id: pId }, types: [await assocType(T.campaign_match, T.publisher_campaign)] },
            ],
          }),
        });
        const newId = String(created.id);
        await db("POST", "ob_campaign_matches?on_conflict=crm_id", [{
          crm_id: newId, name: props.name, buyer_campaign_crm_id: bId, publisher_campaign_crm_id: pId,
          match_stage: stage, match_source: props.match_source, match_owner: user.email,
          confirmed_by: props.confirmed_by ?? null, confirmed_on: props.confirmed_on ?? null,
          rejection_reason: props.rejection_reason ?? null, match_notes: cm.notes || null, synced_at: nowIso,
        }]);
        await logEvent("hubspot", "ok", `Campaign match ${stage} created by ${user.email}: ${bc.name} + ${pc.name} (${newId})`, undefined, "outbound");
        return json({ saved: true, match_crm_id: newId, stage });
      }
      if (cm.action === "stage") {
        const mId = String(cm.match_crm_id || "");
        const stage = STAGES.includes(cm.stage) ? cm.stage : null;
        if (!mId || !stage) return json({ error: "cm stage needs match_crm_id and a valid stage" }, 400);
        if (stage === "Rejected" && !cm.reason) return json({ error: "a rejection reason is required" }, 400);
        const props: Record<string, string> = { match_stage: stage };
        if (stage === "Confirmed") { props.confirmed_by = user.email; props.confirmed_on = nowIso; }
        if (stage === "Rejected") props.rejection_reason = cm.reason;
        if (cm.notes != null) props.match_notes = cm.notes;
        await hs(`/crm/v3/objects/${T.campaign_match}/${mId}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
        await db("PATCH", `ob_campaign_matches?crm_id=eq.${encodeURIComponent(mId)}`, {
          match_stage: stage,
          ...(stage === "Confirmed" ? { confirmed_by: user.email, confirmed_on: nowIso } : {}),
          ...(stage === "Rejected" ? { rejection_reason: cm.reason } : {}),
          ...(cm.notes != null ? { match_notes: cm.notes } : {}),
        });
        await logEvent("hubspot", "ok", `Campaign match ${mId} moved to ${stage} by ${user.email}${cm.reason ? ` (${cm.reason})` : ""}`, undefined, "outbound");
        return json({ saved: true, match_crm_id: mId, stage });
      }
      return json({ error: "cm.action must be create or stage" }, 400);
    }

    const recordType = String(b?.record_type || "");
    const crmId = String(b?.crm_id || "");
    const tm = TYPE_MAP[recordType];
    if (!tm) return json({ error: `Unknown record_type "${recordType}"` }, 400);

    // ── prospect ↔ account decision (dashboard-only in HubSpot's model) ──
    if (b?.match === "confirm" || b?.match === "dismiss") {
      if (recordType !== "prospect" || !crmId) return json({ error: "match applies to a prospect with a crm_id" }, 400);
      if (b.match === "confirm") {
        const acct = String(b?.account_crm_id || "");
        if (!acct) return json({ error: "account_crm_id is required to confirm a match" }, 400);
        await db("PATCH", `ob_prospects?crm_id=eq.${encodeURIComponent(crmId)}`, {
          linked_account_crm_id: acct, match_status: "confirmed", suggested_account_crm_id: null, match_confidence: null, activity_at: nowIso,
        });
        await logEvent("hubspot", "ok", `Prospect ${crmId} confirmed as the same partner as account ${acct} by ${user.email} — merge the two companies in HubSpot`, undefined, "internal");
        return json({ saved: true, matched: acct, note: "Recorded in the dashboard. In HubSpot these are two company records — merge them there to finish." });
      }
      await db("PATCH", `ob_prospects?crm_id=eq.${encodeURIComponent(crmId)}`, { match_status: "dismissed", suggested_account_crm_id: null, match_confidence: null });
      await logEvent("hubspot", "ok", `Prospect ${crmId} match dismissed by ${user.email}`, undefined, "internal");
      return json({ saved: true, dismissed: true });
    }

    const create = b?.create === true;
    if (!create && !crmId) return json({ error: "crm_id is required" }, 400);
    if (create && recordType !== "prospect") return json({ error: "Only prospects can be created from the dashboard" }, 400);

    const obj = tm.key === "companies" ? null : objectByKey(tm.key);
    const fields: Field[] = obj ? obj.fields : COMPANY_FIELDS;
    const assoc = obj?.assoc ?? {};
    const hsType = T[tm.key];
    if (!hsType) return json({ error: "HubSpot isn't set up yet (run Set up HubSpot on the Integrations tab)." }, 409);

    const changes: Record<string, unknown> = b?.changes && typeof b.changes === "object" ? b.changes : {};
    const props: Record<string, string> = {};
    const links: { col: string; target: string; id: string | null }[] = [];
    const mirrorPatch: Record<string, unknown> = {};
    const refused: string[] = [];
    for (const [col, val] of Object.entries(changes)) {
      if (assoc[col]) { links.push({ col, target: assoc[col], id: val ? String(val) : null }); mirrorPatch[col] = val || null; continue; }
      const f = fields.find((x) => x.col === col && !x.ro);
      if (!f) { refused.push(col); continue; }
      props[f.hs ?? f.col] = toHs(f, val === "" ? null : val);
      mirrorPatch[col] = val === "" ? null : val;
    }
    if (create) props.partner_status = "Prospect";
    if (!Object.keys(props).length && !links.length) return json({ error: "No writable fields in changes", refused }, 400);

    let id = crmId;
    try {
      if (create) id = String((await hs(`/crm/v3/objects/companies`, { method: "POST", body: JSON.stringify({ properties: props }) })).id);
      else if (Object.keys(props).length) await hs(`/crm/v3/objects/${hsType}/${id}`, { method: "PATCH", body: JSON.stringify({ properties: props }) });
      for (const l of links) await setAssociation(hsType, id, T[l.target], l.id);
    } catch (e) {
      const why = e instanceof HubSpotError ? `${e.message}${e.category ? ` (${e.category})` : ""}` : String((e as Error)?.message ?? e);
      await logEvent("hubspot", "error", `Onboarding edit FAILED — ${recordType} ${id || "(new)"} by ${user.email}`, why, "outbound");
      return json({ saved: false, error: `HubSpot rejected the change (${why})`, refused }, 502);
    }

    // mirror the change so the page updates now
    if (create) {
      await db("POST", "ob_prospects?on_conflict=crm_id", [{ crm_id: id, ...mirrorPatch, synced_at: nowIso, activity_at: nowIso }]);
    } else {
      const sideQ = tm.side ? `&side=eq.${tm.side}` : "";
      const patch = tm.table === "ob_contracts" ? mirrorPatch : { ...mirrorPatch, activity_at: nowIso };
      await db("PATCH", `${tm.table}?crm_id=eq.${encodeURIComponent(id)}${sideQ}`, patch);
    }
    await logEvent("hubspot", "ok", `Onboarding edit — ${recordType} ${id} by ${user.email}: ${Object.keys(mirrorPatch).join(", ")}`, undefined, "outbound");
    return json({ saved: true, crm_id: id, fields_saved: Object.keys(mirrorPatch), refused });
  } catch (e) {
    const msg = e instanceof HubSpotError ? `HubSpot: ${e.message}` : String((e as Error)?.message ?? e);
    await logEvent("hubspot", "error", `Onboarding write failed (${user.email})`, msg, "outbound");
    return json({ saved: false, error: msg }, 500);
  }
});

// association type between two object types: the first label HubSpot
// reports, with its own category (HUBSPOT_DEFINED or USER_DEFINED)
const assocCache = new Map<string, { associationCategory: string; associationTypeId: number }>();
async function assocType(from: string, to: string) {
  const k = `${from}|${to}`;
  if (assocCache.has(k)) return assocCache.get(k)!;
  const r = await hs(`/crm/v4/associations/${from}/${to}/labels`);
  const first = (r.results ?? [])[0];
  if (!first?.typeId) throw new Error(`No association defined between ${from} and ${to} — run Set up HubSpot`);
  const t = { associationCategory: String(first.category ?? "USER_DEFINED"), associationTypeId: Number(first.typeId) };
  assocCache.set(k, t);
  return t;
}
void OBJECTS;
