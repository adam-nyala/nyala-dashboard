// hubspot-sync — mirrors HubSpot companies + contacts into Supabase, auto-links
// unambiguous name matches to dashboard clients/publishers, and flows each
// linked client's account_status back onto clients.active.
//
// Called by: Integrations > "Run Account Sync" and a 15-minute pg_cron job.
// Secrets: HUBSPOT_TOKEN (plus the built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
// HubSpot is the source of truth; this function never writes to HubSpot.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hs, COMPANY_PROPS, CONTACT_PROPS, STATUS_PROP } from "../_shared/hubspot.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/&/g, " and ")
    .replace(/\b(llc|inc|corp|corporation|co|ltd|lp|llp|pllc|group|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();

async function pageAll(path: string, params: Record<string, string>) {
  const out: any[] = [];
  let after: string | undefined;
  do {
    const q = new URLSearchParams({ limit: "100", archived: "false", ...params, ...(after ? { after } : {}) });
    const page = await hs(`${path}?${q}`);
    out.push(...(page.results || []));
    after = page.paging?.next?.after;
  } while (after);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const started = new Date().toISOString();
  try {
    // Portal details give us correct "Open in HubSpot" links (US or EU data center).
    const acct = await hs("/account-info/v3/details");
    const portalId = acct.portalId;
    const uiDomain = acct.uiDomain || "app.hubspot.com";
    const recordUrl = (id: string) => `https://${uiDomain}/contacts/${portalId}/record/0-2/${id}`;

    // ── Companies ──
    const companies = await pageAll("/crm/v3/objects/companies", { properties: Object.keys(COMPANY_PROPS).join(",") });
    // ── Contacts (with company associations) ──
    const contacts = await pageAll("/crm/v3/objects/contacts", {
      properties: CONTACT_PROPS.join(","),
      associations: "companies",
    });

    const contactsByCompany = new Map<string, any[]>();
    const contactRows = contacts.map((c) => {
      const p = c.properties || {};
      const companyId = c.associations?.companies?.results?.[0]?.id ?? null;
      const row = {
        external_id: String(c.id),
        account_external_id: companyId ? String(companyId) : null,
        first_name: p.firstname || null,
        last_name: p.lastname || null,
        full_name: [p.firstname, p.lastname].filter(Boolean).join(" ") || null,
        email: p.email || null,
        phone: p.phone || null,
        mobile: p.mobilephone || null,
        title: p.jobtitle || null,
        raw: c,
        synced_at: started,
      };
      if (row.account_external_id) {
        const list = contactsByCompany.get(row.account_external_id) || [];
        list.push(row);
        contactsByCompany.set(row.account_external_id, list);
      }
      return row;
    });

    const companyRows = companies.map((c) => {
      const p = c.properties || {};
      const row: Record<string, unknown> = { external_id: String(c.id), record_url: recordUrl(c.id), raw: c, synced_at: started };
      for (const [prop, col] of Object.entries(COMPANY_PROPS)) row[col] = p[prop] ?? null;
      if (!row.name) row.name = p.domain || `(unnamed company ${c.id})`;
      // Primary contact: first associated contact (HubSpot has no single "primary" field).
      const first = (contactsByCompany.get(String(c.id)) || [])[0];
      row.primary_contact_name = first?.full_name ?? null;
      row.primary_contact_email = first?.email ?? null;
      row.primary_contact_phone = first?.phone ?? first?.mobile ?? null;
      return row;
    });

    // ── Upsert mirrors, then remove rows that no longer exist in HubSpot ──
    const chunk = <T,>(a: T[], n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
    for (const part of chunk(companyRows)) {
      const { error } = await db.from("hubspot_companies").upsert(part, { onConflict: "external_id" });
      if (error) throw new Error(`hubspot_companies upsert: ${error.message}`);
    }
    for (const part of chunk(contactRows)) {
      const { error } = await db.from("hubspot_contacts").upsert(part, { onConflict: "external_id" });
      if (error) throw new Error(`hubspot_contacts upsert: ${error.message}`);
    }
    await db.from("hubspot_companies").delete().lt("synced_at", started);
    await db.from("hubspot_contacts").delete().lt("synced_at", started);

    // ── Linking: HubSpot company <-> dashboard client/publisher ──
    const [{ data: clients }, { data: publishers }, { data: links }] = await Promise.all([
      db.from("clients").select("id,name,active"),
      db.from("publishers").select("id,name"),
      db.from("integration_links").select("entity_type,local_id,external_id").eq("system", "hubspot"),
    ]);
    const linkedExt = new Set((links || []).map((l) => String(l.external_id)));
    const linkedLocal = new Set((links || []).map((l) => `${l.entity_type}|${l.local_id}`));
    const locals = [
      ...(clients || []).map((c) => ({ type: "client", id: c.id, name: c.name })),
      ...(publishers || []).map((p) => ({ type: "publisher", id: p.id, name: p.name })),
    ];
    let newLinks = 0;
    for (const co of companyRows) {
      const ext = String(co.external_id);
      if (linkedExt.has(ext)) continue;
      const key = norm(co.name);
      if (!key) continue;
      const hits = locals.filter((l) => !linkedLocal.has(`${l.type}|${l.id}`) && norm(l.name) === key);
      if (hits.length !== 1) continue; // ambiguous or no match: leave for manual linking
      const h = hits[0];
      const { error } = await db.from("integration_links").insert({
        entity_type: h.type, local_id: h.id, system: "hubspot", external_id: ext, external_label: co.name,
      });
      if (!error) { newLinks++; linkedExt.add(ext); linkedLocal.add(`${h.type}|${h.id}`); }
    }

    // ── Flow-back: HubSpot account_status -> clients.active for linked clients ──
    const { data: allLinks } = await db.from("integration_links")
      .select("entity_type,local_id,external_id").eq("system", "hubspot").eq("entity_type", "client");
    const byExt = new Map(companyRows.map((c) => [String(c.external_id), c]));
    let statusUpdates = 0;
    for (const l of allLinks || []) {
      const co = byExt.get(String(l.external_id));
      const st = String(co?.[STATUS_PROP] ?? "").toLowerCase();
      if (st !== "active" && st !== "inactive") continue;
      const want = st === "active";
      const cl = (clients || []).find((c) => c.id === l.local_id);
      if (cl && cl.active !== want) {
        await db.from("clients").update({ active: want }).eq("id", cl.id);
        statusUpdates++;
      }
    }

    const unmatchedCrm = companyRows
      .filter((c) => !linkedExt.has(String(c.external_id)))
      .map((c) => ({ id: String(c.external_id), name: c.name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const unmatchedLocal = locals
      .filter((l) => !linkedLocal.has(`${l.type}|${l.id}`))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const result = {
      crm_accounts: companyRows.length,
      contacts: contactRows.length,
      matched: linkedExt.size,
      new_links: newLinks,
      status_updates: statusUpdates,
      unmatched_crm: unmatchedCrm,
      unmatched_local: unmatchedLocal,
    };
    await db.from("integration_systems").update({ last_ok_at: new Date().toISOString(), last_error: null }).eq("id", "hubspot");
    await db.from("integration_log").insert({
      system: "hubspot", status: "ok", direction: "inbound",
      event: `HubSpot sync: ${companyRows.length} companies, ${contactRows.length} contacts, ${newLinks} new links`,
    });
    return json(result);
  } catch (e) {
    const msg = String((e as Error).message || e);
    await db.from("integration_systems").update({ last_error_at: new Date().toISOString(), last_error: msg }).eq("id", "hubspot");
    await db.from("integration_log").insert({ system: "hubspot", status: "error", direction: "inbound", event: "HubSpot sync failed", detail: msg });
    return json({ error: msg }, 500);
  }
});
