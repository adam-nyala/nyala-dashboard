-- ============================================================================
-- Nyala Labs: upgrade to the November 2026 OmniSure feature set.
-- Run ONCE in the Nyala Supabase SQL Editor. All-or-nothing: wrapped in a
-- transaction, so any error leaves the database exactly as it was.
-- ============================================================================
begin;
alter table "public"."callgrid_daily_totals_pub" drop constraint "ringba_daily_totals_pub_date_ringba_publisher_name_key";

alter table "public"."alert_rules" drop constraint "alert_rules_metric_check";

drop index if exists "public"."ringba_daily_totals_pub_date_ringba_publisher_name_key";

create table "public"."alert_outbox" (
    "id" uuid not null default gen_random_uuid(),
    "kind" text not null,
    "dedupe_key" text not null,
    "payload" jsonb not null,
    "status" text not null default 'queued'::text,
    "attempts" integer default 0,
    "last_error" text,
    "created_at" timestamp with time zone default now(),
    "sent_at" timestamp with time zone
);


alter table "public"."alert_outbox" enable row level security;

create table "public"."callgrid_campaigns_mirror" (
    "id" text not null,
    "name" text,
    "active" boolean,
    "bidding_enabled" boolean,
    "transcription" boolean,
    "cg_created_at" text,
    "cg_updated_at" text,
    "synced_at" timestamp with time zone
);


alter table "public"."callgrid_campaigns_mirror" enable row level security;

create table "public"."callgrid_destinations" (
    "id" text not null,
    "name" text,
    "buyer_id" text,
    "buyer_name" text,
    "phone_number" text,
    "sip_uri" text,
    "timezone" text,
    "call_hours" text,
    "cap_type" text,
    "daily_cap" numeric,
    "hourly_cap" numeric,
    "monthly_cap" numeric,
    "global_cap" numeric,
    "max_concurrent_calls" numeric,
    "revenue_type" text,
    "revenue_amount" numeric,
    "billable_type" text,
    "duration_start" text,
    "duration_type" text,
    "duration_seconds" numeric,
    "states" text,
    "campaign_ids" jsonb,
    "campaign_names" jsonb,
    "active" boolean,
    "paused" boolean,
    "capped" boolean,
    "capped_until" text,
    "tags_raw" jsonb,
    "cg_updated_at" text,
    "synced_at" timestamp with time zone
);


alter table "public"."callgrid_destinations" enable row level security;

create table "public"."creative_week_stats" (
    "id" uuid not null default gen_random_uuid(),
    "creative_id" uuid not null,
    "week_start" date not null,
    "platform" text,
    "spend" numeric,
    "impressions" bigint,
    "notes" text,
    "updated_by" text,
    "updated_at" timestamp with time zone default now()
);


alter table "public"."creative_week_stats" enable row level security;

create table "public"."crm_dids" (
    "crm_id" text not null,
    "did" text not null,
    "buyer_offer_crm_id" text,
    "account_crm_id" text,
    "status" text,
    "start_date" date,
    "end_date" date,
    "label" text,
    "notes" text,
    "record_url" text,
    "raw" jsonb,
    "synced_at" timestamp with time zone default now()
);


alter table "public"."crm_dids" enable row level security;

create table "public"."crm_meta" (
    "key" text not null,
    "value" text,
    "updated_at" timestamp with time zone default now()
);


alter table "public"."crm_meta" enable row level security;

create table "public"."launch_notes" (
    "key" text not null,
    "note" text not null,
    "noted_by" text,
    "noted_at" timestamp with time zone default now(),
    "expected" boolean default true
);


alter table "public"."launch_notes" enable row level security;

create table "public"."notification_prefs" (
    "email" text not null,
    "kind" text not null,
    "enabled" boolean not null default true,
    "updated_at" timestamp with time zone default now()
);


alter table "public"."notification_prefs" enable row level security;

create table "public"."ob_accounts" (
    "crm_id" text not null,
    "name" text,
    "partner_type" text,
    "buyer_account_status" text,
    "publisher_account_status" text,
    "buyer_msa_signed" text,
    "publisher_msa_signed" text,
    "publisher_msa_status" text,
    "msa_type" text,
    "overall_paperwork_status" text,
    "buyer_paperwork_status" text,
    "publisher_paperwork_status" text,
    "paperwork_used_buyer" text,
    "paperwork_used_publisher" text,
    "buyer_owner" text,
    "publisher_owner" text,
    "owner_name" text,
    "closed_the_deal" text,
    "intake_notes" text,
    "buyer_notes" text,
    "publisher_notes" text,
    "verticals" text,
    "traffic_type" text,
    "buyer_payment_terms" text,
    "publisher_payment_terms" text,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "last_activity_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "activity_at" timestamp with time zone,
    "raw" jsonb,
    "record_url" text
);


alter table "public"."ob_accounts" enable row level security;

