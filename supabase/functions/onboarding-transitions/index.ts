// onboarding-transitions v1-nyala — Nyala build of OmniSure's go-live engine.
// NYALA: the partner's CallGrid key can't read campaign status (cg_status),
// so VERIFIED LIVE is proven from what Nyala does see:
//   buyer offer        → its dashboard campaign has a CURRENT DID in HubSpot
//                        (crm_dids, no end date in the past) AND at least one
//                        call attributed to that campaign
//   publisher campaign → its dashboard lane carries CallGrid's stable
//                        campaign ID AND at least one observed call
// Everything else below is OmniSure's engine with Zoho swapped for HubSpot
// (ids are crm_id; links are the HubSpot record URLs from the mirror).
//
// (OmniSure v1 notes follow.)
// onboarding-transitions v1 — verified go-live engine (spec 5 / 5.1 / 5.2)
// + alert enqueueing (spec 6.1 / 6.2). DASHBOARD STATE ONLY: writes go to
// ob_overrides (the existing visibility ledger), onboarding_history and
// alert_outbox. HubSpot and CallGrid are never written.
//
// VERIFIED LIVE (the only transition trigger): the campaign's dashboard row
// carries a stable CallGrid campaign ID, its cg_status is 'live', AND at
// least one call is observed on that dashboard campaign. Created, configured,
// signed, or HubSpot-Active alone never qualify. The recorded time is "first
// detected live" (hourly sync), never a claimed launch timestamp.
//
// FLAGS (integration_secrets):
//   onboarding_transitions_enabled: 'true' lets runs write; anything else =
//     every run is a DRY RUN that only reports.
//   intro_baseline_at: set by {seed_baseline:true}; intro emails are never
//     enqueued before the baseline exists (no historical flood).
//
// POST body:
//   {} or {cron:true}     → run (dry unless enabled)
//   { dry_run: true }     → force dry run even when enabled
//   { seed_baseline: true } → mark every existing campaign as already
//     introduced (suppressed) so deploy day sends nothing. Run ONCE before
//     enabling emails.
//
// Precedence (spec 2.2): a human-set override on a record always wins — the
// engine never replaces or deactivates it; completion facts still land in
// history. Every engine write is idempotent (unique keys, ignore-duplicates).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// agreements created before this never count as new onboarding paperwork
// (integration_secrets onboarding_cutoff overrides; Nyala's history starts Nov 2026)
let CUTOFF = "2026-11-01";
// dashboard link in alert emails (integration_secrets dashboard_url)
let DASH_URL = "";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function db(method: string, path: string, body?: unknown, prefer?: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: prefer ?? "return=minimal" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
}
async function dbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  if (!r.ok) throw new Error(`DB GET ${path.split("?")[0]}: ${r.status}`);
  return r.json();
}
async function dbAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await dbGet(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const isNewAgreement = (k: any) =>
  /IO/i.test(k.document_type || "") && ["Sent", "Signed"].includes(k.status || "") && String(k.created_time || "") >= CUTOFF;
const hasDocEvidence = (k: any) => !!(k.signed_pdf_link || k.doc_file_link || k.sign_document_id);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* fine */ }

  try {
    const secrets = await dbGet("integration_secrets?key=in.(onboarding_transitions_enabled,intro_baseline_at,onboarding_cutoff,dashboard_url)&select=key,value");
    const flag = (k: string) => secrets.find((s: any) => s.key === k)?.value;
    if (flag("onboarding_cutoff")) CUTOFF = String(flag("onboarding_cutoff"));
    DASH_URL = String(flag("dashboard_url") || "").replace(/\/+$/, "");
    const enabled = flag("onboarding_transitions_enabled") === "true" && body.dry_run !== true;
    const baselined = !!flag("intro_baseline_at");

    // ── one-time baseline: mark every existing campaign as already introduced ──
    if (body.seed_baseline === true) {
      const camps0 = await dbAll("ob_campaigns?select=crm_id,side,account_name,name");
      const rows = camps0.map((c: any) => ({
        kind: "campaign_introduced", dedupe_key: `intro:${c.crm_id}`, status: "suppressed",
        payload: { suppressed: "pre-existing at baseline", account: c.account_name, campaign: c.name, side: c.side },
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await db("POST", "alert_outbox?on_conflict=dedupe_key", rows.slice(i, i + 200), "resolution=ignore-duplicates,return=minimal");
      }
      await db("POST", "integration_secrets?on_conflict=key",
        [{ key: "intro_baseline_at", value: new Date().toISOString(), updated_at: new Date().toISOString() }],
        "resolution=merge-duplicates,return=minimal");
      return json({ seeded: rows.length, note: "all existing campaigns marked as already introduced; no emails will ever be sent for them" });
    }

    const [camps, accts, contracts, overrides, history, cc, pc, outKeys, agLinks] = await Promise.all([
      dbAll("ob_campaigns?select=*"),
      dbAll("ob_accounts?select=*"),
      dbAll("ob_contracts?select=*"),
      dbAll("ob_overrides?active=eq.true&select=record_type,crm_id,field,value,set_by"),
      dbAll("onboarding_history?select=unique_key,campaign_crm_id,doc_flags,id"),
      dbAll("client_campaigns?select=id,cg_campaign_id,name,crm_offer_id"),
      dbAll("publisher_campaigns?select=id,cg_campaign_id,name"),
      dbAll("alert_outbox?select=dedupe_key"),
      dbAll("ob_agreement_links?select=*").catch(() => []),
    ]);
    // Nyala: offers with a current DID (the number is assigned and not ended)
    const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const dids = await dbAll("crm_dids?select=buyer_offer_crm_id,start_date,end_date");
    const offersWithDid = new Set(dids.filter((d: any) => d.buyer_offer_crm_id && (!d.end_date || d.end_date >= todayEt) && (!d.start_date || d.start_date <= todayEt)).map((d: any) => d.buyer_offer_crm_id));
    const accById = new Map(accts.map((a: any) => [a.crm_id, a]));
    const ccById = new Map(cc.map((x: any) => [String(x.id), x]));
    const pcById = new Map(pc.map((x: any) => [String(x.id), x]));
    const ovMap = new Map(overrides.map((o: any) => [`${o.record_type}|${o.crm_id}|${o.field}`, o]));
    const histKeys = new Set(history.map((h: any) => h.unique_key));
    const outSet = new Set(outKeys.map((o: any) => o.dedupe_key));
    const conByCamp = new Map<string, any[]>();
    for (const k of contracts) {
      for (const cid of [k.buyer_campaign_crm_id, k.publisher_campaign_crm_id]) {
        if (cid) { const l = conByCamp.get(cid) ?? []; l.push(k); conByCamp.set(cid, l); }
      }
    }
    // Agreement Campaign Links junction: one agreement can cover many campaigns
    const conById = new Map(contracts.map((k: any) => [k.crm_id, k]));
    for (const al of agLinks) {
      if (["Removed", "Superseded"].includes(al.link_status || "")) continue;
      const k = conById.get(al.agreement_crm_id);
      if (!k) continue;
      for (const cid of [al.buyer_campaign_crm_id, al.publisher_campaign_crm_id]) {
        if (!cid) continue;
        const l = conByCamp.get(cid) ?? [];
        if (!l.some((x: any) => x.crm_id === k.crm_id)) { l.push(k); conByCamp.set(cid, l); }
      }
    }
    const acctStatusOf = (c: any) => {
      const a = accById.get(c.account_crm_id);
      return a ? String((c.side === "buyer" ? a.buyer_account_status : a.publisher_account_status) || "") : "";
    };
    const inOnboarding = (st: string) => st.startsWith("Intake") || st.startsWith("Onboarding");
    const isActiveWork = (c: any) => {
      const inc = ovMap.get(`${c.side}_campaign|${c.crm_id}|report_include`)?.value;
      if (inc === "false") return false;
      if (inc === "true") return true;
      if (c.offer_status && c.offer_status !== "Complete") return true;
      if (/^Pending IO/.test(c.campaign_status || "")) return true;
      if (["Draft", "Sent"].includes(c.io_status || "")) return true;
      if ((conByCamp.get(c.crm_id) || []).some(isNewAgreement)) return true;
      if (inOnboarding(acctStatusOf(c))) return true;
      return false;
    };
    // dashboard_id in HubSpot is prefixed by the push ("cc_<id>" / "pc_<id>");
    // the dashboard tables hold the bare id, so strip the prefix to join.
    const dashOf = (c: any) => {
      if (!c.dashboard_id) return null;
      const bare = String(c.dashboard_id).replace(/^(cc_|pc_)/, "");
      return c.side === "buyer" ? ccById.get(bare) : pcById.get(bare);
    };

    const report: any[] = [];
    const writes = { campaigns_completed: 0, accounts_completed: 0, carryovers: 0, intro_enqueued: 0, doc_alerts: 0, doc_flags_cleared: 0 };
    const nowIso = new Date().toISOString();
    const completedAccounts = new Set<string>();

    // doc verification for a campaign at (or after) go-live
    const docCheck = (c: any) => {
      const acc = accById.get(c.account_crm_id);
      const msaDocs = contracts.filter((k: any) => k.account_crm_id === c.account_crm_id && /MSA/i.test(k.document_type || "")
        && (!k.partner_side || String(k.partner_side).toLowerCase().startsWith(c.side.slice(0, 3))));
      const msaOk = msaDocs.some((k: any) => k.status === "Signed" && hasDocEvidence(k));
      const ioDocs = (conByCamp.get(c.crm_id) || []).filter((k: any) => /IO/i.test(k.document_type || ""));
      const ioOk = ioDocs.some((k: any) => k.status === "Signed" && hasDocEvidence(k));
      const cls = !msaOk && !ioOk ? "Both Missing" : !msaOk ? "Signed MSA Missing" : !ioOk ? "Signed IO Missing" : null;
      return { msaOk, ioOk, cls, detail: {
        msa_candidates: msaDocs.map((k: any) => ({ id: k.crm_id, name: k.name, status: k.status, evidence: hasDocEvidence(k) })),
        io_candidates: ioDocs.map((k: any) => ({ id: k.crm_id, name: k.name, status: k.status, evidence: hasDocEvidence(k) })),
        note: acc ? undefined : "account not in mirror",
      } };
    };

    for (const c of camps) {
      if (histKeys.has(`campaign:${c.crm_id}`)) continue;         // already completed — never twice
      if (!isActiveWork(c)) continue;                              // historicals are untouched
      const dc = dashOf(c);
      if (!dc) {
        if (c.campaign_status === "Active") report.push({ campaign: c.name, account: c.account_name, side: c.side, outcome: "needs_review: HubSpot says Active but no dashboard campaign link (stable-ID join missing)" });
        continue;
      }
      // Nyala live evidence (see header): buyer = current DID; publisher = stable CallGrid id
      if (c.side === "buyer" ? !offersWithDid.has(c.crm_id) : !dc.cg_campaign_id) continue; // not verified live yet
      const callCol = c.side === "buyer" ? "client_campaign_id" : "publisher_campaign_id";
      const calls = await dbGet(`callgrid_calls?${callCol}=eq.${dc.id}&select=call_datetime&order=call_datetime.asc&limit=1`);
      if (!calls.length) { report.push({ campaign: c.name, account: c.account_name, side: c.side, outcome: c.side === "buyer" ? "pending_verification: DID assigned, zero attributed calls — no transition" : "pending_verification: CallGrid lane, zero observed calls — no transition" }); continue; }

      // ── VERIFIED LIVE ──
      const docs = docCheck(c);
      const acctSt = acctStatusOf(c);
      const firstLaunch = inOnboarding(acctSt) && !histKeys.has(`account:${c.side}:${c.account_crm_id}`) && !completedAccounts.has(`${c.side}:${c.account_crm_id}`);
      const siblings = firstLaunch ? camps.filter((s: any) => s.account_crm_id === c.account_crm_id && s.side === c.side && s.crm_id !== c.crm_id
        && !histKeys.has(`campaign:${s.crm_id}`) && ovMap.get(`${s.side}_campaign|${s.crm_id}|report_include`)?.value !== "false") : [];
      const row = { campaign: c.name, account: c.account_name, side: c.side, cg_campaign_id: dc.cg_campaign_id,
        first_call_at: calls[0].call_datetime, first_detected_live: nowIso,
        outcome: "verified_live → complete campaign" + (firstLaunch ? `, complete account, carry ${siblings.length} sibling(s) to New Offers` : ""),
        missing_docs: docs.cls || "none" };
      report.push(row);
      if (!enabled) continue;

      // campaign history (idempotent)
      await db("POST", "onboarding_history?on_conflict=unique_key", [{
        kind: "campaign", unique_key: `campaign:${c.crm_id}`,
        account_crm_id: c.account_crm_id, account_name: c.account_name,
        campaign_crm_id: c.crm_id, campaign_name: c.name, side: c.side,
        snapshot: c, contracts: (conByCamp.get(c.crm_id) || []).map((k: any) => ({ id: k.crm_id, name: k.name, status: k.status, type: k.document_type, link: k.doc_file_link || k.signed_pdf_link })),
        verified_live_at: nowIso, cg_campaign_id: dc.cg_campaign_id, first_call_at: calls[0].call_datetime,
        doc_flags: docs.cls ? { classification: docs.cls, detail: docs.detail } : null,
      }], "resolution=ignore-duplicates,return=minimal");
      histKeys.add(`campaign:${c.crm_id}`);
      // remove from active view — unless a human override holds it
      const exOv = ovMap.get(`${c.side}_campaign|${c.crm_id}|report_include`) || ovMap.get(`${c.side}_campaign|${c.crm_id}|keep_active`);
      if (!exOv || exOv.set_by === "go-live engine") {
        await db("POST", "ob_overrides", [{ record_type: `${c.side}_campaign`, crm_id: c.crm_id, field: "report_include", value: "false", set_by: "go-live engine", note: "completed: verified go-live (DID + attributed calls / CallGrid lane + calls)" }]);
      }
      writes.campaigns_completed++;
      // 6.2 missing-doc alert, one per stable state
      if (docs.cls) {
        const key = `docs:${c.crm_id}:${docs.cls}`;
        if (!outSet.has(key)) {
          await db("POST", "alert_outbox?on_conflict=dedupe_key", [{ kind: "golive_missing_docs", dedupe_key: key, payload: {
            classification: docs.cls, account: c.account_name, account_crm_id: c.account_crm_id, campaign: c.name, campaign_crm_id: c.crm_id, side: c.side,
            detail: docs.detail, first_detected_live: nowIso,
            links: { dashboard: DASH_URL ? `${DASH_URL}/#crm` : null, hubspot_campaign: c.record_url || null, hubspot_account: accById.get(c.account_crm_id)?.record_url || null },
          } }], "resolution=ignore-duplicates,return=minimal");
          outSet.add(key); writes.doc_alerts++;
        }
      }
      // verified go-live notification (Decision 8 subscription kind)
      const gKey = `golive:${c.crm_id}`;
      if (!outSet.has(gKey)) {
        await db("POST", "alert_outbox?on_conflict=dedupe_key", [{ kind: "verified_golive", dedupe_key: gKey, payload: {
          account: c.account_name, campaign: c.name, side: c.side, campaign_crm_id: c.crm_id,
          cg_campaign_id: dc.cg_campaign_id, first_call_at: calls[0].call_datetime, first_detected_live: nowIso,
          links: { dashboard: DASH_URL ? `${DASH_URL}/#crm` : null, hubspot: c.record_url || null },
        } }], "resolution=ignore-duplicates,return=minimal");
        outSet.add(gKey);
      }
      // first launch: account history + account removal + sibling carryover
      if (firstLaunch) {
        const acc = accById.get(c.account_crm_id) || {};
        await db("POST", "onboarding_history?on_conflict=unique_key", [{
          kind: "account", unique_key: `account:${c.side}:${c.account_crm_id}`,
          account_crm_id: c.account_crm_id, account_name: c.account_name, side: c.side,
          snapshot: acc, contracts: contracts.filter((k: any) => k.account_crm_id === c.account_crm_id).map((k: any) => ({ id: k.crm_id, name: k.name, status: k.status, type: k.document_type })),
          verified_live_at: nowIso, first_call_at: calls[0].call_datetime,
        }], "resolution=ignore-duplicates,return=minimal");
        histKeys.add(`account:${c.side}:${c.account_crm_id}`);
        completedAccounts.add(`${c.side}:${c.account_crm_id}`);
        const accOv = ovMap.get(`account:${c.side}|${c.account_crm_id}|report_include`);
        if (!accOv || accOv.set_by === "go-live engine") {
          await db("POST", "ob_overrides", [{ record_type: `account:${c.side}`, crm_id: c.account_crm_id, field: "report_include", value: "false", set_by: "go-live engine", note: "account onboarding complete: first campaign verified live" }]);
        }
        writes.accounts_completed++;
        for (const s of siblings) {
          if (!ovMap.get(`${s.side}_campaign|${s.crm_id}|report_include`)) {
            await db("POST", "ob_overrides", [{ record_type: `${s.side}_campaign`, crm_id: s.crm_id, field: "report_include", value: "true", set_by: "go-live engine", note: `carryover to New Offers after ${c.name} launched` }]);
            writes.carryovers++;
          }
        }
      }
    }

    // ── 6.1 campaign-introduced alerts (only after the baseline is seeded) ──
    let introSkipped = "";
    if (!baselined) introSkipped = "intro emails skipped: baseline not seeded — run {seed_baseline:true} once first";
    else {
      for (const c of camps) {
        const key = `intro:${c.crm_id}`;
        if (outSet.has(key)) continue;
        const terms = c.io_payment_terms || c.payment_terms || c.synced_payment_terms || null;
        const provenance = c.io_payment_terms ? "contractual (IO)" : (c.payment_terms || c.synced_payment_terms) ? "configured/synced (NOT verified contractual)" : "Source unknown";
        const row = { kind: "campaign_introduced", dedupe_key: key, status: enabled ? "queued" : "suppressed", payload: {
          account: c.account_name, account_crm_id: c.account_crm_id, side: c.side, campaign: c.name, campaign_crm_id: c.crm_id,
          rate: c.rate ?? c.io_rate ?? null, payment_terms: terms || "Not found", terms_provenance: terms ? provenance : "Source unknown",
          links: { dashboard: DASH_URL ? `${DASH_URL}/#crm` : null, hubspot: c.record_url || null },
        } };
        await db("POST", "alert_outbox?on_conflict=dedupe_key", [row], "resolution=ignore-duplicates,return=minimal");
        outSet.add(key); writes.intro_enqueued++;
      }
    }

    // ── clear doc flags once executed documents are matched ──
    for (const h of history) {
      if (!h.doc_flags || h.doc_flags.cleared_at || !h.campaign_crm_id) continue;
      const c = camps.find((x: any) => x.crm_id === h.campaign_crm_id);
      if (!c) continue;
      const docs = docCheck(c);
      if (!docs.cls) {
        if (enabled) {
          await db("PATCH", `onboarding_history?id=eq.${h.id}`, { doc_flags: { ...h.doc_flags, cleared_at: nowIso, cleared: "executed documents matched" } });
          // retract any UNSENT alert for a state that no longer holds — an
          // email that is no longer true never goes out
          await db("PATCH", `alert_outbox?status=eq.queued&kind=eq.golive_missing_docs&dedupe_key=like.docs:${h.campaign_crm_id}:*`,
            { status: "suppressed", last_error: "resolved before send: executed documents matched" }).catch(() => null);
        }
        writes.doc_flags_cleared++;
      }
    }

    return json({ enabled, dry_run: !enabled, baselined, ...(introSkipped ? { note: introSkipped } : {}),
      would_or_did: writes, decisions: report.slice(0, 60), decisions_total: report.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});