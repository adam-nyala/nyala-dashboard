# Nyala Labs Operations Dashboard

A Nyala Labs-branded clone of the OmniSure dashboard, built with React, Vite and Supabase in a single-file `src/App.jsx`. It deploys from GitHub to Vercel.

- **Calls:** CallGrid, through the `callgrid-sync` edge function on a 15-minute cron.
- **CRM:** HubSpot. HubSpot is the source of truth. The CRM tab and Account Status read a mirror kept current by `hubspot-sync`. Toggling a client between Active and Inactive writes back to HubSpot through `hubspot-write`.

## Where things live
- **Brand and feature switches:** the `BRAND` and `FEATURES` constants at the top of `src/App.jsx`.
  - On: HubSpot.
  - Off until Nyala adopts them: Kaliper, Mercury bank feed, Roku sync, and IO intake.
- **Invoice remit details:** `INVOICE_COMPANY` and `INVOICE_BANK` in `src/App.jsx`. These are blank on purpose. Until a bank account is filled in, invoices leave out the payment-instruction pages.
- **Terms & Conditions:** the T&C text was carried over from the OmniSure template with the company name changed. Have counsel review it before it goes on Nyala invoices.
- **Logo files:** in `public/`, as light and dark lockups, light and dark marks, and the favicon. The PDF logo is embedded as `NYALA_LOGO`.

## HubSpot setup
1. In HubSpot, create a private app with these scopes:
   - `crm.objects.companies.read`
   - `crm.objects.companies.write`
   - `crm.objects.contacts.read`
2. In Supabase, store the app's token as the secret `HUBSPOT_TOKEN`.
3. Optionally, create custom company properties with these internal names so the CRM columns fill in:
   - `account_status`, with options Active and Inactive. This one is required for status write-back.
   - `partner_type`, `msa_status`, `msa_signed_date`, `onboarding_status`, `payment_terms`, `dba`
   - The full list is in `supabase/functions/_shared/hubspot.ts`.

## Supabase
- `supabase/sql/01_nyala_schema.sql`: the full database structure, built from OmniSure's with no data. Zoho is swapped for HubSpot, the creative-review storage is limited to staff, and the integration and log sources are pre-loaded.
- `supabase/sql/02_log_sources.sql`: a one-time patch for projects created before the log sources were added to 01.
- `supabase/functions/`: the backend functions:
  - `callgrid-sync`, `callgrid-ping-sync`, `alert-engine`, `daily-brief`, `admin-create-user` and `dispo-ingest` are ported from OmniSure.
  - `creative-generate` is ported and now limited to staff.
  - `hubspot-sync` and `hubspot-write` are new.
- Secrets to set in Supabase (Edge Functions > Secrets):
  - `CALLGRID_API_KEY`
  - `HUBSPOT_TOKEN`
  - `RESEND_API_KEY` and `RESEND_FROM`
  - `OPENAI_API_KEY`
- Not needed for Nyala: `ZOHO_*`, `KALIPER_API_KEY` and `CALLGRID_MANAGE_KEY`.