create table "public"."ob_agreement_links" (
    "crm_id" text not null,
    "name" text,
    "agreement_crm_id" text,
    "buyer_campaign_crm_id" text,
    "publisher_campaign_crm_id" text,
    "link_status" text,
    "link_source" text,
    "sign_document_id" text,
    "coverage_note" text,
    "linked_by" text,
    "linked_at" timestamp with time zone,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "record_url" text
);


alter table "public"."ob_agreement_links" enable row level security;

create table "public"."ob_campaign_matches" (
    "crm_id" text not null,
    "name" text,
    "buyer_campaign_crm_id" text,
    "publisher_campaign_crm_id" text,
    "match_stage" text,
    "match_source" text,
    "match_owner" text,
    "confirmed_by" text,
    "confirmed_on" timestamp with time zone,
    "rejection_reason" text,
    "match_notes" text,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "record_url" text
);


alter table "public"."ob_campaign_matches" enable row level security;

create table "public"."ob_campaigns" (
    "crm_id" text not null,
    "side" text not null,
    "account_crm_id" text,
    "account_name" text,
    "name" text,
    "dashboard_id" text,
    "offer_status" text,
    "next_action" text,
    "follow_up_date" date,
    "follow_up_owner" text,
    "campaign_status" text,
    "campaign_link_status" text,
    "io_status" text,
    "io_date_signed" date,
    "io_attached" boolean,
    "io_doc_link" text,
    "io_campaign_name" text,
    "io_rate" numeric,
    "io_duration" integer,
    "io_payment_terms" text,
    "io_sync_hold" boolean,
    "rate" numeric,
    "billable_duration" integer,
    "payment_terms" text,
    "synced_payment_terms" text,
    "vertical" text,
    "lead_type" text,
    "traffic_type" text,
    "callgrid_campaign" text,
    "callgrid_buyer_publisher" text,
    "endpoint_name" text,
    "did" text,
    "daily_cap" integer,
    "concurrency" integer,
    "call_hours" text,
    "campaign_notes" text,
    "active" boolean,
    "owner_name" text,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "last_activity_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "activity_at" timestamp with time zone,
    "io_did" text,
    "io_call_hours" text,
    "io_daily_cap" integer,
    "io_concurrency" integer,
    "io_states" text,
    "buyer_cpa_goal" text,
    "record_url" text
);


alter table "public"."ob_campaigns" enable row level security;

create table "public"."ob_contracts" (
    "crm_id" text not null,
    "name" text,
    "document_type" text,
    "partner_side" text,
    "status" text,
    "signed_date" date,
    "source" text,
    "paperwork_source" text,
    "account_crm_id" text,
    "account_name" text,
    "buyer_campaign_crm_id" text,
    "publisher_campaign_crm_id" text,
    "campaign_name" text,
    "dashboard_campaign_id" text,
    "doc_file_link" text,
    "signed_pdf_link" text,
    "sign_document_id" text,
    "io_sync_status" text,
    "io_sync_hold" boolean,
    "owner_name" text,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "record_url" text
);


alter table "public"."ob_contracts" enable row level security;

create table "public"."ob_field_meta" (
    "module" text not null,
    "api_name" text not null,
    "label" text,
    "data_type" text,
    "updated_at" timestamp with time zone default now()
);


alter table "public"."ob_field_meta" enable row level security;

create table "public"."ob_overrides" (
    "id" uuid not null default gen_random_uuid(),
    "record_type" text not null,
    "crm_id" text not null,
    "field" text not null,
    "value" text,
    "note" text,
    "set_by" text,
    "set_at" timestamp with time zone default now(),
    "active" boolean default true,
    "removed_by" text,
    "removed_at" timestamp with time zone
);


alter table "public"."ob_overrides" enable row level security;

create table "public"."ob_prospects" (
    "crm_id" text not null,
    "name" text,
    "partner_type" text,
    "intake_status" text,
    "msa_status" text,
    "contract_status" text,
    "contract_doc_link" text,
    "last_contact_date" date,
    "next_follow_up_date" date,
    "next_action" text,
    "onboarding_notes" text,
    "campaign_details" text,
    "primary_contact" text,
    "email" text,
    "owner_name" text,
    "who_closed" text,
    "linked_account_crm_id" text,
    "match_status" text default 'unmatched'::text,
    "created_time" timestamp with time zone,
    "modified_time" timestamp with time zone,
    "last_activity_time" timestamp with time zone,
    "synced_at" timestamp with time zone,
    "activity_at" timestamp with time zone,
    "suggested_account_crm_id" text,
    "match_confidence" text,
    "record_url" text
);


alter table "public"."ob_prospects" enable row level security;

create table "public"."onboarding_history" (
    "id" uuid not null default gen_random_uuid(),
    "kind" text not null,
    "account_crm_id" text,
    "account_name" text,
    "campaign_crm_id" text,
    "campaign_name" text,
    "side" text,
    "snapshot" jsonb not null,
    "contracts" jsonb,
    "verified_live_at" timestamp with time zone,
    "cg_campaign_id" text,
    "first_call_at" timestamp with time zone,
    "doc_flags" jsonb,
    "completed_at" timestamp with time zone default now(),
    "completed_by" text default 'go-live engine'::text,
    "reopened_at" timestamp with time zone,
    "reopened_by" text,
    "unique_key" text
);


