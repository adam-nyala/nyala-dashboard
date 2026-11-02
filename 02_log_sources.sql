-- Nyala patch: register the internal log sources used by alert-engine,
-- daily-brief (system 'alerts') and dispo-ingest (system 'dispo').
-- integration_log only accepts systems listed here. (Already folded into
-- 01_nyala_schema.sql for future rebuilds.)
insert into public.integration_systems (id, label, enabled) values
  ('alerts', 'Alerts & Daily Brief', true),
  ('dispo',  'Disposition Uploads',  true)
on conflict (id) do update set label = excluded.label, enabled = excluded.enabled;
