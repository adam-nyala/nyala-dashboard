// hubspot-write — pushes a dashboard client's Active/Inactive status to its
// linked HubSpot company (property: account_status). Staff only: the caller's
// JWT is verified and agents are refused.
// Body: { client_id: uuid, status: "Active" | "Inactive" }
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hs, STATUS_PROP } from "../_shared/hubspot.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  try {
    // ── who is calling? ──
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error: uerr } = await db.auth.getUser(jwt);
    if (uerr || !u?.user) return json({ error: "Sign in required" }, 401);
    const { data: prof } = await db.from("user_profiles").select("role").eq("user_id", u.user.id).maybeSingle();
    // Same staff roles as public.is_staff()
    if (!prof || !["admin", "staff", "operations", "finance", "sales"].includes(prof.role)) return json({ error: "Not allowed" }, 403);

    const { client_id, status } = await req.json();
    if (!client_id || !["Active", "Inactive"].includes(status)) return json({ error: "client_id and status (Active|Inactive) are required" }, 400);

    const { data: link } = await db.from("integration_links").select("external_id")
      .eq("system", "hubspot").eq("entity_type", "client").eq("local_id", client_id).maybeSingle();
    if (!link) return json({ error: "This client isn't linked to a HubSpot company yet" }, 400);

    try {
      await hs(`/crm/v3/objects/companies/${link.external_id}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: { [STATUS_PROP]: status } }),
      });
    } catch (e) {
      const err = e as Error & { category?: string };
      if (err.category === "VALIDATION_ERROR" && /property/i.test(err.message)) {
        throw new Error(`HubSpot has no "${STATUS_PROP}" company property with an "${status}" option. Create it in HubSpot (Settings > Properties > Company) with options Active / Inactive.`);
      }
      throw e;
    }
    await db.from("hubspot_companies").update({ [STATUS_PROP]: status }).eq("external_id", link.external_id);
    await db.from("integration_log").insert({
      system: "hubspot", status: "ok", direction: "outbound", entity_type: "client", entity_id: String(client_id), event: `Client set ${status} → HubSpot company ${link.external_id} (by ${u.user.email})`,
    });
    return json({ ok: true });
  } catch (e) {
    const msg = String((e as Error).message || e);
    await db.from("integration_log").insert({ system: "hubspot", status: "error", direction: "outbound", event: "HubSpot status write failed", detail: msg });
    return json({ error: msg }, 500);
  }
});