alter table "public"."onboarding_history" enable row level security;

create table "public"."roku_campaigns" (
    "uid" text not null,
    "account_uid" text,
    "name" text,
    "status" text,
    "start_date" date,
    "end_date" date,
    "budget" numeric,
    "budget_type" text,
    "is_archived" boolean,
    "raw" jsonb,
    "synced_at" timestamp with time zone,
    "objective" text,
    "is_enabled" boolean,
    "linked_creative_id" uuid
);


alter table "public"."roku_campaigns" enable row level security;

create table "public"."roku_creative_stats" (
    "date" date not null,
    "creative_id" text not null,
    "creative_name" text,
    "campaign_id" text,
    "campaign_name" text,
    "impressions" bigint,
    "spend" numeric,
    "video_completes" bigint,
    "actions" numeric,
    "tfn_digits" text,
    "tv_creative_id" uuid,
    "synced_at" timestamp with time zone
);


alter table "public"."roku_creative_stats" enable row level security;

create table "public"."roku_daily_stats" (
    "campaign_uid" text not null,
    "date" date not null,
    "impressions" bigint,
    "spend" numeric,
    "raw" jsonb,
    "synced_at" timestamp with time zone,
    "video_completes" bigint,
    "actions" bigint
);


alter table "public"."roku_daily_stats" enable row level security;

create table "public"."sales_msa_actions" (
    "id" uuid not null default gen_random_uuid(),
    "account_crm_id" text,
    "prospect_crm_id" text,
    "company_name" text not null,
    "action" text not null,
    "pending_on" text,
    "owner" text,
    "doc_crm_id" text,
    "started_at" timestamp with time zone not null default now(),
    "resolved_at" timestamp with time zone,
    "resolved_note" text,
    "created_by" text
);


alter table "public"."sales_msa_actions" enable row level security;

create table "public"."sales_opp_events" (
    "id" bigint generated always as identity not null,
    "opp_id" uuid not null,
    "at" timestamp with time zone default now(),
    "actor" text,
    "event" text not null,
    "old_value" text,
    "new_value" text,
    "note" text
);


alter table "public"."sales_opp_events" enable row level security;

create table "public"."sales_opportunities" (
    "id" uuid not null default gen_random_uuid(),
    "company_name" text not null,
    "prospect_crm_id" text,
    "account_crm_id" text,
    "partner_type" text,
    "vertical" text,
    "offer_text" text,
    "contact_name" text,
    "contact_email" text,
    "sales_owner" text,
    "stage" text not null default 'new'::text,
    "discovery_at" timestamp with time zone,
    "next_follow_up" date,
    "next_action" text,
    "closed_lost_reason" text,
    "closed_lost_at" timestamp with time zone,
    "forecast" jsonb,
    "created_by" text,
    "source" text default 'manual'::text,
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now()
);


alter table "public"."sales_opportunities" enable row level security;

create table "public"."sales_views" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "owner" text,
    "shared" boolean default false,
    "config" jsonb not null,
    "created_at" timestamp with time zone default now()
);


alter table "public"."sales_views" enable row level security;

alter table "public"."call_analysis" add column "ad_promise" text;

alter table "public"."call_analysis" add column "ad_source" text;

alter table "public"."call_analysis" add column "beneficiary_mentioned" text;

alter table "public"."call_analysis" add column "recording_url" text;

alter table "public"."call_analysis" add column "source" text not null default 'kaliper'::text;

alter table "public"."call_analysis" add column "transcript" text;

alter table "public"."call_analysis" add column "transfer_signs" text;

alter table "public"."call_analysis" add column "who_spoke" text;

alter table "public"."callgrid_calls" add column "buyer_offer_crm_id" text;

alter table "public"."callgrid_calls" add column "call_status" text;

alter table "public"."callgrid_calls" add column "cg_campaign_id" text;

alter table "public"."callgrid_calls" add column "destination_number" text;

alter table "public"."callgrid_calls" add column "did_crm_id" text;

alter table "public"."callgrid_calls" add column "source_billable" boolean;

alter table "public"."callgrid_calls" add column "telco_cost" numeric default 0;

alter table "public"."client_campaigns" add column "cg_billable_duration" numeric;

alter table "public"."client_campaigns" add column "cg_call_hours" text;

alter table "public"."client_campaigns" add column "cg_campaign_id" text;

alter table "public"."client_campaigns" add column "cg_concurrency" numeric;

alter table "public"."client_campaigns" add column "cg_created_at" text;

alter table "public"."client_campaigns" add column "cg_daily_cap" numeric;

alter table "public"."client_campaigns" add column "cg_dest_rate" numeric;

alter table "public"."client_campaigns" add column "cg_destinations" text;

