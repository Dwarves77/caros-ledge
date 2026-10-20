-- Rollback-test fixture for 0105_data_demote_legacy_verification.sql: a member verified by the legacy corporate-email method (to be cleared), a member whose legacy mark is 'linkedin' (cleared), a member verified by the DNS proof (kept), and
-- two profiles, one with an http avatar (cleared) and one with an https avatar (kept). The 0103 checks are dropped inside the job's rolled-back transaction so the legacy rows can exist, as they do on production before the window.
ALTER TABLE public.community_member_profiles DROP CONSTRAINT community_member_profiles_verified_by_system;
ALTER TABLE public.profiles DROP CONSTRAINT profiles_avatar_url_https;
INSERT INTO auth.users (id, email) VALUES ('01050000-0000-4000-8000-000000000001', 'legacy-0105@invalid.example'), ('01050000-0000-4000-8000-000000000002', 'linkedin-0105@invalid.example'), ('01050000-0000-4000-8000-000000000003', 'dns-0105@invalid.example');
INSERT INTO public.profiles (id, email, avatar_url) VALUES ('01050000-0000-4000-8000-000000000001', 'legacy-0105@invalid.example', 'http://tracker.example/a.png'), ('01050000-0000-4000-8000-000000000002', 'linkedin-0105@invalid.example', NULL), ('01050000-0000-4000-8000-000000000003', 'dns-0105@invalid.example', 'https://img.example/a.png');
INSERT INTO public.community_member_profiles (user_id, org_type, verified, verified_at, verification_method, organisation_key) VALUES
  ('01050000-0000-4000-8000-000000000001', 'forwarder', true, now(), 'corporate-email', repeat('a', 64)),
  ('01050000-0000-4000-8000-000000000002', 'carrier', true, now(), 'linkedin', repeat('b', 64)),
  ('01050000-0000-4000-8000-000000000003', 'shipper', true, now(), 'domain-dns', repeat('c', 64));
