// admin-create-user v3 — creates a dashboard login (public signups are off).
// Verifies the CALLER is an admin, then creates the account pre-confirmed
// and writes its user_profiles row with the requested role.
// v3: accepts the full role set — admin, staff, operations, finance, sales,
// agent — and REJECTS unknown roles instead of silently saving "staff".
// POST { email, password, role } → { id }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ROLES = ["admin", "staff", "operations", "finance", "sales", "agent"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // 1. The caller must be a signed-in admin
    const authHeader = req.headers.get("Authorization") ?? "";
    const ur = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE, Authorization: authHeader },
    });
    if (!ur.ok) return json({ error: "Not signed in" }, 401);
    const caller = await ur.json();
    const pr = await fetch(
      `${SB_URL}/rest/v1/user_profiles?user_id=eq.${caller.id}&select=role`,
      { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
    );
    const prof = await pr.json();
    if (prof?.[0]?.role !== "admin") return json({ error: "Admins only" }, 403);

    // 2. Validate the request
    const { email, password, role } = await req.json();
    if (!email || !/@/.test(String(email))) return json({ error: "Valid email required" }, 400);
    if (!password || String(password).length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
    if (!ROLES.includes(String(role))) return json({ error: `Role must be one of: ${ROLES.join(", ")}` }, 400);

    // 3. Create the account, pre-confirmed
    const cr = await fetch(`${SB_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const created = await cr.json();
    if (!cr.ok || !created?.id) {
      return json({ error: created?.msg || created?.message || `User creation failed (HTTP ${cr.status})` }, 400);
    }

    // 4. Profile row with the requested role
    const upr = await fetch(`${SB_URL}/rest/v1/user_profiles?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{ user_id: created.id, email, role }]),
    });
    if (!upr.ok) {
      return json({ error: `Account created but profile write failed: ${(await upr.text()).slice(0, 200)}` }, 500);
    }

    return json({ id: created.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