alter table "public"."client_campaigns" add column "cg_did" text;

alter table "public"."client_campaigns" add column "cg_settings_synced_at" timestamp with time zone;

alter table "public"."client_campaigns" add column "cg_states" text;

alter table "public"."client_campaigns" add column "cg_status" text;

alter table "public"."client_campaigns" add column "crm_offer_id" text;

alter table "public"."client_campaigns" alter column "billing_frequency" set default 'weekly'::text;

alter table "public"."client_campaigns" alter column "net_terms" set default 7;

alter table "public"."clients" add column "crm_company_id" text;

alter table "public"."notification_preferences" add column "alert_buyer_conversion" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_deadair" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_losing_lane" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_nontv" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_noroute" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_promise" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_pub_share" boolean not null default true;

alter table "public"."notification_preferences" add column "alert_transfer" boolean not null default true;

alter table "public"."ping_bids" add column "has_bid" boolean not null default true;

alter table "public"."publisher_campaigns" add column "callgrid_campaign_name" text;

alter table "public"."publisher_campaigns" add column "cg_campaign_id" text;

alter table "public"."publisher_campaigns" add column "cg_created_at" text;

alter table "public"."publisher_campaigns" add column "cg_status" text;

alter table "public"."publisher_campaigns" alter column "billing_frequency" set default 'monthly'::text;

alter table "public"."publisher_campaigns" alter column "net_terms" set default 30;

alter table "public"."publishers" add column "crm_company_id" text;

alter table "public"."tv_creatives" add column "assigned_phone" text;

alter table "public"."tv_creatives" add column "drive_file_id" text;

alter table "public"."tv_creatives" add column "live_date" date;

alter table "public"."tv_creatives" add column "old_name" text;

CREATE UNIQUE INDEX alert_outbox_dedupe_key_key ON public.alert_outbox USING btree (dedupe_key);

CREATE UNIQUE INDEX alert_outbox_pkey ON public.alert_outbox USING btree (id);

CREATE INDEX callgrid_calls_date_idx2 ON public.callgrid_calls USING btree (date);

CREATE UNIQUE INDEX callgrid_campaigns_mirror_pkey ON public.callgrid_campaigns_mirror USING btree (id);

CREATE UNIQUE INDEX callgrid_destinations_pkey ON public.callgrid_destinations USING btree (id);

CREATE UNIQUE INDEX client_campaigns_crm_offer_id_key ON public.client_campaigns USING btree (crm_offer_id) WHERE (crm_offer_id IS NOT NULL);

CREATE UNIQUE INDEX clients_crm_company_id_key ON public.clients USING btree (crm_company_id) WHERE (crm_company_id IS NOT NULL);

CREATE UNIQUE INDEX creative_week_stats_creative_id_week_start_key ON public.creative_week_stats USING btree (creative_id, week_start);

CREATE UNIQUE INDEX creative_week_stats_pkey ON public.creative_week_stats USING btree (id);

CREATE INDEX crm_dids_did_idx ON public.crm_dids USING btree (did);

CREATE UNIQUE INDEX crm_dids_pkey ON public.crm_dids USING btree (crm_id);

CREATE UNIQUE INDEX crm_meta_pkey ON public.crm_meta USING btree (key);

CREATE INDEX idx_alert_outbox_status ON public.alert_outbox USING btree (status);

CREATE INDEX idx_call_analysis_source_synced ON public.call_analysis USING btree (source, synced_at);

CREATE INDEX idx_callgrid_calls_status ON public.callgrid_calls USING btree (date, call_status);

CREATE UNIQUE INDEX idx_cg_totals_pub_date_name_nopc ON public.callgrid_daily_totals_pub USING btree (date, callgrid_publisher_name) WHERE (publisher_campaign_id IS NULL);

CREATE UNIQUE INDEX idx_cg_totals_pub_date_pc ON public.callgrid_daily_totals_pub USING btree (date, publisher_campaign_id) WHERE (publisher_campaign_id IS NOT NULL);

CREATE INDEX idx_cgcalls_cgcamp ON public.callgrid_calls USING btree (cg_campaign_id);

CREATE INDEX idx_ob_campaigns_account ON public.ob_campaigns USING btree (account_crm_id);

CREATE INDEX idx_ob_campaigns_side ON public.ob_campaigns USING btree (side);

CREATE INDEX idx_ob_contracts_account ON public.ob_contracts USING btree (account_crm_id);

CREATE INDEX idx_ob_contracts_type ON public.ob_contracts USING btree (document_type, status);

CREATE INDEX idx_ob_history_account ON public.onboarding_history USING btree (account_crm_id);

CREATE INDEX idx_ob_history_completed ON public.onboarding_history USING btree (completed_at DESC);

CREATE INDEX idx_ob_overrides_lookup ON public.ob_overrides USING btree (record_type, crm_id, field) WHERE active;

CREATE INDEX idx_obal_agreement ON public.ob_agreement_links USING btree (agreement_crm_id);

