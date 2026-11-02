-- ============================================================================
-- Nyala Labs dashboard: database structure (no data).
-- Built from the OmniSure schema with Zoho swapped for HubSpot.
-- Run once, top to bottom, in the NEW Nyala Supabase project's SQL Editor.
-- ============================================================================

set check_function_bodies = false;

-- EXTENSIONS

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;
create extension if not exists "uuid-ossp" with schema extensions;

-- TYPES

-- SEQUENCES

-- TABLES

create table if not exists public.account_onboarding (
  hubspot_company_id text not null,
  manual_status text,
  notes text,
  todo text,
  updated_by text,
  updated_at timestamp with time zone default now()
);

create table if not exists public.actuals (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  date date not null,
  client text,
  campaign text,
  calls integer default 0,
  revenue numeric(12,2) default 0,
  source text default 'manual'::text,
  callgrid_id text,
  client_id uuid,
  client_campaign_id uuid
);

create table if not exists public.agent_adjustments (
  id uuid default gen_random_uuid() not null,
  created_by uuid default auth.uid() not null,
  agent_id uuid,
  date date default CURRENT_DATE not null,
  amount numeric not null,
  kind text default 'bonus'::text not null,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.agent_licenses (
  id uuid default gen_random_uuid() not null,
  created_by uuid default auth.uid() not null,
  agent_id uuid,
  state text not null,
  license_number text,
  license_class text,
  issue_date date,
  expiry_date date,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.agent_policies (
  id uuid default gen_random_uuid() not null,
  created_by uuid default auth.uid() not null,
  agent_id uuid,
  consumer_id uuid,
  client_name text not null,
  phone text,
  state text,
  product text,
  carrier text,
  policy_number text,
  monthly_premium numeric,
  coverage numeric,
  effective_date date,
  carrier_status text default 'pending'::text not null,
  expected_commission numeric,
  expected_pay_date date,
  payment_status text default 'unpaid'::text not null,
  actual_paid numeric,
  paid_date date,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.agent_scripts (
  id uuid default gen_random_uuid() not null,
  title text not null,
  vertical text,
  body text not null,
  sort_order integer default 100,
  active boolean default true not null,
  updated_at timestamp with time zone default now(),
  created_at timestamp with time zone default now()
);

create table if not exists public.agent_transactions (
  id uuid default gen_random_uuid() not null,
  agent_id uuid not null,
  date date default CURRENT_DATE not null,
  amount numeric not null,
  method text default 'wire'::text,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.agents (
  id uuid default gen_random_uuid() not null,
  name text not null,
  callgrid_buyer_name text,
  rate_per_call numeric,
  low_balance_threshold numeric default 250,
  start_date date default CURRENT_DATE,
  active boolean default true not null,
  notes text,
  created_at timestamp with time zone default now(),
  user_id uuid
);

create table if not exists public.alert_log (
  id uuid default gen_random_uuid() not null,
  alert_type text not null,
  record_id uuid,
  record_name text,
  sent_at timestamp with time zone default now(),
  recipients text[]
);

create table if not exists public.alert_rules (
  id uuid default gen_random_uuid() not null,
  metric text not null,
  label text not null,
  enabled boolean default true not null,
  threshold numeric not null,
  min_volume integer default 0 not null,
  not_before_hour integer default 11 not null,
  cooldown_minutes integer default 240 not null,
  email boolean default true not null,
  severity text default 'warning'::text not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.alerts (
  id uuid default gen_random_uuid() not null,
  rule_id uuid,
  metric text not null,
  severity text default 'warning'::text not null,
  subject text not null,
  message text not null,
  value numeric,
  threshold numeric,
  date date not null,
  dedupe_key text not null,
  fired_at timestamp with time zone default now() not null,
  emailed boolean default false not null,
  status text default 'open'::text not null,
  acked_by uuid,
  acked_at timestamp with time zone
);

create table if not exists public.ap_ledger (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  bill_number text,
  publisher text,
  vertical text,
  bill_date date,
  period_start date,
  period_end date,
  amount_billed numeric(12,2),
  due_date date,
  date_paid date,
  amount_paid numeric(12,2),
  status text default 'Open'::text,
  notes text,
  publisher_campaign_id uuid,
  campaign_name text,
  publisher_id uuid,
  billing_period text,
  cost_per_call numeric(10,4),
  num_calls integer,
  source text default 'manual'::text,
  updated_at timestamp with time zone default now(),
  lead_type text,
  duration_seconds text
);

create table if not exists public.ar_ledger (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  invoice_number text,
  client text,
  vertical text,
  invoice_date date,
  period_start date,
  period_end date,
  amount_billed numeric(12,2),
  due_date date,
  date_sent date,
  date_received date,
  amount_received numeric(12,2),
  status text default 'Open'::text,
  notes text,
  client_campaign_id uuid,
  campaign_name text,
  client_id uuid,
  billing_period text,
  cost_per_call numeric(10,4),
  num_calls integer,
  source text default 'manual'::text,
  updated_at timestamp with time zone default now(),
  lead_type text,
  duration_seconds text
);

create table if not exists public.bid_daily_stats (
  id uuid default gen_random_uuid() not null,
  date date not null,
  source_id text not null,
  source_name text,
  total_pings integer default 0 not null,
  bids integer default 0 not null,
  won integer default 0 not null,
  rated integer default 0 not null,
  rejected integer default 0 not null,
  total_bid_amount numeric(12,2) default 0 not null,
  total_won_amount numeric(12,2) default 0 not null,
  rej_caller_id integer default 0 not null,
  rej_closed integer default 0 not null,
  rej_paused integer default 0 not null,
  rej_duplicate integer default 0 not null,
  rej_duplicate_bids integer default 0 not null,
  rej_failed_acceptance integer default 0 not null,
  rej_failed_tag_rules integer default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.call_analysis (
  inbound_call_id text not null,
  kaliper_call_id bigint,
  status text,
  qc_score numeric,
  qc_pass boolean,
  qc_crit_pass boolean,
  conversion boolean,
  flags jsonb,
  end_by text,
  time_to_connect numeric,
  disposition text,
  summary text,
  coverage_discussed text,
  detectors jsonb,
  analysed_at timestamp with time zone,
  synced_at timestamp with time zone default now() not null
);

create table if not exists public.callgrid_calls (
  id uuid default gen_random_uuid() not null,
  inbound_call_id text not null,
  date date not null,
  call_datetime timestamp with time zone,
  campaign_name text,
  client_campaign_id uuid,
  publisher_name text,
  publisher_campaign_id uuid,
  target_name text,
  call_length_seconds integer,
  revenue numeric default 0,
  payout numeric default 0,
  created_at timestamp with time zone default now(),
  dialed_number text,
  tv_network_id uuid,
  tv_creative_id uuid,
  tv_campaign_id uuid,
  is_tv_call boolean default false,
  caller_id text,
  connected boolean,
  billable boolean,
  destination_name text
);

create table if not exists public.callgrid_daily_totals (
  id uuid default gen_random_uuid() not null,
  date date not null,
  callgrid_campaign_name text not null,
  client_campaign_id uuid,
  total_calls integer default 0 not null,
  billable_calls integer default 0 not null,
  updated_at timestamp with time zone default now()
);

create table if not exists public.callgrid_daily_totals_pub (
  id uuid default gen_random_uuid() not null,
  date date not null,
  callgrid_publisher_name text not null,
  publisher_campaign_id uuid,
  total_calls integer default 0 not null,
  billable_calls integer default 0 not null,
  updated_at timestamp with time zone default now()
);

create table if not exists public.campaign_links (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  client_campaign_id uuid,
  publisher_campaign_id uuid
);

create table if not exists public.client_campaign_rates (
  id uuid default gen_random_uuid() not null,
  client_campaign_id uuid,
  rate numeric(10,4) not null,
  effective_from timestamp with time zone not null,
  effective_to timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.client_campaigns (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  client_id uuid,
  name text not null,
  vertical text,
  price_per_call numeric(10,2),
  billing_frequency text default 'monthly'::text,
  net_terms integer default 30,
  volume_periods text default '[]'::text,
  active boolean default true,
  start_date date,
  lead_type text,
  duration_seconds text,
  callgrid_campaign_name text,
  billing_type text default 'net_terms'::text,
  callgrid_target_name text,
  default_description text,
  daily_call_target numeric
);

create table if not exists public.client_report_entries (
  id uuid default gen_random_uuid() not null,
  scope_key text not null,
  kind text not null,
  date date,
  amount numeric default 0 not null,
  note text,
  updated_by text,
  updated_at timestamp with time zone default now()
);

create table if not exists public.clients (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  name text not null,
  contact_name text,
  contact_email text,
  billing_contact text,
  billing_email text,
  biz_dev text,
  account_manager text,
  notes text,
  address_line1 text,
  city text,
  state text,
  zip text,
  combine_invoices boolean default false,
  default_billing_type text default 'net_terms'::text,
  default_net_terms integer default 30,
  default_billing_frequency text default 'monthly'::text,
  callgrid_buyer_name text,
  hubspot_status text,
  active boolean default true not null
);

create table if not exists public.consumers (
  id uuid default gen_random_uuid() not null,
  created_by uuid default auth.uid() not null,
  agent_id uuid,
  vertical text default 'final_expense'::text not null,
  first_name text,
  last_name text,
  phone text,
  email text,
  state text,
  dob date,
  gender text,
  tobacco boolean,
  height_in integer,
  weight_lb integer,
  coverage_desired numeric,
  beneficiary_name text,
  beneficiary_relation text,
  qualification jsonb default '{}'::jsonb,
  disposition text default 'in_progress'::text not null,
  callback_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  lead_source text,
  consent_follow_up boolean,
  closed_out boolean default false not null,
  closed_at timestamp with time zone
);

create table if not exists public.creative_entries (
  id text not null,
  kind text not null,
  data jsonb not null,
  author text not null,
  created_at timestamp with time zone not null
);

create table if not exists public.creative_review_notes (
  id text not null,
  version_id text not null,
  parent_id text,
  seconds double precision not null,
  body text not null,
  author_id text not null,
  author text not null,
  resolved boolean default false not null,
  resolved_by text,
  revision integer default 1 not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);

create table if not exists public.creative_review_versions (
  id text not null,
  test_id text not null,
  label text not null,
  file_name text not null,
  mime text not null,
  size integer not null,
  storage_key text not null,
  author_id text not null,
  author text not null,
  created_at timestamp with time zone not null
);

create table if not exists public.crm_contacts (
  id uuid default gen_random_uuid() not null,
  entity_type text not null,
  entity_id uuid not null,
  name text not null,
  title text,
  email text,
  phone text,
  is_primary boolean default false,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.crm_deals (
  id uuid default gen_random_uuid() not null,
  name text not null,
  company text,
  stage text default 'lead'::text not null,
  value numeric,
  expected_close date,
  owner text,
  source text,
  converted_client_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.crm_notes (
  id uuid default gen_random_uuid() not null,
  entity_type text not null,
  entity_id uuid not null,
  body text not null,
  author text,
  created_at timestamp with time zone default now()
);

create table if not exists public.crm_tasks (
  id uuid default gen_random_uuid() not null,
  title text not null,
  details text,
  entity_type text,
  entity_id uuid,
  due_date date,
  assigned_to text,
  status text default 'open'::text not null,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create table if not exists public.dispo_leads (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  phone text not null,
  first_call_date date,
  first_call_time text,
  first_call_hour integer,
  state text,
  queue text,
  sold boolean default false not null,
  trashed boolean default false not null,
  dead_air boolean default false not null,
  refused boolean default false not null,
  last_result text,
  publisher_name text,
  campaign_name text,
  billed numeric default 0 not null,
  first_upload_id uuid,
  last_upload_id uuid,
  updated_at timestamp with time zone default now() not null,
  sales integer default 0 not null
);

create table if not exists public.dispo_uploads (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  filename text,
  period_start date,
  period_end date,
  rows_in_file integer default 0 not null,
  leads_in_file integer default 0 not null,
  leads_new integer default 0 not null,
  leads_updated integer default 0 not null,
  matched_pct numeric,
  uploaded_by uuid,
  uploaded_at timestamp with time zone default now() not null
);

create table if not exists public.dnc_list (
  id uuid default gen_random_uuid() not null,
  phone text not null,
  phone_digits text not null,
  name text,
  reason text default 'manual'::text not null,
  added_by text,
  created_at timestamp with time zone default now()
);

create table if not exists public.hr_announcements (
  id uuid default gen_random_uuid() not null,
  title text not null,
  body text,
  author_email text,
  pinned boolean default false not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.hr_documents (
  id uuid default gen_random_uuid() not null,
  title text not null,
  url text not null,
  category text,
  sort_order integer default 0,
  active boolean default true not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.hr_holidays (
  id uuid default gen_random_uuid() not null,
  date date not null,
  name text not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.hr_time_off (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  requester_email text,
  kind text default 'pto'::text not null,
  start_date date not null,
  end_date date not null,
  days numeric,
  notes text,
  status text default 'pending'::text not null,
  decided_by text,
  decided_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create table if not exists public.integration_links (
  id uuid default gen_random_uuid() not null,
  entity_type text not null,
  local_id uuid not null,
  system text not null,
  external_id text not null,
  external_label text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.integration_log (
  id uuid default gen_random_uuid() not null,
  system text not null,
  direction text,
  event text not null,
  entity_type text,
  entity_id text,
  status text not null,
  detail text,
  resolved boolean default false not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.integration_secrets (
  key text not null,
  value text not null,
  updated_at timestamp with time zone default now()
);

create table if not exists public.integration_systems (
  id text not null,
  label text not null,
  enabled boolean default false not null,
  last_ok_at timestamp with time zone,
  last_error_at timestamp with time zone,
  last_error text
);

create table if not exists public.invoice_line_items (
  id uuid default gen_random_uuid() not null,
  ledger text not null,
  invoice_id uuid not null,
  item text,
  description text,
  quantity numeric,
  rate numeric,
  amount numeric default 0 not null,
  sort_order integer default 0,
  created_at timestamp with time zone default now()
);

create table if not exists public.io_requests (
  request_id text not null,
  request_name text not null,
  company text,
  side text,
  campaign_base text,
  parsed jsonb,
  fields jsonb,
  campaigns_created jsonb,
  status text default 'new'::text not null,
  error text,
  completed_at timestamp with time zone,
  processed_at timestamp with time zone default now()
);

create table if not exists public.media_plans (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  name text,
  note text,
  flight_start date not null,
  flight_end date not null,
  status text default 'Draft'::text,
  created_at timestamp with time zone default now()
);

create table if not exists public.mercury_transactions (
  id text not null,
  account_id text,
  account_name text,
  amount numeric not null,
  counterparty text,
  description text,
  status text,
  kind text,
  posted_at timestamp with time zone,
  matched_ar_id uuid,
  matched_ap_id uuid,
  match_status text default 'unmatched'::text not null,
  raw jsonb,
  synced_at timestamp with time zone default now()
);

create table if not exists public.notification_preferences (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  email text not null,
  name text,
  alert_overdue_invoices boolean default true,
  alert_volume_drop boolean default true,
  volume_drop_threshold integer default 50,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  alert_buyer_accept boolean default true not null,
  alert_publisher_pace boolean default true not null,
  alert_rpc_drop boolean default true not null,
  alert_low_billable boolean default true not null,
  daily_brief boolean default true not null,
  alert_launch boolean default true not null
);

create table if not exists public.onboarding_checklist_items (
  id uuid default gen_random_uuid() not null,
  checklist_id uuid,
  section text,
  task text not null,
  checked boolean default false,
  status text default 'Not Started'::text,
  owner text,
  due_date date,
  notes text,
  sort_order integer,
  created_at timestamp with time zone default now()
);

create table if not exists public.onboarding_checklists (
  id uuid default gen_random_uuid() not null,
  type text not null,
  record_id uuid not null,
  record_name text,
  category text,
  date_started date,
  internal_owner text,
  client_contact_name text,
  internal_account_manager text,
  internal_biz_dev text,
  responsible_signer text,
  client_address text,
  billing_contact text,
  campaign_flight_name text,
  traffic_source text,
  budget text,
  pricing_info text,
  flight_dates text,
  states text,
  hours text,
  net_terms text,
  age_targets text,
  did_number text,
  call_type text,
  billable_duration text,
  daily_cap text,
  hourly_cap text,
  concurrent_cap text,
  call_criteria text,
  restrictions text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.ping_bid_hourly (
  date date not null,
  hour integer not null,
  destination_id text not null,
  destination_name text,
  buyer_name text,
  pings integer default 0 not null,
  accepted integer default 0 not null,
  bids integer default 0 not null,
  bid_amount_sum numeric default 0 not null,
  bid_duration_sum numeric default 0 not null,
  won_bids integer default 0 not null,
  won_calls integer default 0 not null,
  timeouts integer default 0 not null,
  ping_ms_sum numeric default 0 not null,
  ping_ms_bid_sum numeric default 0 not null,
  timeout_bids integer default 0 not null,
  timeout_bid_amount_sum numeric default 0 not null,
  timeout_bid_ping_ms_sum numeric default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.ping_bids (
  id text not null,
  bid_id text,
  ts timestamp with time zone not null,
  date date not null,
  hour integer not null,
  destination_id text,
  destination_name text,
  buyer_name text,
  campaign_name text,
  source_name text,
  vendor_name text,
  state_code text,
  caller_id text,
  bid_amount numeric,
  bid_duration integer,
  revenue_amount numeric,
  ping_ms integer,
  ping_code integer,
  accepted boolean default false not null,
  won_bid boolean default false not null,
  won_call boolean default false not null,
  ping_timeout boolean default false not null,
  url text,
  raw jsonb default '{}'::jsonb not null,
  synced_at timestamp with time zone default now() not null
);

create table if not exists public.ping_daily_stats (
  id uuid default gen_random_uuid() not null,
  date date not null,
  destination_id text not null,
  destination_name text,
  total_pings integer default 0 not null,
  accepted integer default 0 not null,
  failed_acceptance integer default 0 not null,
  failed_tag_rules integer default 0 not null,
  min_revenue integer default 0 not null,
  missing_amount integer default 0 not null,
  invalid_number integer default 0 not null,
  duration_elapsed integer default 0 not null,
  ping_timeout integer default 0 not null,
  api_failed integer default 0 not null,
  rate_limited integer default 0 not null,
  suppressed integer default 0 not null,
  agents integer default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.ping_sync_state (
  key text not null,
  value jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists public.pub_actuals (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  date date not null,
  publisher_campaign_id uuid,
  publisher_name text,
  paid_calls integer default 0,
  pub_cost numeric(12,2) default 0,
  source text default 'manual'::text,
  publisher_id uuid,
  client_campaign_id uuid,
  callgrid_id text
);

create table if not exists public.publisher_campaign_rates (
  id uuid default gen_random_uuid() not null,
  publisher_campaign_id uuid,
  rate numeric(10,4) not null,
  effective_from timestamp with time zone not null,
  effective_to timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.publisher_campaigns (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  publisher_id uuid,
  name text not null,
  vertical text,
  cost_per_call numeric(10,2),
  billing_frequency text default 'weekly'::text,
  net_terms integer default 14,
  active boolean default true,
  start_date date,
  lead_type text,
  duration_seconds text,
  callgrid_publisher_name text,
  billing_type text default 'net_terms'::text,
  daily_call_target numeric
);

create table if not exists public.publishers (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  name text not null,
  contact_name text,
  contact_email text,
  billing_contact text,
  billing_email text,
  account_manager text,
  notes text,
  is_internal boolean default false
);

create table if not exists public.quote_carriers (
  id uuid default gen_random_uuid() not null,
  name text not null,
  vertical text default 'final_expense'::text not null,
  am_best_rating text,
  phone text,
  notes text,
  active boolean default true not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.quote_products (
  id uuid default gen_random_uuid() not null,
  carrier_id uuid not null,
  name text not null,
  vertical text default 'final_expense'::text not null,
  tier text,
  min_age integer,
  max_age integer,
  min_coverage numeric,
  max_coverage numeric,
  policy_fee numeric default 0,
  states text,
  notes text,
  active boolean default true not null,
  created_at timestamp with time zone default now()
);

create table if not exists public.quote_rates (
  id uuid default gen_random_uuid() not null,
  product_id uuid not null,
  gender text not null,
  tobacco boolean default false not null,
  age integer not null,
  rate_per_thousand numeric not null
);

create table if not exists public.roku_auth (
  id integer default 1 not null,
  client_id text,
  client_secret text,
  refresh_token text,
  access_token text,
  access_token_expires_at timestamp with time zone,
  account_uid text,
  last_sync_at timestamp with time zone,
  last_sync_error text,
  updated_at timestamp with time zone default now()
);

create table if not exists public.tv_airings (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  tv_buy_line_id uuid,
  creative_id uuid,
  tfn text,
  isci text,
  air_date date,
  air_time time without time zone,
  length_seconds integer,
  rate numeric(10,2),
  status text default 'expected'::text,
  calls_manual integer,
  revenue_manual numeric(10,2),
  call_source text default 'callgrid'::text,
  notes text,
  created_at timestamp with time zone default now(),
  scheduled_time text,
  spot_number integer,
  calls integer,
  daypart text,
  gross_rate numeric,
  net_rate numeric
);

create table if not exists public.tv_ap_ledger (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  period_start date,
  period_end date,
  gross_aired numeric(10,2),
  net_billed numeric(10,2),
  amount_paid numeric(10,2),
  due_date date,
  date_paid date,
  status text default 'Expected'::text,
  billing_type text default 'net30'::text,
  notes text,
  source text default 'manual'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.tv_ar_ledger (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  client_id uuid,
  client_campaign_id uuid,
  period_start date,
  period_end date,
  type text not null,
  calls integer,
  revenue_per_call numeric(10,4),
  gross_spend numeric(10,2),
  markup_pct numeric(5,2),
  amount_billed numeric(10,2),
  amount_received numeric(10,2),
  due_date date,
  date_sent date,
  date_received date,
  status text default 'Draft'::text,
  notes text,
  source text default 'manual'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.tv_bookings (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  week_start date not null,
  daypart text,
  spots_booked integer default 0,
  spots_cleared integer default 0,
  gross_booked numeric(10,2) default 0,
  gross_aired numeric(10,2) default 0,
  net_aired numeric(10,2) generated always as ((gross_aired * 0.85)) stored,
  creative_id uuid,
  notes text,
  created_at timestamp with time zone default now(),
  tv_buy_line_id uuid,
  source text default 'manual'::text,
  impressions_actual integer
);

create table if not exists public.tv_buy_lines (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  creative_id uuid,
  station_code text,
  break_type text default 'National'::text,
  spot_name text,
  isci text,
  length_seconds integer,
  daypart text,
  days_of_week text default 'MTWThF'::text,
  rate numeric(10,2) default 0,
  spots_ordered integer default 0,
  gross_spend numeric(10,2) generated always as ((rate * (spots_ordered)::numeric)) stored,
  flight_start date,
  flight_end date,
  tfn text,
  allocation_pct numeric(5,2) default 100,
  status text default 'Draft'::text,
  notes text,
  created_at timestamp with time zone default now(),
  ctv_platform text,
  ctv_cpm numeric(10,4),
  ctv_budget numeric(10,2),
  ctv_impressions_estimated integer,
  ctv_impressions_actual integer,
  ctv_audience_segment text,
  ctv_device_targeting text default 'all'::text,
  calls_per_spot numeric,
  clearance_pct numeric,
  media_plan_id uuid,
  source_plan_line_id uuid,
  plan_stage text default 'book'::text
);

create table if not exists public.tv_campaign_clients (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  client_id uuid,
  client_campaign_id uuid,
  callgrid_target_name text,
  created_at timestamp with time zone default now()
);

create table if not exists public.tv_campaign_networks (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  billing_type text default 'net30'::text,
  net_terms integer default 30,
  created_at timestamp with time zone default now()
);

create table if not exists public.tv_campaigns (
  id uuid default gen_random_uuid() not null,
  name text not null,
  type text not null,
  status text default 'active'::text,
  start_date date,
  billing_frequency text default 'monthly'::text,
  net_terms integer default 30,
  billing_mode text default 'separate'::text,
  markup_pct numeric(5,2),
  notes text,
  created_at timestamp with time zone default now(),
  company_name text default 'Email Agency'::text,
  advertiser text,
  product text,
  quarter text,
  hiatus_dates text,
  vendor text default 'OTSM'::text,
  media_type text default 'linear'::text,
  rev_per_call numeric,
  default_clearance_pct numeric,
  client_plan_details jsonb
);

create table if not exists public.tv_creative_numbers (
  id uuid default gen_random_uuid() not null,
  creative_id uuid not null,
  phone_number_id uuid not null,
  isci text,
  hd boolean default true,
  active boolean default true,
  created_at timestamp with time zone default now(),
  valid_from date,
  valid_to date
);

create table if not exists public.tv_creatives (
  id uuid default gen_random_uuid() not null,
  name text not null,
  length_seconds integer,
  vertical text,
  description text,
  status text default 'active'::text,
  created_at timestamp with time zone default now(),
  spot_indicator text,
  tv_campaign_id uuid
);

create table if not exists public.tv_ios (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  network_id uuid,
  io_number text,
  generated_at timestamp with time zone default now(),
  total_gross numeric(10,2),
  status text default 'Sent'::text,
  notes text
);

create table if not exists public.tv_line_creatives (
  id uuid default gen_random_uuid() not null,
  tv_buy_line_id uuid,
  creative_id uuid,
  tfn text,
  allocation_pct numeric(5,2) default 100,
  created_at timestamp with time zone default now(),
  isci text
);

create table if not exists public.tv_networks (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  name text not null,
  pay_terms integer,
  invoice_cadence text,
  notes text,
  station_code text,
  internal_rep text,
  contact_name text,
  contact_email text,
  contact_phone text
);

create table if not exists public.tv_number_assignments (
  id uuid default gen_random_uuid() not null,
  phone_number_id uuid,
  network_id uuid,
  tv_campaign_id uuid,
  creative_id uuid,
  valid_from date not null,
  valid_to date,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.tv_phone_numbers (
  id uuid default gen_random_uuid() not null,
  number text not null,
  description text,
  created_at timestamp with time zone default now()
);

create table if not exists public.tv_spot_log (
  id uuid default gen_random_uuid() not null,
  tv_campaign_id uuid,
  tv_buy_line_id uuid,
  network_id uuid,
  station_code text,
  isci text,
  spot_name text,
  length_seconds integer,
  daypart text,
  scheduled_time text,
  actual_time text,
  flight_date date,
  rate numeric(10,2),
  tfn text,
  status text default 'Booked'::text,
  calls integer,
  notes text,
  sort_order integer,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.user_profiles (
  id uuid default gen_random_uuid() not null,
  created_at timestamp with time zone default now(),
  user_id uuid,
  email text,
  role text default 'staff'::text
);

create table if not exists public.hubspot_companies (
  external_id text not null,
  id text generated always as (external_id) stored,
  name text not null,
  account_status text,
  partner_type text,
  payment_terms text,
  publisher_payment_terms text,
  payment_method text,
  msa_status text,
  msa_signed_date text,
  buyer_msa_signed_date text,
  pub_msa_signed_date text,
  onboarding_status text,
  tax_form_status text,
  primary_contact_name text,
  primary_contact_email text,
  primary_contact_phone text,
  billing_contact_name text,
  billing_contact_email text,
  billing_contact_phone text,
  operations_contact_name text,
  operations_contact_email text,
  operations_contact_phone text,
  address_line1 text,
  city text,
  state text,
  zip text,
  phone text,
  website text,
  dba text,
  call_types text,
  traffic_type text,
  created_time timestamp with time zone,
  modified_time timestamp with time zone,
  record_url text,
  raw jsonb,
  synced_at timestamp with time zone default now()
);

create table if not exists public.hubspot_contacts (
  external_id text not null,
  account_external_id text,
  first_name text,
  last_name text,
  full_name text,
  email text,
  phone text,
  mobile text,
  title text,
  department text,
  raw jsonb,
  modified_time timestamp with time zone,
  synced_at timestamp with time zone default now()
);

-- FUNCTIONS

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into public.user_profiles (user_id, email, role, created_at)
  values (new.id, new.email, 'staff', now())
  on conflict (user_id) do nothing;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE user_id = auth.uid() AND role = 'admin');
$function$
;

CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_profiles
                 WHERE user_id = auth.uid()
                   AND role IN ('admin','staff','operations','finance','sales'));
$function$
;

CREATE OR REPLACE FUNCTION public.my_agent_wallet()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE a record; dep numeric; used numeric; ncalls bigint;
BEGIN
  SELECT * INTO a FROM public.agents WHERE user_id = auth.uid() LIMIT 1;
  IF a IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount),0) INTO dep FROM public.agent_transactions WHERE agent_id = a.id;
  SELECT COALESCE(SUM(c.revenue),0), COUNT(*) INTO used, ncalls
  FROM public.callgrid_calls c
  WHERE c.revenue > 0
    AND (a.start_date IS NULL OR c.date >= a.start_date)
    AND lower(trim(c.target_name)) = ANY (
      SELECT lower(trim(x)) FROM unnest(string_to_array(COALESCE(a.callgrid_buyer_name, a.name), ',')) x
    );
  RETURN json_build_object('agent_id', a.id, 'agent_name', a.name,
    'deposits', dep, 'used', used, 'calls', ncalls, 'balance', dep - used,
    'threshold', a.low_balance_threshold);
END; $function$
;

CREATE OR REPLACE FUNCTION public.rebuild_callgrid_actuals()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Delete existing callgrid actuals
  DELETE FROM actuals WHERE source = 'callgrid';

  -- Rebuild from callgrid_calls
  INSERT INTO actuals (date, client, client_id, campaign, client_campaign_id, calls, revenue, source, callgrid_id)
  SELECT
    r.date,
    cl.name as client,
    cc.client_id,
    COALESCE(cc.name, r.campaign_name) as campaign,
    r.client_campaign_id,
    COUNT(*) as calls,
    SUM(r.revenue) as revenue,
    'callgrid' as source,
    r.date || '__' || COALESCE(r.client_campaign_id::text, r.campaign_name) as callgrid_id
  FROM callgrid_calls r
  LEFT JOIN client_campaigns cc ON cc.id = r.client_campaign_id
  LEFT JOIN clients cl ON cl.id = cc.client_id
  WHERE r.revenue > 0
  GROUP BY r.date, r.client_campaign_id, r.campaign_name, cc.name, cc.client_id, cl.name;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

-- CONSTRAINTS

alter table public.account_onboarding add constraint account_onboarding_pkey PRIMARY KEY (hubspot_company_id);
alter table public.actuals add constraint actuals_pkey PRIMARY KEY (id);
alter table public.agent_adjustments add constraint agent_adjustments_pkey PRIMARY KEY (id);
alter table public.agent_licenses add constraint agent_licenses_pkey PRIMARY KEY (id);
alter table public.agent_policies add constraint agent_policies_pkey PRIMARY KEY (id);
alter table public.agent_scripts add constraint agent_scripts_pkey PRIMARY KEY (id);
alter table public.agent_transactions add constraint agent_transactions_pkey PRIMARY KEY (id);
alter table public.agents add constraint agents_pkey PRIMARY KEY (id);
alter table public.alert_log add constraint alert_log_pkey PRIMARY KEY (id);
alter table public.alert_rules add constraint alert_rules_pkey PRIMARY KEY (id);
alter table public.alerts add constraint alerts_pkey PRIMARY KEY (id);
alter table public.ap_ledger add constraint ap_ledger_pkey PRIMARY KEY (id);
alter table public.ar_ledger add constraint ar_ledger_pkey PRIMARY KEY (id);
alter table public.bid_daily_stats add constraint bid_daily_stats_pkey PRIMARY KEY (id);
alter table public.call_analysis add constraint call_analysis_pkey PRIMARY KEY (inbound_call_id);
alter table public.callgrid_calls add constraint ringba_calls_pkey PRIMARY KEY (id);
alter table public.callgrid_daily_totals add constraint ringba_daily_totals_pkey PRIMARY KEY (id);
alter table public.callgrid_daily_totals_pub add constraint ringba_daily_totals_pub_pkey PRIMARY KEY (id);
alter table public.campaign_links add constraint campaign_links_pkey PRIMARY KEY (id);
alter table public.client_campaign_rates add constraint client_campaign_rates_pkey PRIMARY KEY (id);
alter table public.client_campaigns add constraint client_campaigns_pkey PRIMARY KEY (id);
alter table public.client_report_entries add constraint client_report_entries_pkey PRIMARY KEY (id);
alter table public.clients add constraint clients_pkey PRIMARY KEY (id);
alter table public.consumers add constraint consumers_pkey PRIMARY KEY (id);
alter table public.creative_entries add constraint creative_entries_pkey PRIMARY KEY (id);
alter table public.creative_review_notes add constraint creative_review_notes_pkey PRIMARY KEY (id);
alter table public.creative_review_versions add constraint creative_review_versions_pkey PRIMARY KEY (id);
alter table public.crm_contacts add constraint crm_contacts_pkey PRIMARY KEY (id);
alter table public.crm_deals add constraint crm_deals_pkey PRIMARY KEY (id);
alter table public.crm_notes add constraint crm_notes_pkey PRIMARY KEY (id);
alter table public.crm_tasks add constraint crm_tasks_pkey PRIMARY KEY (id);
alter table public.dispo_leads add constraint dispo_leads_pkey PRIMARY KEY (id);
alter table public.dispo_uploads add constraint dispo_uploads_pkey PRIMARY KEY (id);
alter table public.dnc_list add constraint dnc_list_pkey PRIMARY KEY (id);
alter table public.hr_announcements add constraint hr_announcements_pkey PRIMARY KEY (id);
alter table public.hr_documents add constraint hr_documents_pkey PRIMARY KEY (id);
alter table public.hr_holidays add constraint hr_holidays_pkey PRIMARY KEY (id);
alter table public.hr_time_off add constraint hr_time_off_pkey PRIMARY KEY (id);
alter table public.integration_links add constraint integration_links_pkey PRIMARY KEY (id);
alter table public.integration_log add constraint integration_log_pkey PRIMARY KEY (id);
alter table public.integration_secrets add constraint integration_secrets_pkey PRIMARY KEY (key);
alter table public.integration_systems add constraint integration_systems_pkey PRIMARY KEY (id);
alter table public.invoice_line_items add constraint invoice_line_items_pkey PRIMARY KEY (id);
alter table public.io_requests add constraint io_requests_pkey PRIMARY KEY (request_id);
alter table public.media_plans add constraint media_plans_pkey PRIMARY KEY (id);
alter table public.mercury_transactions add constraint mercury_transactions_pkey PRIMARY KEY (id);
alter table public.notification_preferences add constraint notification_preferences_pkey PRIMARY KEY (id);
alter table public.onboarding_checklist_items add constraint onboarding_checklist_items_pkey PRIMARY KEY (id);
alter table public.onboarding_checklists add constraint onboarding_checklists_pkey PRIMARY KEY (id);
alter table public.ping_bid_hourly add constraint ping_bid_hourly_pkey PRIMARY KEY (date, hour, destination_id);
alter table public.ping_bids add constraint ping_bids_pkey PRIMARY KEY (id);
alter table public.ping_daily_stats add constraint ping_daily_stats_pkey PRIMARY KEY (id);
alter table public.ping_sync_state add constraint ping_sync_state_pkey PRIMARY KEY (key);
alter table public.pub_actuals add constraint pub_actuals_pkey PRIMARY KEY (id);
alter table public.publisher_campaign_rates add constraint publisher_campaign_rates_pkey PRIMARY KEY (id);
alter table public.publisher_campaigns add constraint publisher_campaigns_pkey PRIMARY KEY (id);
alter table public.publishers add constraint publishers_pkey PRIMARY KEY (id);
alter table public.quote_carriers add constraint quote_carriers_pkey PRIMARY KEY (id);
alter table public.quote_products add constraint quote_products_pkey PRIMARY KEY (id);
alter table public.quote_rates add constraint quote_rates_pkey PRIMARY KEY (id);
alter table public.roku_auth add constraint roku_auth_pkey PRIMARY KEY (id);
alter table public.tv_airings add constraint tv_airings_pkey PRIMARY KEY (id);
alter table public.tv_ap_ledger add constraint tv_ap_ledger_pkey PRIMARY KEY (id);
alter table public.tv_ar_ledger add constraint tv_ar_ledger_pkey PRIMARY KEY (id);
alter table public.tv_bookings add constraint tv_bookings_pkey PRIMARY KEY (id);
alter table public.tv_buy_lines add constraint tv_buy_lines_pkey PRIMARY KEY (id);
alter table public.tv_campaign_clients add constraint tv_campaign_clients_pkey PRIMARY KEY (id);
alter table public.tv_campaign_networks add constraint tv_campaign_networks_pkey PRIMARY KEY (id);
alter table public.tv_campaigns add constraint tv_campaigns_pkey PRIMARY KEY (id);
alter table public.tv_creative_numbers add constraint tv_creative_numbers_pkey PRIMARY KEY (id);
alter table public.tv_creatives add constraint tv_creatives_pkey PRIMARY KEY (id);
alter table public.tv_ios add constraint tv_ios_pkey PRIMARY KEY (id);
alter table public.tv_line_creatives add constraint tv_line_creatives_pkey PRIMARY KEY (id);
alter table public.tv_networks add constraint tv_networks_pkey PRIMARY KEY (id);
alter table public.tv_number_assignments add constraint tv_number_assignments_pkey PRIMARY KEY (id);
alter table public.tv_phone_numbers add constraint tv_phone_numbers_pkey PRIMARY KEY (id);
alter table public.tv_spot_log add constraint tv_spot_log_pkey PRIMARY KEY (id);
alter table public.user_profiles add constraint user_profiles_pkey PRIMARY KEY (id);
alter table public.hubspot_companies add constraint hubspot_companies_pkey PRIMARY KEY (external_id);
alter table public.hubspot_contacts add constraint hubspot_contacts_pkey PRIMARY KEY (external_id);
alter table public.actuals add constraint actuals_callgrid_id_key UNIQUE (callgrid_id);
alter table public.agents add constraint agents_user_id_key UNIQUE (user_id);
alter table public.bid_daily_stats add constraint bid_daily_stats_date_source_id_key UNIQUE (date, source_id);
alter table public.callgrid_calls add constraint callgrid_calls_inbound_call_id_key UNIQUE (inbound_call_id);
alter table public.callgrid_calls add constraint ringba_calls_inbound_call_id_key UNIQUE (inbound_call_id);
alter table public.callgrid_daily_totals add constraint callgrid_daily_totals_date_camp_cc_key UNIQUE NULLS NOT DISTINCT (date, callgrid_campaign_name, client_campaign_id);
alter table public.callgrid_daily_totals_pub add constraint ringba_daily_totals_pub_date_ringba_publisher_name_key UNIQUE (date, callgrid_publisher_name);
alter table public.campaign_links add constraint campaign_links_client_campaign_id_publisher_campaign_id_key UNIQUE (client_campaign_id, publisher_campaign_id);
alter table public.dispo_leads add constraint dispo_leads_client_id_phone_key UNIQUE (client_id, phone);
alter table public.dnc_list add constraint dnc_list_phone_digits_key UNIQUE (phone_digits);
alter table public.integration_links add constraint integration_links_entity_type_local_id_system_key UNIQUE (entity_type, local_id, system);
alter table public.integration_links add constraint integration_links_system_entity_type_external_id_key UNIQUE (system, entity_type, external_id);
alter table public.ping_daily_stats add constraint ping_daily_stats_date_destination_id_key UNIQUE (date, destination_id);
alter table public.pub_actuals add constraint pub_actuals_callgrid_id_key UNIQUE (callgrid_id);
alter table public.quote_rates add constraint quote_rates_product_id_gender_tobacco_age_key UNIQUE (product_id, gender, tobacco, age);
alter table public.user_profiles add constraint user_profiles_user_id_key UNIQUE (user_id);
alter table public.account_onboarding add constraint account_onboarding_manual_status_check CHECK ((manual_status = ANY (ARRAY['On Hold'::text, 'In Progress'::text, 'Needs CallGrid Setup'::text, 'Set Up Done'::text])));
alter table public.agent_adjustments add constraint agent_adjustments_kind_check CHECK ((kind = ANY (ARRAY['bonus'::text, 'advance'::text, 'chargeback'::text, 'other'::text])));
alter table public.agent_policies add constraint agent_policies_carrier_status_check CHECK ((carrier_status = ANY (ARRAY['pending'::text, 'active'::text, 'lapsed'::text, 'cancelled'::text, 'chargeback'::text])));
alter table public.agent_policies add constraint agent_policies_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'partial'::text, 'chargeback'::text])));
alter table public.alert_rules add constraint alert_rules_metric_check CHECK ((metric = ANY (ARRAY['buyer_accept_rate'::text, 'publisher_pace'::text, 'rpc_drop'::text, 'low_billable_pct'::text, 'volume_drop'::text, 'overdue_invoices'::text, 'launch_no_calls'::text])));
alter table public.alert_rules add constraint alert_rules_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])));
alter table public.alerts add constraint alerts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acked'::text, 'ignored'::text])));
alter table public.client_campaigns add constraint client_campaigns_billing_frequency_check CHECK (((billing_frequency IS NULL) OR (billing_frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'bi-weekly'::text, 'biweekly'::text, 'bimonthly'::text, 'monthly'::text]))));
alter table public.client_campaigns add constraint client_campaigns_billing_type_check CHECK ((billing_type = ANY (ARRAY['net_terms'::text, 'prepay'::text])));
alter table public.client_report_entries add constraint client_report_entries_kind_check CHECK ((kind = ANY (ARRAY['misc'::text, 'received'::text, 'opening'::text])));
alter table public.consumers add constraint consumers_disposition_check CHECK ((disposition = ANY (ARRAY['in_progress'::text, 'sold'::text, 'callback'::text, 'not_interested'::text, 'unqualified'::text, 'no_answer'::text])));
alter table public.consumers add constraint consumers_gender_check CHECK ((gender = ANY (ARRAY['M'::text, 'F'::text])));
alter table public.consumers add constraint consumers_vertical_check CHECK ((vertical = ANY (ARRAY['final_expense'::text, 'medicare'::text])));
alter table public.creative_entries add constraint creative_entries_kind_check CHECK ((kind = ANY (ARRAY['brief'::text, 'test'::text, 'result'::text, 'learning'::text, 'research'::text])));
alter table public.crm_contacts add constraint crm_contacts_entity_type_check CHECK ((entity_type = ANY (ARRAY['client'::text, 'publisher'::text, 'agent'::text, 'deal'::text])));
alter table public.crm_deals add constraint crm_deals_stage_check CHECK ((stage = ANY (ARRAY['lead'::text, 'contacted'::text, 'qualified'::text, 'proposal'::text, 'won'::text, 'lost'::text])));
alter table public.crm_notes add constraint crm_notes_entity_type_check CHECK ((entity_type = ANY (ARRAY['client'::text, 'publisher'::text, 'agent'::text, 'deal'::text])));
alter table public.crm_tasks add constraint crm_tasks_entity_type_check CHECK ((entity_type = ANY (ARRAY['client'::text, 'publisher'::text, 'agent'::text, 'deal'::text])));
alter table public.crm_tasks add constraint crm_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])));
alter table public.hr_time_off add constraint hr_time_off_kind_check CHECK ((kind = ANY (ARRAY['pto'::text, 'sick'::text, 'unpaid'::text, 'other'::text])));
alter table public.hr_time_off add constraint hr_time_off_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'cancelled'::text])));
alter table public.integration_links add constraint integration_links_entity_type_check CHECK ((entity_type = ANY (ARRAY['client'::text, 'campaign'::text, 'publisher'::text, 'agent'::text, 'invoice'::text, 'contact'::text])));
alter table public.integration_log add constraint integration_log_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'internal'::text])));
alter table public.integration_log add constraint integration_log_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text])));
alter table public.invoice_line_items add constraint invoice_line_items_ledger_check CHECK ((ledger = ANY (ARRAY['ar'::text, 'ap'::text])));
alter table public.mercury_transactions add constraint mercury_transactions_match_status_check CHECK ((match_status = ANY (ARRAY['unmatched'::text, 'suggested'::text, 'confirmed'::text, 'ignored'::text])));
alter table public.publisher_campaigns add constraint publisher_campaigns_billing_frequency_check CHECK (((billing_frequency IS NULL) OR (billing_frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'bi-weekly'::text, 'biweekly'::text, 'bimonthly'::text, 'monthly'::text]))));
alter table public.publisher_campaigns add constraint publisher_campaigns_billing_type_check CHECK ((billing_type = ANY (ARRAY['net_terms'::text, 'prepay'::text])));
alter table public.quote_carriers add constraint quote_carriers_vertical_check CHECK ((vertical = ANY (ARRAY['final_expense'::text, 'medicare'::text])));
alter table public.quote_products add constraint quote_products_tier_check CHECK ((tier = ANY (ARRAY['level'::text, 'graded'::text, 'modified'::text, 'guaranteed'::text])));
alter table public.quote_products add constraint quote_products_vertical_check CHECK ((vertical = ANY (ARRAY['final_expense'::text, 'medicare'::text])));
alter table public.quote_rates add constraint quote_rates_gender_check CHECK ((gender = ANY (ARRAY['M'::text, 'F'::text])));
alter table public.roku_auth add constraint roku_auth_singleton CHECK ((id = 1));
alter table public.tv_airings add constraint tv_airings_call_source_check CHECK ((call_source = ANY (ARRAY['callgrid'::text, 'manual'::text])));
alter table public.tv_airings add constraint tv_airings_status_check CHECK (((status IS NULL) OR (status = ANY (ARRAY['Booked'::text, 'Pre-Log'::text, 'Ran'::text, 'Post-Log'::text, 'Invoiced'::text]))));
alter table public.tv_campaigns add constraint tv_campaigns_type_check CHECK ((type = ANY (ARRAY['performance'::text, 'cashbuy'::text])));
alter table public.user_profiles add constraint user_profiles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'staff'::text, 'agent'::text, 'operations'::text, 'finance'::text, 'sales'::text])));

