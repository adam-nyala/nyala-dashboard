// hubspot-sync v2 — mirrors Nyala's HubSpot into the dashboard.
//
// HubSpot is the source of truth for partners, offers, agreements, matches
// and DIDs; the dashboard reads these mirrors:
//   companies              → hubspot_companies (CRM tab), ob_accounts (partner
//                            status not Prospect), ob_prospects (Prospect)
//   contacts               → hubspot_contacts
//   Buyer Offers           → ob_campaigns (side buyer)
//   Publisher Campaigns    → ob_campaigns (side publisher)
//   Agreements             → ob_contracts
//   Campaign Matches       → ob_campaign_matches
//   Agreement Camp. Links  → ob_agreement_links
//   DIDs                   → crm_dids
//   property labels        → ob_field_meta (module "Accounts")
//   portal + object ids    → crm_meta (record links)
//
// Dashboard records that follow HubSpot:
//   • every Buyer Offer gets a dashboard client (its company) and client
//     campaign (crm_offer_id), so its calls and revenue have a home; the
//     offer's rate is the campaign's price. The dashboard id is written back
//     onto the offer (dashboard_id) — the ONLY property this sync writes.
//   • when DIDs or offer rates/durations change, every call is re-attributed
//     (nyala_attribute_calls) so revenue follows HubSpot immediately.
//   • companies are auto-linked to same-named dashboard clients/publishers;
//     a linked client's account_status (Active/Inactive) flows to clients.active.
//
// Called by: Integrations → "Run Account Sync", and the hourly cron.
// POST body: {}  |  { background: true } (return at once; for pg_net cron)
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