CREATE INDEX idx_obal_buyer ON public.ob_agreement_links USING btree (buyer_campaign_crm_id);

CREATE INDEX idx_obal_pub ON public.ob_agreement_links USING btree (publisher_campaign_crm_id);

CREATE INDEX idx_obcm_buyer ON public.ob_campaign_matches USING btree (buyer_campaign_crm_id);

CREATE INDEX idx_obcm_pub ON public.ob_campaign_matches USING btree (publisher_campaign_crm_id);

CREATE INDEX idx_obcm_stage ON public.ob_campaign_matches USING btree (match_stage);

CREATE INDEX idx_ping_bids_buyer ON public.ping_bids USING btree (buyer_name);

CREATE INDEX idx_ping_bids_date ON public.ping_bids USING btree (date);

CREATE INDEX idx_ping_bids_dest ON public.ping_bids USING btree (destination_name);

CREATE INDEX idx_ping_bids_hasbid ON public.ping_bids USING btree (has_bid, date);

CREATE INDEX idx_ping_bids_source ON public.ping_bids USING btree (source_name);

CREATE INDEX idx_ping_bids_ts ON public.ping_bids USING btree (ts DESC);

CREATE INDEX idx_roku_cr_tv ON public.roku_creative_stats USING btree (tv_creative_id, date);

CREATE INDEX idx_sales_msa_open ON public.sales_msa_actions USING btree (company_name) WHERE (resolved_at IS NULL);

CREATE INDEX idx_sales_opp_events ON public.sales_opp_events USING btree (opp_id, at DESC);

CREATE INDEX idx_sales_opps_account ON public.sales_opportunities USING btree (account_crm_id);

CREATE INDEX idx_sales_opps_prospect ON public.sales_opportunities USING btree (prospect_crm_id);

CREATE INDEX idx_sales_opps_stage ON public.sales_opportunities USING btree (stage);

CREATE UNIQUE INDEX launch_notes_pkey ON public.launch_notes USING btree (key);

CREATE UNIQUE INDEX notification_prefs_pkey ON public.notification_prefs USING btree (email, kind);

CREATE UNIQUE INDEX ob_accounts_pkey ON public.ob_accounts USING btree (crm_id);

CREATE UNIQUE INDEX ob_agreement_links_pkey ON public.ob_agreement_links USING btree (crm_id);

CREATE UNIQUE INDEX ob_campaign_matches_pkey ON public.ob_campaign_matches USING btree (crm_id);

CREATE UNIQUE INDEX ob_campaigns_pkey ON public.ob_campaigns USING btree (crm_id);

CREATE UNIQUE INDEX ob_contracts_pkey ON public.ob_contracts USING btree (crm_id);

CREATE UNIQUE INDEX ob_field_meta_pkey ON public.ob_field_meta USING btree (module, api_name);

CREATE UNIQUE INDEX ob_overrides_pkey ON public.ob_overrides USING btree (id);

CREATE UNIQUE INDEX ob_prospects_pkey ON public.ob_prospects USING btree (crm_id);

CREATE UNIQUE INDEX onboarding_history_pkey ON public.onboarding_history USING btree (id);

CREATE UNIQUE INDEX onboarding_history_unique_key_key ON public.onboarding_history USING btree (unique_key);

CREATE UNIQUE INDEX roku_campaigns_pkey ON public.roku_campaigns USING btree (uid);

CREATE UNIQUE INDEX roku_creative_stats_pkey ON public.roku_creative_stats USING btree (date, creative_id);

CREATE UNIQUE INDEX roku_daily_stats_pkey ON public.roku_daily_stats USING btree (campaign_uid, date);

CREATE UNIQUE INDEX sales_msa_actions_pkey ON public.sales_msa_actions USING btree (id);

CREATE UNIQUE INDEX sales_opp_events_pkey ON public.sales_opp_events USING btree (id);

CREATE UNIQUE INDEX sales_opportunities_pkey ON public.sales_opportunities USING btree (id);

CREATE UNIQUE INDEX sales_views_pkey ON public.sales_views USING btree (id);

alter table "public"."alert_outbox" add constraint "alert_outbox_pkey" PRIMARY KEY using index "alert_outbox_pkey";

alter table "public"."callgrid_campaigns_mirror" add constraint "callgrid_campaigns_mirror_pkey" PRIMARY KEY using index "callgrid_campaigns_mirror_pkey";

alter table "public"."callgrid_destinations" add constraint "callgrid_destinations_pkey" PRIMARY KEY using index "callgrid_destinations_pkey";

alter table "public"."creative_week_stats" add constraint "creative_week_stats_pkey" PRIMARY KEY using index "creative_week_stats_pkey";

alter table "public"."crm_dids" add constraint "crm_dids_pkey" PRIMARY KEY using index "crm_dids_pkey";

alter table "public"."crm_meta" add constraint "crm_meta_pkey" PRIMARY KEY using index "crm_meta_pkey";