-- FOREIGN KEYS

alter table public.actuals add constraint actuals_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.actuals add constraint actuals_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.agent_adjustments add constraint agent_adjustments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
alter table public.agent_adjustments add constraint agent_adjustments_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.agent_licenses add constraint agent_licenses_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
alter table public.agent_licenses add constraint agent_licenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.agent_policies add constraint agent_policies_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
alter table public.agent_policies add constraint agent_policies_consumer_id_fkey FOREIGN KEY (consumer_id) REFERENCES consumers(id) ON DELETE SET NULL;
alter table public.agent_policies add constraint agent_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.agent_transactions add constraint agent_transactions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
alter table public.agents add constraint agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.alerts add constraint alerts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL;
alter table public.ap_ledger add constraint ap_ledger_publisher_campaign_id_fkey FOREIGN KEY (publisher_campaign_id) REFERENCES publisher_campaigns(id);
alter table public.ap_ledger add constraint ap_ledger_publisher_id_fkey FOREIGN KEY (publisher_id) REFERENCES publishers(id);
alter table public.ar_ledger add constraint ar_ledger_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.ar_ledger add constraint ar_ledger_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.callgrid_calls add constraint ringba_calls_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.callgrid_calls add constraint ringba_calls_publisher_campaign_id_fkey FOREIGN KEY (publisher_campaign_id) REFERENCES publisher_campaigns(id);
alter table public.callgrid_calls add constraint ringba_calls_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE SET NULL;
alter table public.callgrid_calls add constraint ringba_calls_tv_creative_id_fkey FOREIGN KEY (tv_creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.callgrid_calls add constraint ringba_calls_tv_network_id_fkey FOREIGN KEY (tv_network_id) REFERENCES tv_networks(id);
alter table public.callgrid_daily_totals add constraint ringba_daily_totals_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id) ON DELETE SET NULL;
alter table public.campaign_links add constraint campaign_links_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id) ON DELETE CASCADE;
alter table public.campaign_links add constraint campaign_links_publisher_campaign_id_fkey FOREIGN KEY (publisher_campaign_id) REFERENCES publisher_campaigns(id) ON DELETE CASCADE;
alter table public.client_campaign_rates add constraint client_campaign_rates_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id) ON DELETE CASCADE;
alter table public.client_campaigns add constraint client_campaigns_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
alter table public.consumers add constraint consumers_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
alter table public.consumers add constraint consumers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.creative_review_notes add constraint creative_review_notes_version_id_fkey FOREIGN KEY (version_id) REFERENCES creative_review_versions(id) ON DELETE CASCADE;
alter table public.creative_review_versions add constraint creative_review_versions_test_id_fkey FOREIGN KEY (test_id) REFERENCES creative_entries(id) ON DELETE CASCADE;
alter table public.crm_deals add constraint crm_deals_converted_client_id_fkey FOREIGN KEY (converted_client_id) REFERENCES clients(id) ON DELETE SET NULL;
alter table public.dispo_leads add constraint dispo_leads_first_upload_id_fkey FOREIGN KEY (first_upload_id) REFERENCES dispo_uploads(id) ON DELETE SET NULL;
alter table public.dispo_leads add constraint dispo_leads_last_upload_id_fkey FOREIGN KEY (last_upload_id) REFERENCES dispo_uploads(id) ON DELETE SET NULL;
alter table public.integration_links add constraint integration_links_system_fkey FOREIGN KEY (system) REFERENCES integration_systems(id);
alter table public.integration_log add constraint integration_log_system_fkey FOREIGN KEY (system) REFERENCES integration_systems(id);
alter table public.media_plans add constraint media_plans_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.mercury_transactions add constraint mercury_transactions_matched_ap_id_fkey FOREIGN KEY (matched_ap_id) REFERENCES ap_ledger(id) ON DELETE SET NULL;
alter table public.mercury_transactions add constraint mercury_transactions_matched_ar_id_fkey FOREIGN KEY (matched_ar_id) REFERENCES ar_ledger(id) ON DELETE SET NULL;
alter table public.notification_preferences add constraint notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.onboarding_checklist_items add constraint onboarding_checklist_items_checklist_id_fkey FOREIGN KEY (checklist_id) REFERENCES onboarding_checklists(id) ON DELETE CASCADE;
alter table public.pub_actuals add constraint pub_actuals_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.pub_actuals add constraint pub_actuals_publisher_campaign_id_fkey FOREIGN KEY (publisher_campaign_id) REFERENCES publisher_campaigns(id) ON DELETE SET NULL;
alter table public.pub_actuals add constraint pub_actuals_publisher_id_fkey FOREIGN KEY (publisher_id) REFERENCES publishers(id);
alter table public.publisher_campaign_rates add constraint publisher_campaign_rates_publisher_campaign_id_fkey FOREIGN KEY (publisher_campaign_id) REFERENCES publisher_campaigns(id) ON DELETE CASCADE;
alter table public.publisher_campaigns add constraint publisher_campaigns_publisher_id_fkey FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE;
alter table public.quote_products add constraint quote_products_carrier_id_fkey FOREIGN KEY (carrier_id) REFERENCES quote_carriers(id) ON DELETE CASCADE;
alter table public.quote_rates add constraint quote_rates_product_id_fkey FOREIGN KEY (product_id) REFERENCES quote_products(id) ON DELETE CASCADE;
alter table public.tv_airings add constraint tv_airings_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.tv_airings add constraint tv_airings_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_airings add constraint tv_airings_tv_buy_line_id_fkey FOREIGN KEY (tv_buy_line_id) REFERENCES tv_buy_lines(id) ON DELETE SET NULL;
alter table public.tv_airings add constraint tv_airings_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_ap_ledger add constraint tv_ap_ledger_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_ap_ledger add constraint tv_ap_ledger_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_ar_ledger add constraint tv_ar_ledger_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.tv_ar_ledger add constraint tv_ar_ledger_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.tv_ar_ledger add constraint tv_ar_ledger_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_bookings add constraint tv_bookings_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.tv_bookings add constraint tv_bookings_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_bookings add constraint tv_bookings_tv_buy_line_id_fkey FOREIGN KEY (tv_buy_line_id) REFERENCES tv_buy_lines(id) ON DELETE CASCADE;
alter table public.tv_bookings add constraint tv_bookings_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_buy_lines add constraint tv_buy_lines_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.tv_buy_lines add constraint tv_buy_lines_media_plan_id_fkey FOREIGN KEY (media_plan_id) REFERENCES media_plans(id) ON DELETE SET NULL;
alter table public.tv_buy_lines add constraint tv_buy_lines_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_buy_lines add constraint tv_buy_lines_source_plan_line_id_fkey FOREIGN KEY (source_plan_line_id) REFERENCES tv_buy_lines(id) ON DELETE SET NULL;
alter table public.tv_buy_lines add constraint tv_buy_lines_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_campaign_clients add constraint tv_campaign_clients_client_campaign_id_fkey FOREIGN KEY (client_campaign_id) REFERENCES client_campaigns(id);
alter table public.tv_campaign_clients add constraint tv_campaign_clients_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.tv_campaign_clients add constraint tv_campaign_clients_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_campaign_networks add constraint tv_campaign_networks_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_campaign_networks add constraint tv_campaign_networks_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_creative_numbers add constraint tv_creative_numbers_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE CASCADE;
alter table public.tv_creative_numbers add constraint tv_creative_numbers_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES tv_phone_numbers(id) ON DELETE CASCADE;
alter table public.tv_creatives add constraint tv_creatives_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE SET NULL;
alter table public.tv_ios add constraint tv_ios_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_ios add constraint tv_ios_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.tv_line_creatives add constraint tv_line_creatives_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.tv_line_creatives add constraint tv_line_creatives_tv_buy_line_id_fkey FOREIGN KEY (tv_buy_line_id) REFERENCES tv_buy_lines(id) ON DELETE CASCADE;
alter table public.tv_number_assignments add constraint tv_number_assignments_creative_id_fkey FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE SET NULL;
alter table public.tv_number_assignments add constraint tv_number_assignments_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id);
alter table public.tv_number_assignments add constraint tv_number_assignments_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES tv_phone_numbers(id) ON DELETE CASCADE;
alter table public.tv_number_assignments add constraint tv_number_assignments_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE SET NULL;
alter table public.tv_spot_log add constraint tv_spot_log_network_id_fkey FOREIGN KEY (network_id) REFERENCES tv_networks(id) ON DELETE SET NULL;
alter table public.tv_spot_log add constraint tv_spot_log_tv_buy_line_id_fkey FOREIGN KEY (tv_buy_line_id) REFERENCES tv_buy_lines(id) ON DELETE SET NULL;
alter table public.tv_spot_log add constraint tv_spot_log_tv_campaign_id_fkey FOREIGN KEY (tv_campaign_id) REFERENCES tv_campaigns(id) ON DELETE CASCADE;
alter table public.user_profiles add constraint user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- INDEXES