const norm = (x: unknown) => {
  let v = String(x ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (;;) { const t = v.replace(/\s+(llc|inc|incorporated|corp|corporation|co|ltd|llp|lp|pllc|group)$/, ""); if (t === v) break; v = t; }
  return v;
};
const hsName = (f: Field) => f.hs ?? f.col;

// Columns each mirror actually has (a field the table lacks is skipped)
const HC_COLS = new Set(["name","dba","website","phone","address_line1","city","state","zip","partner_type","account_status","msa_status",
  "msa_signed_date","buyer_msa_signed_date","pub_msa_signed_date","tax_form_status","onboarding_status","payment_terms","publisher_payment_terms",
  "payment_method","traffic_type","call_types","primary_contact_name","primary_contact_email","primary_contact_phone","billing_contact_name",
  "billing_contact_email","billing_contact_phone","operations_contact_name","operations_contact_email","operations_contact_phone",
  "created_time","modified_time"]);
const ACCT_COLS = new Set(["name","partner_type","buyer_account_status","publisher_account_status","buyer_msa_signed","publisher_msa_signed",
  "publisher_msa_status","msa_type","overall_paperwork_status","buyer_paperwork_status","publisher_paperwork_status","paperwork_used_buyer",
  "paperwork_used_publisher","buyer_owner","publisher_owner","closed_the_deal","intake_notes","buyer_notes","publisher_notes","verticals",
  "traffic_type","buyer_payment_terms","publisher_payment_terms","created_time","modified_time","last_activity_time"]);
const PROS_COLS = new Set(["name","partner_type","intake_status","msa_status","contract_status","contract_doc_link","last_contact_date",
  "next_follow_up_date","next_action","onboarding_notes","campaign_details","primary_contact","email","who_closed","created_time",
  "modified_time","last_activity_time"]);
// activity_at moves only when one of these really changes
const TRACKED: Record<string, string[]> = {
  ob_prospects: ["intake_status","msa_status","contract_status","next_action","next_follow_up_date","onboarding_notes","last_contact_date"],
  ob_accounts: ["buyer_account_status","publisher_account_status","publisher_msa_status","buyer_msa_signed","publisher_msa_signed",
    "overall_paperwork_status","buyer_paperwork_status","publisher_paperwork_status","buyer_owner","publisher_owner","buyer_notes","publisher_notes"],
  ob_campaigns: ["offer_status","campaign_status","campaign_link_status","io_status","io_date_signed","io_attached","next_action",
    "follow_up_date","follow_up_owner"],
};

function stampActivity(table: string, rows: any[], existing: Map<string, any>, runTs: string) {
  const tracked = TRACKED[table];
  if (!tracked) return;
  for (const row of rows) {
    const ex = existing.get(row.crm_id);
    let act = ex ? ex.activity_at ?? null : null;
    if (ex && tracked.some((f) => String(ex[f] ?? "") !== String(row[f] ?? ""))) act = runTs;
    row.activity_at = act;
  }
}

async function runSync() {
  const runTs = new Date().toISOString();
  const out: Record<string, unknown> = {};
  const { portalId, uiDomain } = await accountInfo();
  const schemas = await schemaMap();
  const typeId: Record<string, string> = { companies: "0-2" };
  const missingObjects: string[] = [];
  for (const o of OBJECTS) {
    const sc = schemas.get(o.hubspot);
    if (sc) typeId[o.key] = sc.objectTypeId; else missingObjects.push(o.plural!);
  }

  // owners → names (optional scope; names stay blank without it)
  const owners = new Map<string, string>();
  try {
    let after: string | undefined;
    do {
      const r = await hs(`/crm/v3/owners?limit=500${after ? `&after=${after}` : ""}`);
      for (const o of r.results ?? []) owners.set(String(o.id), [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || "");
      after = r.paging?.next?.after;
    } while (after);
  } catch (_e) { /* no owners scope */ }

  // ── companies ──
  const companyPropsMeta = (await hs("/crm/v3/properties/companies")).results ?? [];
  const visibleProps = companyPropsMeta.filter((p: any) => !p.hidden).map((p: any) => String(p.name));
  const wanted = [...new Set([...COMPANY_FIELDS.map(hsName), "hubspot_owner_id", "domain", ...visibleProps])];
  const companies = await listAll("companies", wanted);
  const companyName = new Map(companies.map((c) => [c.id, String(c.properties.name || c.properties.domain || `(company ${c.id})`)]));

  // contacts + their company
  const contacts = await listAll("contacts", ["firstname", "lastname", "email", "phone", "mobilephone", "jobtitle", "department", "lastmodifieddate"]);
  const contactCo = await associations("contacts", "companies", contacts.map((c) => c.id));
  const contactRows = contacts.map((c) => {
    const p = c.properties;
    return {
      external_id: c.id, account_external_id: contactCo.get(c.id)?.[0] ?? null,
      first_name: p.firstname || null, last_name: p.lastname || null,
      full_name: [p.firstname, p.lastname].filter(Boolean).join(" ") || null,
      email: p.email || null, phone: p.phone || null, mobile: p.mobilephone || null, title: p.jobtitle || null,
      department: p.department || null, raw: p, modified_time: fromHs({ col: "", type: "datetime", label: "" }, p.lastmodifieddate), synced_at: runTs,
    };
  });
  const firstContact = new Map<string, any>();
  for (const r of contactRows) if (r.account_external_id && !firstContact.has(r.account_external_id)) firstContact.set(r.account_external_id, r);

  const hcRows: any[] = [], acctRows: any[] = [], prosRows: any[] = [];
  for (const c of companies) {
    const p = c.properties;
    const vals: Record<string, unknown> = {};
    for (const f of COMPANY_FIELDS) if (!(f.col in vals) || vals[f.col] == null) vals[f.col] = fromHs(f, p[hsName(f)]);
    vals.name = companyName.get(c.id);
    const url = recordUrl(uiDomain, portalId, "0-2", c.id);
    const owner = owners.get(String(p.hubspot_owner_id ?? "")) ?? null;
    const hc: any = { external_id: c.id, record_url: url, raw: p, synced_at: runTs };
    for (const k of HC_COLS) if (k in vals) hc[k] = vals[k];
    const fc = firstContact.get(c.id);
    hc.primary_contact_name = (vals.primary_contact as string) ?? fc?.full_name ?? null;
    hc.primary_contact_email = (vals.email as string) ?? fc?.email ?? null;
    hc.primary_contact_phone = fc?.phone ?? fc?.mobile ?? null;
    hcRows.push(hc);
    const isProspect = String(vals.partner_status ?? "") === "Prospect";
    const base: any = { crm_id: c.id, owner_name: owner, record_url: url, synced_at: runTs };
    if (isProspect) {
      for (const k of PROS_COLS) if (k in vals) base[k] = vals[k];
      prosRows.push(base);
    } else {
      for (const k of ACCT_COLS) if (k in vals) base[k] = vals[k];
      base.raw = p;
      acctRows.push(base);
    }
  }

  // ── custom objects ──
  const objRows: Record<string, any[]> = {};
  for (const o of OBJECTS) {
    if (!typeId[o.key]) { objRows[o.key] = []; continue; }
    const recs = await listAll(typeId[o.key], [...o.fields.map(hsName), "hs_object_id"]);
    const ids = recs.map((r) => r.id);
    const assocCols: Record<string, Map<string, string[]>> = {};
    for (const [col, target] of Object.entries(o.assoc ?? {})) {
      const to = typeId[target];
      assocCols[col] = to ? await associations(typeId[o.key], to, ids) : new Map();
    }
    objRows[o.key] = recs.map((r) => {
      const row: any = { crm_id: r.id, record_url: recordUrl(uiDomain, portalId, typeId[o.key], r.id), synced_at: runTs };
      for (const f of o.fields) row[f.col] = fromHs(f, r.properties[hsName(f)]);
      for (const col of Object.keys(o.assoc ?? {})) row[col] = assocCols[col].get(r.id)?.[0] ?? null;
      if (o.table === "ob_campaigns" || o.table === "ob_contracts") row.account_name = row.account_crm_id ? companyName.get(row.account_crm_id) ?? null : null;
      if (o.key === "buyer_offer" || o.key === "publisher_campaign") {
        row.side = o.key === "buyer_offer" ? "buyer" : "publisher";
        row.owner_name = null;
      }
      return row;
    });
  }
  // DIDs: normalize numbers; a DID without its own company takes its offer's
  const offerById = new Map(objRows.buyer_offer.map((r) => [r.crm_id, r]));
  const didRows = objRows.did.map((r) => {
    const off = r.buyer_offer_crm_id ? offerById.get(r.buyer_offer_crm_id) : null;
    return { ...r, did: digits10(r.did), account_crm_id: r.account_crm_id ?? off?.account_crm_id ?? null, raw: null };
  }).filter((r) => r.did.length === 10);
  const badDids = objRows.did.length - didRows.length;
  // offers show their DIDs (read-only summary)
  const didsByOffer = new Map<string, string[]>();
  for (const d of didRows) if (d.buyer_offer_crm_id && !d.end_date) {
    const a = didsByOffer.get(d.buyer_offer_crm_id) ?? []; a.push(`(${d.did.slice(0, 3)}) ${d.did.slice(3, 6)}-${d.did.slice(6)}`); didsByOffer.set(d.buyer_offer_crm_id, a);
  }
  for (const r of objRows.buyer_offer) r.did = (didsByOffer.get(r.crm_id) ?? []).join(", ") || null;

  // ── dashboard records for Buyer Offers ──
  const [clients, ccs, pcs, links0] = await Promise.all([
    dbAll("clients?select=id,name,crm_company_id,active"),
    dbAll("client_campaigns?select=id,name,client_id,crm_offer_id,price_per_call,vertical"),
    dbAll("publisher_campaigns?select=id,name,callgrid_campaign_name"),
    dbAll("integration_links?system=eq.hubspot&select=entity_type,local_id,external_id"),
  ]);
  const clientByCo = new Map(clients.filter((c) => c.crm_company_id).map((c) => [c.crm_company_id, c]));
  const clientByName = new Map(clients.map((c) => [norm(c.name), c]));
  const ccByOffer = new Map(ccs.filter((c) => c.crm_offer_id).map((c) => [c.crm_offer_id, c]));
  const created = { clients: [] as string[], campaigns: [] as string[], updated: [] as string[] };
  const today = runTs.slice(0, 10);
  for (const o of objRows.buyer_offer) {
    if (!o.account_crm_id) continue;   // an offer must hang off a company
    let cl = clientByCo.get(o.account_crm_id);
    if (!cl) {
      const coName = companyName.get(o.account_crm_id) ?? o.account_name ?? "(buyer)";
      const byName = clientByName.get(norm(coName));
      if (byName && !byName.crm_company_id) {
        await db("PATCH", `clients?id=eq.${byName.id}`, { crm_company_id: o.account_crm_id });
        cl = { ...byName, crm_company_id: o.account_crm_id };
      } else {
        const r = await db("POST", "clients", [{ name: coName, crm_company_id: o.account_crm_id, callgrid_buyer_name: coName }], "return=representation");
        cl = (await r.json())[0];
        created.clients.push(coName);
      }
      clientByCo.set(o.account_crm_id, cl);
    }
    const cc = ccByOffer.get(o.crm_id);
    const want = { name: o.name || "(offer)", client_id: cl.id, price_per_call: o.rate ?? null, vertical: o.vertical ?? null };
    if (!cc) {
      const r = await db("POST", "client_campaigns", [{
        ...want, crm_offer_id: o.crm_id, callgrid_campaign_name: o.callgrid_campaign ?? null,
        billing_frequency: "weekly", billing_type: "net_terms", net_terms: 7, start_date: today, active: o.active !== false,
      }], "return=representation");
      const row = (await r.json())[0];
      ccByOffer.set(o.crm_id, row);
      created.campaigns.push(`${want.name} — ${cl.name}`);
    } else if (cc.name !== want.name || cc.client_id !== want.client_id || Number(cc.price_per_call ?? NaN) !== Number(want.price_per_call ?? NaN) || (cc.vertical ?? null) !== want.vertical) {
      await db("PATCH", `client_campaigns?id=eq.${cc.id}`, want);
      created.updated.push(want.name);
    }
  }
  // dashboard ids onto the mirror (and back onto HubSpot when they differ)
  const pcByCg = new Map(pcs.filter((p) => p.callgrid_campaign_name).map((p) => [String(p.callgrid_campaign_name).trim().toLowerCase(), p]));
  const idWrites: { type: string; id: string; value: string }[] = [];
  for (const o of objRows.buyer_offer) {
    const cc = ccByOffer.get(o.crm_id);
    const want = cc ? `cc_${cc.id}` : null;
    if (want && o.dashboard_id !== want) { idWrites.push({ type: typeId.buyer_offer, id: o.crm_id, value: want }); o.dashboard_id = want; }
  }
  for (const p of objRows.publisher_campaign) {
    const pc = p.callgrid_campaign ? pcByCg.get(String(p.callgrid_campaign).trim().toLowerCase()) : null;
    const want = pc ? `pc_${pc.id}` : null;
    if (want && p.dashboard_id !== want) { idWrites.push({ type: typeId.publisher_campaign, id: p.crm_id, value: want }); p.dashboard_id = want; }
  }
  for (const w of idWrites) {
    try { await hs(`/crm/v3/objects/${w.type}/${w.id}`, { method: "PATCH", body: JSON.stringify({ properties: { dashboard_id: w.value } }) }); }
    catch (e) { await logEvent("hubspot", "error", "Couldn't write dashboard_id to HubSpot", String((e as Error).message), "outbound"); }
  }

  // ── write mirrors (activity stamps vs. the previous mirror) ──
  const prev = async (table: string, side?: string) => {
    const cols = ["crm_id", "activity_at", ...(TRACKED[table] ?? [])].join(",");
    const rows = await dbAll(`${table}?select=${cols}${side ? `&side=eq.${side}` : ""}`).catch(() => []);
    return new Map(rows.map((r: any) => [String(r.crm_id), r]));
  };
  stampActivity("ob_accounts", acctRows, await prev("ob_accounts"), runTs);
  stampActivity("ob_prospects", prosRows, await prev("ob_prospects"), runTs);
  stampActivity("ob_campaigns", objRows.buyer_offer, await prev("ob_campaigns", "buyer"), runTs);
  stampActivity("ob_campaigns", objRows.publisher_campaign, await prev("ob_campaigns", "publisher"), runTs);

  await upsert("hubspot_companies", hcRows, "external_id");
  await upsert("hubspot_contacts", contactRows, "external_id");
  await upsert("ob_accounts", acctRows, "crm_id");
  await upsert("ob_prospects", prosRows, "crm_id");
  const seen = (o: CrmObject) => !!typeId[o.key];
  if (seen(OBJECTS[0])) await upsert("ob_campaigns", objRows.buyer_offer, "crm_id");
  if (seen(OBJECTS[1])) await upsert("ob_campaigns", objRows.publisher_campaign, "crm_id");
  if (typeId.agreement) await upsert("ob_contracts", objRows.agreement, "crm_id");
  if (typeId.campaign_match) await upsert("ob_campaign_matches", objRows.campaign_match, "crm_id");
  if (typeId.agreement_link) await upsert("ob_agreement_links", objRows.agreement_link, "crm_id");
  if (typeId.did) await upsert("crm_dids", didRows, "crm_id");
  // prune what no longer exists in HubSpot (only tables that were fetched)
  const ts = encodeURIComponent(runTs);
  await db("DELETE", `hubspot_companies?synced_at=lt.${ts}`);
  await db("DELETE", `hubspot_contacts?synced_at=lt.${ts}`);
  await db("DELETE", `ob_accounts?synced_at=lt.${ts}`);
  await db("DELETE", `ob_prospects?synced_at=lt.${ts}`);
  if (typeId.buyer_offer) await db("DELETE", `ob_campaigns?side=eq.buyer&synced_at=lt.${ts}`);
  if (typeId.publisher_campaign) await db("DELETE", `ob_campaigns?side=eq.publisher&synced_at=lt.${ts}`);
  if (typeId.agreement) await db("DELETE", `ob_contracts?synced_at=lt.${ts}`);
  if (typeId.campaign_match) await db("DELETE", `ob_campaign_matches?synced_at=lt.${ts}`);
  if (typeId.agreement_link) await db("DELETE", `ob_agreement_links?synced_at=lt.${ts}`);
  if (typeId.did) await db("DELETE", `crm_dids?synced_at=lt.${ts}`);

  // property labels for the CRM tab's "All HubSpot properties"
  await upsert("ob_field_meta", companyPropsMeta.map((p: any) => ({
    module: "Accounts", api_name: String(p.name), label: String(p.label || p.name), data_type: String(p.type || ""), updated_at: runTs,
  })), "module,api_name");

  // portal + object ids for record links
  await upsert("crm_meta", [
    { key: "portal_id", value: portalId, updated_at: runTs }, { key: "ui_domain", value: uiDomain, updated_at: runTs },
    ...OBJECTS.filter((o) => typeId[o.key]).map((o) => ({ key: `type:${o.key}`, value: typeId[o.key], updated_at: runTs })),
  ], "key");

  // ── link companies to dashboard clients/publishers ──
  const publishers = await dbAll("publishers?select=id,name");
  const linkedExt = new Set(links0.map((l: any) => `${l.entity_type}|${l.external_id}`));
  const linkedLocal = new Set(links0.map((l: any) => `${l.entity_type}|${l.local_id}`));
  let newLinks = 0;
  const addLink = async (type: string, localId: string, extId: string, label: string) => {
    if (linkedExt.has(`${type}|${extId}`) || linkedLocal.has(`${type}|${localId}`)) return;
    try {
      await db("POST", "integration_links", [{ entity_type: type, local_id: localId, system: "hubspot", external_id: extId, external_label: label }], "return=minimal");
      linkedExt.add(`${type}|${extId}`); linkedLocal.add(`${type}|${localId}`); newLinks++;
    } catch (_e) { /* unique conflict: already linked */ }
  };
  for (const cl of clientByCo.values()) if (cl.crm_company_id) await addLink("client", cl.id, cl.crm_company_id, companyName.get(cl.crm_company_id) ?? cl.name);
  const locals = [
    ...clients.filter((c) => !c.crm_company_id).map((c) => ({ type: "client", id: c.id, name: c.name })),
    ...publishers.map((p: any) => ({ type: "publisher", id: p.id, name: p.name })),
  ];
  for (const c of companies) {
    const key = norm(companyName.get(c.id));
    if (!key) continue;
    for (const type of ["client", "publisher"]) {
      if (linkedExt.has(`${type}|${c.id}`)) continue;
      const hits = locals.filter((l) => l.type === type && !linkedLocal.has(`${type}|${l.id}`) && norm(l.name) === key);
      if (hits.length === 1) await addLink(type, hits[0].id, c.id, companyName.get(c.id)!);
    }
  }
  // account_status → clients.active for linked clients
  const allLinks = await dbAll("integration_links?system=eq.hubspot&entity_type=eq.client&select=local_id,external_id");
  const statusOf = new Map(companies.map((c) => [c.id, String(c.properties.account_status ?? "").toLowerCase()]));
  const freshClients = await dbAll("clients?select=id,active");
  let statusUpdates = 0;
  for (const l of allLinks) {
    const st = statusOf.get(String(l.external_id));
    if (st !== "active" && st !== "inactive") continue;
    const cl = freshClients.find((c: any) => c.id === l.local_id);
    if (cl && cl.active !== (st === "active")) { await db("PATCH", `clients?id=eq.${cl.id}`, { active: st === "active" }); statusUpdates++; }
  }

  // ── re-attribute calls when anything that decides revenue changed ──
  const attrKey = JSON.stringify([
    didRows.map((d) => [d.crm_id, d.did, d.buyer_offer_crm_id, d.start_date, d.end_date]).sort(),
    objRows.buyer_offer.map((o) => [o.crm_id, o.rate, o.billable_duration, o.account_crm_id, o.name]).sort(),
    [...ccByOffer.entries()].map(([k, v]) => [k, v.id, v.client_id]).sort(),
  ]);
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attrKey));
  const attrHash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const prevHash = (await dbAll("crm_meta?key=eq.attribution_hash&select=value"))?.[0]?.value ?? null;
  let attribution: any = null;
  if (attrHash !== prevHash) {
    attribution = await rpc("nyala_attribute_calls", {});
    await upsert("crm_meta", [{ key: "attribution_hash", value: attrHash, updated_at: runTs }], "key");
  }

  const linked = new Set(allLinks.map((l: any) => String(l.external_id)));
  const pubLinks = await dbAll("integration_links?system=eq.hubspot&entity_type=eq.publisher&select=local_id,external_id");
  for (const l of pubLinks) linked.add(String(l.external_id));
  const linkedLocalAll = new Set([...allLinks, ...pubLinks].map((l: any) => String(l.local_id)));
  Object.assign(out, {
    crm_accounts: companies.length,
    prospects: prosRows.length,
    contacts: contactRows.length,
    buyer_offers: objRows.buyer_offer.length,
    publisher_campaigns: objRows.publisher_campaign.length,
    agreements: objRows.agreement.length,
    campaign_matches: objRows.campaign_match.length,
    agreement_links: objRows.agreement_link.length,
    dids: didRows.length,
    dids_skipped_bad_number: badDids,
    created_clients: created.clients, created_campaigns: created.campaigns, updated_campaigns: created.updated,
    matched: linked.size, new_links: newLinks, status_updates: statusUpdates,
    attribution: attribution ?? "unchanged",
    missing_objects: missingObjects,
    unmatched_crm: companies.filter((c) => !linked.has(c.id)).map((c) => ({ id: c.id, name: companyName.get(c.id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    unmatched_local: locals.filter((l) => !linkedLocalAll.has(l.id)).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let background = false;
  try { background = (await req.json())?.background === true; } catch { /* {} */ }
  const run = async () => {
    try {
      const r = await runSync();
      await logEvent("hubspot", "ok",
        `HubSpot sync: ${r.crm_accounts} companies, ${r.buyer_offers} offers, ${r.dids} DIDs` +
        ((r.created_campaigns as string[]).length ? `, ${(r.created_campaigns as string[]).length} new campaign(s)` : "") +
        (r.attribution !== "unchanged" ? ", calls re-attributed" : ""));
      await markSystem("hubspot", true);
      return r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      await logEvent("hubspot", "error", "HubSpot sync failed", msg);
      await markSystem("hubspot", false, msg);
      throw e;
    }
  };
  if (background) {
    // @ts-ignore EdgeRuntime exists on Supabase
    if (typeof EdgeRuntime !== "undefined") { EdgeRuntime.waitUntil(run().catch(() => {})); return json({ started: true }); }
  }
  try { return json(await run()); }
  catch (e) { return json({ error: String((e as Error)?.message ?? e) }, 500); }
});