alter table "public"."launch_notes" add constraint "launch_notes_pkey" PRIMARY KEY using index "launch_notes_pkey";

alter table "public"."notification_prefs" add constraint "notification_prefs_pkey" PRIMARY KEY using index "notification_prefs_pkey";

alter table "public"."ob_accounts" add constraint "ob_accounts_pkey" PRIMARY KEY using index "ob_accounts_pkey";

alter table "public"."ob_agreement_links" add constraint "ob_agreement_links_pkey" PRIMARY KEY using index "ob_agreement_links_pkey";

alter table "public"."ob_campaign_matches" add constraint "ob_campaign_matches_pkey" PRIMARY KEY using index "ob_campaign_matches_pkey";

alter table "public"."ob_campaigns" add constraint "ob_campaigns_pkey" PRIMARY KEY using index "ob_campaigns_pkey";

alter table "public"."ob_contracts" add constraint "ob_contracts_pkey" PRIMARY KEY using index "ob_contracts_pkey";

alter table "public"."ob_field_meta" add constraint "ob_field_meta_pkey" PRIMARY KEY using index "ob_field_meta_pkey";

alter table "public"."ob_overrides" add constraint "ob_overrides_pkey" PRIMARY KEY using index "ob_overrides_pkey";

alter table "public"."ob_prospects" add constraint "ob_prospects_pkey" PRIMARY KEY using index "ob_prospects_pkey";

alter table "public"."onboarding_history" add constraint "onboarding_history_pkey" PRIMARY KEY using index "onboarding_history_pkey";

alter table "public"."roku_campaigns" add constraint "roku_campaigns_pkey" PRIMARY KEY using index "roku_campaigns_pkey";

alter table "public"."roku_creative_stats" add constraint "roku_creative_stats_pkey" PRIMARY KEY using index "roku_creative_stats_pkey";

alter table "public"."roku_daily_stats" add constraint "roku_daily_stats_pkey" PRIMARY KEY using index "roku_daily_stats_pkey";

alter table "public"."sales_msa_actions" add constraint "sales_msa_actions_pkey" PRIMARY KEY using index "sales_msa_actions_pkey";

alter table "public"."sales_opp_events" add constraint "sales_opp_events_pkey" PRIMARY KEY using index "sales_opp_events_pkey";

alter table "public"."sales_opportunities" add constraint "sales_opportunities_pkey" PRIMARY KEY using index "sales_opportunities_pkey";

alter table "public"."sales_views" add constraint "sales_views_pkey" PRIMARY KEY using index "sales_views_pkey";

alter table "public"."alert_outbox" add constraint "alert_outbox_dedupe_key_key" UNIQUE using index "alert_outbox_dedupe_key_key";

alter table "public"."creative_week_stats" add constraint "creative_week_stats_creative_id_fkey" FOREIGN KEY (creative_id) REFERENCES tv_creatives(id) ON DELETE CASCADE not valid;

alter table "public"."creative_week_stats" validate constraint "creative_week_stats_creative_id_fkey";

alter table "public"."creative_week_stats" add constraint "creative_week_stats_creative_id_week_start_key" UNIQUE using index "creative_week_stats_creative_id_week_start_key";

alter table "public"."onboarding_history" add constraint "onboarding_history_unique_key_key" UNIQUE using index "onboarding_history_unique_key_key";

alter table "public"."sales_opp_events" add constraint "sales_opp_events_opp_id_fkey" FOREIGN KEY (opp_id) REFERENCES sales_opportunities(id) ON DELETE CASCADE not valid;

alter table "public"."sales_opp_events" validate constraint "sales_opp_events_opp_id_fkey";

alter table "public"."alert_rules" add constraint "alert_rules_metric_check" CHECK ((metric = ANY (ARRAY['buyer_accept_rate'::text, 'publisher_pace'::text, 'rpc_drop'::text, 'low_billable_pct'::text, 'volume_drop'::text, 'overdue_invoices'::text, 'launch_no_calls'::text, 'no_route_spike'::text, 'pub_share_behind'::text, 'buyer_conversion'::text, 'losing_lane'::text, 'nontv_source'::text, 'ad_promise'::text, 'transfer_inbound'::text, 'dead_air_insight'::text]))) not valid;

alter table "public"."alert_rules" validate constraint "alert_rules_metric_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.nyala_attribute_calls(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lo date := coalesce(p_from, (select min(date) from callgrid_calls));
  hi date := coalesce(p_to,   (select max(date) from callgrid_calls));
  n_changed int := 0;
  n_attr int := 0;
  n_unattr int := 0;