CREATE INDEX idx_agent_adjustments_owner ON public.agent_adjustments USING btree (created_by, date DESC);
CREATE INDEX idx_agent_licenses_owner ON public.agent_licenses USING btree (created_by, expiry_date);
CREATE INDEX idx_agent_policies_owner ON public.agent_policies USING btree (created_by, created_at DESC);
CREATE INDEX idx_agent_policies_paydate ON public.agent_policies USING btree (payment_status, expected_pay_date);
CREATE INDEX idx_agent_transactions_agent ON public.agent_transactions USING btree (agent_id, date DESC);
CREATE INDEX alerts_dedupe_idx ON public.alerts USING btree (dedupe_key, fired_at DESC);
CREATE INDEX alerts_status_idx ON public.alerts USING btree (status, fired_at DESC);
CREATE INDEX bid_daily_stats_date_idx ON public.bid_daily_stats USING btree (date);
CREATE INDEX call_analysis_status_idx ON public.call_analysis USING btree (status);
CREATE INDEX callgrid_calls_date_idx ON public.callgrid_calls USING btree (date);
CREATE INDEX callgrid_calls_dt_idx ON public.callgrid_calls USING btree (call_datetime DESC);
CREATE INDEX idx_ringba_calls_client_campaign ON public.callgrid_calls USING btree (client_campaign_id);
CREATE INDEX idx_ringba_calls_date ON public.callgrid_calls USING btree (date);
CREATE INDEX idx_ringba_calls_dialed_number ON public.callgrid_calls USING btree (dialed_number);
CREATE INDEX idx_ringba_calls_is_tv_call ON public.callgrid_calls USING btree (is_tv_call) WHERE (is_tv_call = true);
CREATE INDEX idx_ringba_calls_publisher_campaign ON public.callgrid_calls USING btree (publisher_campaign_id);
CREATE INDEX idx_ringba_daily_totals_lookup ON public.callgrid_daily_totals USING btree (date, client_campaign_id);
CREATE INDEX idx_rdtp_date ON public.callgrid_daily_totals_pub USING btree (date);
CREATE INDEX idx_rdtp_pub ON public.callgrid_daily_totals_pub USING btree (publisher_campaign_id);
CREATE INDEX client_report_entries_scope_idx ON public.client_report_entries USING btree (scope_key);
CREATE INDEX idx_consumers_callback ON public.consumers USING btree (disposition, callback_at);
CREATE INDEX idx_consumers_creator ON public.consumers USING btree (created_by, created_at DESC);
CREATE INDEX idx_creative_entries_kind ON public.creative_entries USING btree (kind);
CREATE INDEX idx_crn_version ON public.creative_review_notes USING btree (version_id);
CREATE INDEX idx_crv_test ON public.creative_review_versions USING btree (test_id);
CREATE INDEX idx_crm_contacts_entity ON public.crm_contacts USING btree (entity_type, entity_id);
CREATE INDEX idx_crm_notes_entity ON public.crm_notes USING btree (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_crm_tasks_status_due ON public.crm_tasks USING btree (status, due_date);
CREATE INDEX dispo_leads_client_date_idx ON public.dispo_leads USING btree (client_id, first_call_date);
CREATE INDEX dispo_leads_publisher_idx ON public.dispo_leads USING btree (publisher_name);
CREATE INDEX idx_integration_links_local ON public.integration_links USING btree (entity_type, local_id);
CREATE INDEX idx_integration_log_errors ON public.integration_log USING btree (system, status, resolved);
CREATE INDEX idx_integration_log_recent ON public.integration_log USING btree (created_at DESC);
CREATE INDEX idx_invoice_line_items_lookup ON public.invoice_line_items USING btree (ledger, invoice_id, sort_order);
CREATE INDEX idx_media_plans_campaign ON public.media_plans USING btree (tv_campaign_id);
CREATE INDEX idx_mercury_txn_match ON public.mercury_transactions USING btree (match_status);
CREATE INDEX idx_mercury_txn_posted ON public.mercury_transactions USING btree (posted_at DESC);
CREATE INDEX idx_pbh_dest ON public.ping_bid_hourly USING btree (destination_id, date);
CREATE INDEX idx_pb_amount ON public.ping_bids USING btree (bid_amount);
CREATE INDEX idx_pb_date ON public.ping_bids USING btree (date);
CREATE INDEX idx_pb_dest ON public.ping_bids USING btree (destination_name, date);
CREATE INDEX idx_pb_won ON public.ping_bids USING btree (date) WHERE won_bid;
CREATE INDEX ping_daily_stats_date_idx ON public.ping_daily_stats USING btree (date);
CREATE INDEX idx_tv_airings_air_date ON public.tv_airings USING btree (air_date);
CREATE INDEX idx_tv_airings_campaign ON public.tv_airings USING btree (tv_campaign_id);
CREATE INDEX idx_tv_airings_network ON public.tv_airings USING btree (network_id);
CREATE INDEX idx_tv_airings_tfn ON public.tv_airings USING btree (tfn);
CREATE INDEX idx_tv_bookings_buy_line ON public.tv_bookings USING btree (tv_buy_line_id);
CREATE INDEX idx_tv_buy_lines_media_plan ON public.tv_buy_lines USING btree (media_plan_id);
CREATE INDEX idx_tv_buy_lines_source_plan_line ON public.tv_buy_lines USING btree (source_plan_line_id);
CREATE INDEX idx_tv_creative_numbers_creative ON public.tv_creative_numbers USING btree (creative_id);
CREATE INDEX idx_tv_creative_numbers_phone ON public.tv_creative_numbers USING btree (phone_number_id);
CREATE INDEX idx_tv_creative_numbers_phone_active ON public.tv_creative_numbers USING btree (phone_number_id, valid_to);
CREATE INDEX idx_tv_creatives_campaign ON public.tv_creatives USING btree (tv_campaign_id);
CREATE INDEX hubspot_contacts_account_idx ON public.hubspot_contacts USING btree (account_external_id);

-- VIEWS

-- TRIGGERS

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER ap_ledger_updated_at BEFORE UPDATE ON public.ap_ledger FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER ar_ledger_updated_at BEFORE UPDATE ON public.ar_ledger FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tv_ap_ledger_updated_at BEFORE UPDATE ON public.tv_ap_ledger FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tv_ar_ledger_updated_at BEFORE UPDATE ON public.tv_ar_ledger FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS

alter table public.account_onboarding enable row level security;
alter table public.actuals enable row level security;
alter table public.agent_adjustments enable row level security;
alter table public.agent_licenses enable row level security;
alter table public.agent_policies enable row level security;
alter table public.agent_scripts enable row level security;
alter table public.agent_transactions enable row level security;
alter table public.agents enable row level security;
alter table public.alert_log enable row level security;
alter table public.alert_rules enable row level security;
alter table public.alerts enable row level security;
alter table public.ap_ledger enable row level security;
alter table public.ar_ledger enable row level security;
alter table public.bid_daily_stats enable row level security;
alter table public.call_analysis enable row level security;
alter table public.callgrid_calls enable row level security;
alter table public.callgrid_daily_totals enable row level security;
alter table public.callgrid_daily_totals_pub enable row level security;
alter table public.campaign_links enable row level security;
alter table public.client_campaign_rates enable row level security;
alter table public.client_campaigns enable row level security;
alter table public.client_report_entries enable row level security;
alter table public.clients enable row level security;
alter table public.consumers enable row level security;
alter table public.creative_entries enable row level security;
alter table public.creative_review_notes enable row level security;
alter table public.creative_review_versions enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_deals enable row level security;
alter table public.crm_notes enable row level security;
alter table public.crm_tasks enable row level security;
alter table public.dispo_leads enable row level security;
alter table public.dispo_uploads enable row level security;
alter table public.dnc_list enable row level security;
alter table public.hr_announcements enable row level security;
alter table public.hr_documents enable row level security;
alter table public.hr_holidays enable row level security;
alter table public.hr_time_off enable row level security;
alter table public.integration_links enable row level security;
alter table public.integration_log enable row level security;
alter table public.integration_secrets enable row level security;
alter table public.integration_systems enable row level security;
alter table public.invoice_line_items enable row level security;
alter table public.io_requests enable row level security;
alter table public.media_plans enable row level security;
alter table public.mercury_transactions enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.onboarding_checklist_items enable row level security;
alter table public.onboarding_checklists enable row level security;
alter table public.ping_bid_hourly enable row level security;
alter table public.ping_bids enable row level security;
alter table public.ping_daily_stats enable row level security;
alter table public.ping_sync_state enable row level security;
alter table public.pub_actuals enable row level security;
alter table public.publisher_campaign_rates enable row level security;
alter table public.publisher_campaigns enable row level security;
alter table public.publishers enable row level security;
alter table public.quote_carriers enable row level security;
alter table public.quote_products enable row level security;
alter table public.quote_rates enable row level security;
alter table public.roku_auth enable row level security;
alter table public.tv_airings enable row level security;
alter table public.tv_ap_ledger enable row level security;
alter table public.tv_ar_ledger enable row level security;
alter table public.tv_bookings enable row level security;
alter table public.tv_buy_lines enable row level security;
alter table public.tv_campaign_clients enable row level security;
alter table public.tv_campaign_networks enable row level security;
alter table public.tv_campaigns enable row level security;
alter table public.tv_creative_numbers enable row level security;
alter table public.tv_creatives enable row level security;
alter table public.tv_ios enable row level security;
alter table public.tv_line_creatives enable row level security;
alter table public.tv_networks enable row level security;
alter table public.tv_number_assignments enable row level security;
alter table public.tv_phone_numbers enable row level security;
alter table public.tv_spot_log enable row level security;
alter table public.user_profiles enable row level security;
alter table public.hubspot_companies enable row level security;
alter table public.hubspot_contacts enable row level security;

-- POLICIES

create policy staff_all on public.account_onboarding as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.actuals as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy own_rows on public.agent_adjustments as PERMISSIVE for ALL to authenticated
  using ((created_by = auth.uid()))
  with check ((created_by = auth.uid()));
create policy staff_all on public.agent_adjustments as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy own_rows on public.agent_licenses as PERMISSIVE for ALL to authenticated
  using ((created_by = auth.uid()))
  with check ((created_by = auth.uid()));
create policy staff_all on public.agent_licenses as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy own_rows on public.agent_policies as PERMISSIVE for ALL to authenticated
  using ((created_by = auth.uid()))
  with check ((created_by = auth.uid()));
create policy staff_all on public.agent_policies as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy all_read on public.agent_scripts as PERMISSIVE for SELECT to authenticated
  using (true);
create policy staff_write on public.agent_scripts as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy agent_txns_own_read on public.agent_transactions as PERMISSIVE for SELECT to authenticated
  using ((agent_id IN ( SELECT agents.id
   FROM agents
  WHERE (agents.user_id = auth.uid()))));
create policy agent_txns_staff on public.agent_transactions as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy agents_own_read on public.agents as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));
create policy agents_staff on public.agents as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.alert_log as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff manage alert rules" on public.alert_rules as PERMISSIVE for ALL to public
  using (is_staff())
  with check (is_staff());
