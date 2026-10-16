-- 0007 required slots, old migration 299 folded in (P2-S1, owed by register P1-14 mint.md ruling 3 and P1-11 schema.md section 8
-- "Rulings owed" 1: apply migration 299; the re-mint pass is P2-05's runtime, not SQL).
--
-- Old migration 299 (lane POP-PREP, 2026-09-03) was written, never applied: it adds the four slots the mint kit already
-- requires and the live table did not (market_signal and initiative: corridor_identity; research_finding:
-- evidence_agreement_signal and source_authority_signal). Insert-only, ON CONFLICT DO NOTHING against the table's UNIQUE
-- (item_type, slot_key), the convention of migrations 113, 126, 128 and 129. The baseline dump carries no rows of this table,
-- so on the empty CI database the four are the only rows; in production the other slots already exist and these join them.
--
-- SEQUENCE AT THE CUTOVER WINDOW (old 299's own, kept): validate_item_provenance criterion 5 re-evaluates on every write that
-- touches an item, so a verified item of these three types that carries no claim naming the new slot_key fails criterion 5 the
-- next time it is touched. The re-mint pass (P2-05, through the guarded mint path) writes those claims before or with the first
-- touch; the old self-check query, run just before this file, gives N, the number of verified items of these types that
-- carry no claim naming a new slot (its text is in old_repo/supabase/migrations/299_item_type_required_slots_wave3.sql).
-- Not applied to production before the cutover window.
--
-- Reversal: DELETE FROM item_type_required_slots WHERE item_type IN ('market_signal','initiative','research_finding') AND
-- slot_key IN ('corridor_identity','evidence_agreement_signal','source_authority_signal');

-- catalog: none

BEGIN;

INSERT INTO public.item_type_required_slots (item_type, slot_key, description)
VALUES
  ('market_signal', 'corridor_identity',
   'The UN/LOCODE origin-destination port pair and transport mode the signal names together (ADR-024 decision 4). Grounded by a verbatim span naming both ends and a mode together; GAP when the source names a lane without both ends and a mode stated together.'),
  ('initiative', 'corridor_identity',
   'The UN/LOCODE origin-destination port pair and transport mode the initiative names together (ADR-024 decision 4). Grounded by a verbatim span naming both ends and a mode together; GAP when the source names a lane without both ends and a mode stated together.'),
  ('research_finding', 'evidence_agreement_signal',
   'The source''s own language about how settled or contested the finding is (peer-reviewed, independently confirmed, disputed, preliminary; spec 03 section 4''s evidence-agreement score input). Grounded by a verbatim span; GAP when the source states no such signal.'),
  ('research_finding', 'source_authority_signal',
   'The source''s own language about who published or issued the finding (published by, issued by, a named journal, laboratory or standards body; spec 03 section 4''s source-authority score input). Grounded by a verbatim span; GAP when the source states no such signal.')
ON CONFLICT (item_type, slot_key) DO NOTHING;

-- Self-check 0007-slots: all four rows are present with a description; a second run adds none.
DO $$
DECLARE n int; before int;
BEGIN
  SELECT count(*) INTO n FROM public.item_type_required_slots
   WHERE (item_type, slot_key) IN (('market_signal', 'corridor_identity'), ('initiative', 'corridor_identity'),
                                   ('research_finding', 'evidence_agreement_signal'), ('research_finding', 'source_authority_signal'))
     AND coalesce(btrim(description), '') <> '';
  IF n <> 4 THEN RAISE EXCEPTION '0007-slots: expected 4 slot rows with a description, found %', n; END IF;
  SELECT count(*) INTO before FROM public.item_type_required_slots;
  INSERT INTO public.item_type_required_slots (item_type, slot_key, description) VALUES ('market_signal', 'corridor_identity', 'x')
    ON CONFLICT (item_type, slot_key) DO NOTHING;
  IF (SELECT count(*) FROM public.item_type_required_slots) <> before THEN RAISE EXCEPTION '0007-slots: a repeat insert added a row'; END IF;
  RAISE NOTICE '0007-slots OK';
END $$;

COMMIT;