begin
  if lo is null then return jsonb_build_object('changed',0,'attributed',0,'unattributed',0); end if;

  with did as (
    select crm_id, did, buyer_offer_crm_id, start_date, end_date
    from crm_dids where did ~ '^\d{10}$'
  ),
  cand as (
    select c.id as call_id, d.crm_id as did_id, d.buyer_offer_crm_id,
           row_number() over (partition by c.id order by d.start_date desc nulls last, d.crm_id) as rn
    from callgrid_calls c
    join did d on right(regexp_replace(coalesce(c.destination_number,''),'\D','','g'),10) = d.did
              and (d.start_date is null or c.date >= d.start_date)
              and (d.end_date   is null or c.date <= d.end_date)
    where c.date between lo and hi
  ),
  attr as (
    select c.id,
           p.did_id,
           o.crm_id as offer_id,
           cc.id as cc_id,
           coalesce(cl.name, o.account_name) as buyer_name,
           (coalesce(c.connected,false)
             and coalesce(o.rate,0) > 0
             and (coalesce(o.billable_duration,0) = 0 or coalesce(c.call_length_seconds,0) >= o.billable_duration)) as earns,
           coalesce(o.rate,0) as rate
    from callgrid_calls c
    left join cand p on p.call_id = c.id and p.rn = 1
    left join ob_campaigns o on o.crm_id = p.buyer_offer_crm_id and o.side = 'buyer'
    left join client_campaigns cc on cc.crm_offer_id = o.crm_id
    left join clients cl on cl.id = cc.client_id
    where c.date between lo and hi
  ),
  upd as (
    update callgrid_calls c set
      did_crm_id         = a.did_id,
      buyer_offer_crm_id = a.offer_id,
      client_campaign_id = a.cc_id,
      target_name        = a.buyer_name,
      revenue            = case when a.earns then a.rate else 0 end,
      billable           = coalesce(a.earns,false)
    from attr a
    where a.id = c.id
      and (c.did_crm_id is distinct from a.did_id
        or c.buyer_offer_crm_id is distinct from a.offer_id
        or c.client_campaign_id is distinct from a.cc_id
        or c.target_name is distinct from a.buyer_name
        or c.revenue is distinct from (case when a.earns then a.rate else 0 end)
        or c.billable is distinct from coalesce(a.earns,false))
    returning 1
  )
  select count(*) into n_changed from upd;

  select count(*) filter (where buyer_offer_crm_id is not null),
         count(*) filter (where buyer_offer_crm_id is null)
    into n_attr, n_unattr
  from callgrid_calls where date between lo and hi;

  -- client-side daily totals for the window (pub-side totals don't depend on
  -- attribution; callgrid-sync still writes those)
  delete from callgrid_daily_totals where date between lo and hi;
  insert into callgrid_daily_totals (date, callgrid_campaign_name, client_campaign_id, total_calls, billable_calls)
  select date, coalesce(min(campaign_name),''), client_campaign_id,
         count(*) filter (where connected), count(*) filter (where billable)
  from callgrid_calls
  where date between lo and hi
  group by date, client_campaign_id, case when client_campaign_id is null then campaign_name end;

  -- keep Configuration's linked publishers current from observed traffic
  insert into campaign_links (client_campaign_id, publisher_campaign_id)
  select distinct client_campaign_id, publisher_campaign_id
  from callgrid_calls
  where date between lo and hi and client_campaign_id is not null and publisher_campaign_id is not null
  on conflict (client_campaign_id, publisher_campaign_id) do nothing;

  perform rebuild_callgrid_actuals();

  return jsonb_build_object('from',lo,'to',hi,'changed',n_changed,'attributed',n_attr,'unattributed',n_unattr);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rebuild_callgrid_actuals()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  DELETE FROM actuals WHERE source = 'callgrid';

  -- Matched calls aggregate by campaign ID, so a CallGrid rename mid-day
  -- (two stamped names, one campaign) stays ONE row. The stamped name only
  -- identifies a group when the call matched no campaign at all.
  INSERT INTO actuals (date, client, client_id, campaign, client_campaign_id, calls, revenue, source, callgrid_id)
  SELECT
    r.date,
    cl.name AS client,
    cc.client_id,
    COALESCE(cc.name, MIN(r.campaign_name)) AS campaign,
    r.client_campaign_id,
    COUNT(*) AS calls,
    SUM(r.revenue) AS revenue,
    'callgrid' AS source,
    r.date || '__' || COALESCE(r.client_campaign_id::text, MIN(r.campaign_name)) AS callgrid_id
  FROM callgrid_calls r
  LEFT JOIN client_campaigns cc ON cc.id = r.client_campaign_id
  LEFT JOIN clients cl ON cl.id = cc.client_id
  WHERE r.revenue > 0
  GROUP BY r.date, r.client_campaign_id,
    CASE WHEN r.client_campaign_id IS NULL THEN r.campaign_name END,
    cc.name, cc.client_id, cl.name;
END;
$function$
;

create policy "staff read alert_outbox"
on "public"."alert_outbox"
as permissive
for select
to authenticated
using (true);


create policy "staff_read_cgcamp"
on "public"."callgrid_campaigns_mirror"
as permissive
for select
to authenticated
using (true);


create policy "staff_read_dest"
on "public"."callgrid_destinations"
as permissive
for select
to authenticated
using (true);