create policy "staff ack alerts" on public.alerts as PERMISSIVE for UPDATE to public
  using (is_staff())
  with check (is_staff());
create policy "staff read alerts" on public.alerts as PERMISSIVE for SELECT to public
  using (is_staff());
create policy staff_only on public.ap_ledger as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.ar_ledger as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff read bid stats" on public.bid_daily_stats as PERMISSIVE for SELECT to public
  using (is_staff());
create policy "staff read call analysis" on public.call_analysis as PERMISSIVE for SELECT to public
  using (is_staff());
create policy staff_only on public.callgrid_calls as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.callgrid_daily_totals as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.callgrid_daily_totals_pub as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.campaign_links as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.client_campaign_rates as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.client_campaigns as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_all on public.client_report_entries as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.clients as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy consumers_agent_own on public.consumers as PERMISSIVE for ALL to authenticated
  using ((created_by = auth.uid()))
  with check ((created_by = auth.uid()));
create policy consumers_staff on public.consumers as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff all" on public.creative_entries as PERMISSIVE for ALL to authenticated
  using (true)
  with check (true);
create policy "staff all" on public.creative_review_notes as PERMISSIVE for ALL to authenticated
  using (true)
  with check (true);
create policy "staff all" on public.creative_review_versions as PERMISSIVE for ALL to authenticated
  using (true)
  with check (true);
create policy staff_only on public.crm_contacts as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.crm_deals as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.crm_notes as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.crm_tasks as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff read dispo leads" on public.dispo_leads as PERMISSIVE for SELECT to public
  using (is_staff());
create policy "staff read dispo uploads" on public.dispo_uploads as PERMISSIVE for SELECT to public
  using (is_staff());
create policy insert_all on public.dnc_list as PERMISSIVE for INSERT to authenticated
  with check (true);
create policy read_all on public.dnc_list as PERMISSIVE for SELECT to authenticated
  using (true);
create policy staff_delete on public.dnc_list as PERMISSIVE for DELETE to authenticated
  using (is_staff());
create policy staff_update on public.dnc_list as PERMISSIVE for UPDATE to authenticated
  using (is_staff())
  with check (is_staff());
create policy admin_write on public.hr_announcements as PERMISSIVE for ALL to authenticated
  using (is_admin())
  with check (is_admin());
create policy read_all on public.hr_announcements as PERMISSIVE for SELECT to authenticated
  using (true);
create policy admin_write on public.hr_documents as PERMISSIVE for ALL to authenticated
  using (is_admin())
  with check (is_admin());
create policy read_all on public.hr_documents as PERMISSIVE for SELECT to authenticated
  using (true);
create policy admin_write on public.hr_holidays as PERMISSIVE for ALL to authenticated
  using (is_admin())
  with check (is_admin());