create policy "staff all creative_week_stats"
on "public"."creative_week_stats"
as permissive
for all
to authenticated
using (true)
with check (true);


create policy "staff_read"
on "public"."crm_dids"
as permissive
for select
to authenticated
using (is_staff());


create policy "staff_read"
on "public"."crm_meta"
as permissive
for select
to authenticated
using (is_staff());


create policy "staff all launch_notes"
on "public"."launch_notes"
as permissive
for all
to authenticated
using (true)
with check (true);


create policy "own delete notification_prefs"
on "public"."notification_prefs"
as permissive
for delete
to authenticated
using ((lower(email) = lower((auth.jwt() ->> 'email'::text))));


create policy "own insert notification_prefs"
on "public"."notification_prefs"
as permissive
for insert
to authenticated
with check ((lower(email) = lower((auth.jwt() ->> 'email'::text))));


create policy "own update notification_prefs"
on "public"."notification_prefs"
as permissive
for update
to authenticated
using ((lower(email) = lower((auth.jwt() ->> 'email'::text))))
with check ((lower(email) = lower((auth.jwt() ->> 'email'::text))));


create policy "staff read notification_prefs"
on "public"."notification_prefs"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_accounts"
on "public"."ob_accounts"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_agreement_links"
on "public"."ob_agreement_links"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_campaign_matches"
on "public"."ob_campaign_matches"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_campaigns"
on "public"."ob_campaigns"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_contracts"
on "public"."ob_contracts"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_field_meta"
on "public"."ob_field_meta"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_overrides"
on "public"."ob_overrides"
as permissive
for select
to authenticated
using (true);


create policy "staff update ob_overrides"
on "public"."ob_overrides"
as permissive
for update
to authenticated
using (true);


create policy "staff write ob_overrides"
on "public"."ob_overrides"
as permissive
for insert
to authenticated
with check (true);


create policy "staff read ob_prospects"
on "public"."ob_prospects"
as permissive
for select
to authenticated
using (true);


create policy "staff read ob_history"
on "public"."onboarding_history"
as permissive
for select
to authenticated
using (true);


create policy "staff reopen ob_history"
on "public"."onboarding_history"
as permissive
for update
to authenticated
using (true)
with check (true);


create policy "staff read roku_campaigns"
on "public"."roku_campaigns"
as permissive
for select
to authenticated
using (true);


create policy "staff update roku_campaigns"
on "public"."roku_campaigns"
as permissive
for update
to authenticated
using (true)
with check (true);


create policy "staff read roku_creative_stats"
on "public"."roku_creative_stats"
as permissive
for select
to authenticated
using (true);


create policy "staff read roku_daily_stats"
on "public"."roku_daily_stats"
as permissive
for select
to authenticated
using (true);


create policy "staff all sales_msa_actions"
on "public"."sales_msa_actions"
as permissive
for all
to authenticated
using (true)
with check (true);


create policy "staff all sales_opp_events"
on "public"."sales_opp_events"
as permissive
for all
to authenticated
using (true)
with check (true);


create policy "staff all sales_opportunities"
on "public"."sales_opportunities"
as permissive
for all
to authenticated
using (true)
with check (true);


create policy "staff all sales_views"
on "public"."sales_views"
as permissive
for all
to authenticated
using (true)
with check (true);




-- ── Data cleanup: "Nyala Health" ─────────────────────────────────────────
-- In the partner's CallGrid, "Nyala Health" is Nyala itself (the buyer on
-- every call), so the old sync wrongly created it as a client with three
-- campaigns. Under the new model, buyers come from HubSpot and calls are
-- attributed by DID. Remove those auto-created records unless something
-- billed against them (then just deactivate, so invoices keep their links).
do $$
declare v_client uuid; v_ccs uuid[];
begin
  for v_client in select id from public.clients where lower(trim(name)) = 'nyala health' and crm_company_id is null loop
    select coalesce(array_agg(id), '{}') into v_ccs from public.client_campaigns where client_id = v_client;
    if exists (select 1 from public.ar_ledger where client_id = v_client or client_campaign_id = any(v_ccs))
       or exists (select 1 from public.tv_ar_ledger where client_id = v_client or client_campaign_id = any(v_ccs)) then
      update public.client_campaigns set active = false where id = any(v_ccs);
      raise notice 'Nyala Health has invoices; deactivated its campaigns instead of deleting';
    else
      update public.callgrid_calls set client_campaign_id = null, target_name = null where client_campaign_id = any(v_ccs);
      delete from public.actuals where client_id = v_client or client_campaign_id = any(v_ccs);
      delete from public.pub_actuals where client_campaign_id = any(v_ccs);
      delete from public.tv_campaign_clients where client_campaign_id = any(v_ccs);
      delete from public.client_campaigns where id = any(v_ccs);
      delete from public.clients where id = v_client;
      raise notice 'Removed auto-created client Nyala Health and % campaign(s)', coalesce(array_length(v_ccs,1),0);
    end if;
  end loop;
end $$;

commit;