create policy read_all on public.hr_holidays as PERMISSIVE for SELECT to authenticated
  using (true);
create policy admin_all on public.hr_time_off as PERMISSIVE for ALL to authenticated
  using (is_admin())
  with check (is_admin());
create policy own_insert on public.hr_time_off as PERMISSIVE for INSERT to authenticated
  with check ((user_id = auth.uid()));
create policy own_select on public.hr_time_off as PERMISSIVE for SELECT to authenticated
  using ((user_id = auth.uid()));
create policy own_update on public.hr_time_off as PERMISSIVE for UPDATE to authenticated
  using ((user_id = auth.uid()))
  with check ((user_id = auth.uid()));
create policy staff_only on public.integration_links as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.integration_log as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.integration_systems as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.invoice_line_items as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_read on public.io_requests as PERMISSIVE for SELECT to authenticated
  using (is_staff());
create policy staff_only on public.media_plans as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.mercury_transactions as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.notification_preferences as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.onboarding_checklist_items as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.onboarding_checklists as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff read" on public.ping_bid_hourly as PERMISSIVE for SELECT to authenticated
  using (true);
create policy "staff read" on public.ping_bids as PERMISSIVE for SELECT to authenticated
  using (true);
create policy "staff read ping stats" on public.ping_daily_stats as PERMISSIVE for SELECT to public
  using (is_staff());
create policy "staff read sync state" on public.ping_sync_state as PERMISSIVE for SELECT to public
  using (is_staff());
create policy staff_only on public.pub_actuals as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.publisher_campaign_rates as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.publisher_campaigns as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.publishers as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy qc_read on public.quote_carriers as PERMISSIVE for SELECT to authenticated
  using (true);
create policy qc_staff_write on public.quote_carriers as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy qp_read on public.quote_products as PERMISSIVE for SELECT to authenticated
  using (true);
create policy qp_staff_write on public.quote_products as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy qr_read on public.quote_rates as PERMISSIVE for SELECT to authenticated
  using (true);
create policy qr_staff_write on public.quote_rates as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.roku_auth as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_airings as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_ap_ledger as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_ar_ledger as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_bookings as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_buy_lines as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_campaign_clients as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_campaign_networks as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_campaigns as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_creative_numbers as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_creatives as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_ios as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_line_creatives as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_networks as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_number_assignments as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_phone_numbers as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.tv_spot_log as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy profiles_delete on public.user_profiles as PERMISSIVE for DELETE to authenticated
  using (is_admin());
create policy profiles_insert on public.user_profiles as PERMISSIVE for INSERT to authenticated
  with check (is_admin());
create policy profiles_select on public.user_profiles as PERMISSIVE for SELECT to authenticated
  using (((user_id = auth.uid()) OR is_staff()));
create policy profiles_update on public.user_profiles as PERMISSIVE for UPDATE to authenticated
  using (is_admin())
  with check (is_admin());
create policy staff_only on public.hubspot_companies as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy staff_only on public.hubspot_contacts as PERMISSIVE for ALL to authenticated
  using (is_staff())
  with check (is_staff());
create policy "staff read creative reviews" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = 'creative-reviews'::text) AND is_staff()));
create policy "staff update creative reviews" on storage.objects as PERMISSIVE for UPDATE to authenticated
  using (((bucket_id = 'creative-reviews'::text) AND is_staff()))
  with check (((bucket_id = 'creative-reviews'::text) AND is_staff()));
create policy "staff upload creative reviews" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = 'creative-reviews'::text) AND is_staff()));

-- STORAGE BUCKETS

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ('creative-reviews', 'creative-reviews', 'f', 83886080, '{video/mp4,video/webm}'::text[]) on conflict (id) do nothing;

-- SEED: integration tiles shown on the Integrations page
insert into public.integration_systems (id, label, enabled) values
  ('callgrid', 'CallGrid', true),
  ('hubspot',  'HubSpot',  true),
  ('alerts',   'Alerts & Daily Brief', true),
  ('dispo',    'Disposition Uploads',  true)
on conflict (id) do update set label = excluded.label, enabled = excluded.enabled;
