-- 0144 entity_kinds_and_relations_open: an entity's kind and a relation are open snake_case tokens, and a minted entity carries the quote that backs it (ENGINE-CORE-FIX-1, G3 minting; operator ruling 2026-10-26: no static entity lists).
-- change: entities.kind enum entity_kind becomes text (snake_case check), entities gain basis + method_version (the quote and the reader that minted it), entity_relations.relation's closed list becomes the snake_case check, community_thread_entities.entity_kind follows
--
-- Before: entities.kind was a 12-value enum and entity_relations.relation a closed list of 11 values, so the reader could file an organisation, a technology or a person but never mint a kind the platform had not listed, and a minted entity could not
-- say what text it came from (entity_refs and entity_relations carry basis + method_version; entities did not).
-- After: kind is text with CHECK (kind ~ '^[a-z][a-z0-9_]*$'); id_matches_kind keeps tying the id prefix to the kind text; entities_entity_level_organisation_only keeps its meaning on the text; basis jsonb and method_version text are paired by the same two checks
-- entity_refs carries (an object, or both null); relation is checked for the snake_case shape only. Every existing kind and relation keeps its text value: no row changes.
-- Dependents of the enum (enumerated on production before this file was written): entities.kind; community_thread_entities.entity_kind (0 rows); the checks id_matches_kind and entities_entity_level_organisation_only on entities; the index entities_kind_idx (rebuilt by the
-- column's type change); the body of create_thread(uuid,text,text,boolean,text[]) names the COLUMN entity_kind, not the type, and copies entities.kind into it (text to text now). No function takes or returns the type, no view reads it, no other column uses it, so the type is dropped.
--
-- Access: unchanged (entities_read stays, community_thread_entities policies do not name the column). Reversal: down/0144.sql restores the enum, the closed relation list and the old checks, and drops the two columns; it fails, loudly, if a kind or relation outside the old lists was minted since.

-- catalog: column, constraint, type

BEGIN;

ALTER TABLE public.entities
  ADD COLUMN basis jsonb,
  ADD COLUMN method_version text,
  ADD CONSTRAINT entities_basis_is_object_check CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object'),
  ADD CONSTRAINT entities_basis_with_method_check CHECK ((basis IS NULL) = (method_version IS NULL));

ALTER TABLE public.entities DROP CONSTRAINT entities_entity_level_organisation_only, DROP CONSTRAINT id_matches_kind;
ALTER TABLE public.entities ALTER COLUMN kind TYPE text USING kind::text;
ALTER TABLE public.entities
  ADD CONSTRAINT entities_kind_shape CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT id_matches_kind CHECK (entity_id LIKE 'cl:' || kind || ':%'),
  ADD CONSTRAINT entities_entity_level_organisation_only CHECK (entity_level IS NULL OR kind = 'organisation');

ALTER TABLE public.community_thread_entities ALTER COLUMN entity_kind TYPE text USING entity_kind::text;
ALTER TABLE public.community_thread_entities ADD CONSTRAINT community_thread_entities_kind_shape CHECK (entity_kind IS NULL OR entity_kind ~ '^[a-z][a-z0-9_]*$');

ALTER TABLE public.entity_relations DROP CONSTRAINT entity_relations_relation_values;
ALTER TABLE public.entity_relations ADD CONSTRAINT entity_relations_relation_shape CHECK (relation ~ '^[a-z][a-z0-9_]*$');

DROP TYPE public.entity_kind;

COMMENT ON COLUMN public.entities.basis IS 'Migration 0144. For an entity minted by the reader: { quote, capture_id }, the words of the held capture that name it. Null for a seeded entity; paired with method_version.';
COMMENT ON COLUMN public.entities.method_version IS 'Migration 0144. The reader version that minted the entity (reader@x.y.z); null for a seeded entity; paired with basis.';

-- Self-check 0144-entity-kinds-open: the shapes (text kind and relation, the new columns, the type gone, no row changed); the live tables read, not assumed (every existing kind and relation matches the new checks, every id still matches its kind, the
-- organisation-only level rule still holds); and the attacks on scratch copies of the real tables (temp tables made LIKE them, so the real CHECKs are attacked): a malformed kind, an id that does not match its kind, an entity_level on a non-organisation,
-- a basis with no method, a non-object basis and a malformed relation are each refused as check violations; a new snake_case kind and relation, and a minted entity with its basis, are accepted.
DO $$
DECLARE
  bad bigint; total bigint; kinds bigint;
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'entities' AND column_name = 'kind') <> 'text'
     OR (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'community_thread_entities' AND column_name = 'entity_kind') <> 'text' THEN
    RAISE EXCEPTION '0144-entity-kinds-open: kind or entity_kind is not text';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'entities' AND column_name IN ('basis', 'method_version')) <> 2 THEN
    RAISE EXCEPTION '0144-entity-kinds-open: entities lacks basis or method_version';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_kind' AND typnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION '0144-entity-kinds-open: the entity_kind type is still there';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.entities'::regclass AND conname IN ('entities_kind_shape', 'id_matches_kind', 'entities_entity_level_organisation_only', 'entities_basis_is_object_check', 'entities_basis_with_method_check') AND convalidated) <> 5
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_relations'::regclass AND conname = 'entity_relations_relation_shape' AND convalidated)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entity_relations'::regclass AND conname = 'entity_relations_relation_values') THEN
    RAISE EXCEPTION '0144-entity-kinds-open: a constraint is missing, unvalidated or left over';
  END IF;

  -- The live tables.
  SELECT count(*), count(DISTINCT kind), count(*) FILTER (WHERE kind !~ '^[a-z][a-z0-9_]*$' OR entity_id NOT LIKE 'cl:' || kind || ':%' OR (entity_level IS NOT NULL AND kind <> 'organisation')) INTO total, kinds, bad FROM public.entities;
  IF bad <> 0 THEN
    RAISE EXCEPTION '0144-entity-kinds-open: % of % live entities break a new check', bad, total;
  END IF;
  SELECT count(*) INTO bad FROM public.entity_relations WHERE relation !~ '^[a-z][a-z0-9_]*$';
  IF bad <> 0 THEN
    RAISE EXCEPTION '0144-entity-kinds-open: % live relation(s) break the shape check', bad;
  END IF;

  -- The attacks, on copies of the real tables' own constraints.
  CREATE TEMP TABLE selfcheck_0144_e (LIKE public.entities INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  CREATE TEMP TABLE selfcheck_0144_r (LIKE public.entity_relations INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  BEGIN INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name) VALUES ('cl:Bad Kind:0123456789abcdef', 'Bad Kind', 'x'); RAISE EXCEPTION '0144-entity-kinds-open: a malformed kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name) VALUES ('cl:material:0123456789abcdef', 'organisation', 'x'); RAISE EXCEPTION '0144-entity-kinds-open: an id that does not match its kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name, entity_level) VALUES ('cl:material:0123456789abcdef', 'material', 'x', 'group'); RAISE EXCEPTION '0144-entity-kinds-open: an entity_level on a non-organisation was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name, basis) VALUES ('cl:material:0123456789abcdef', 'material', 'x', '{"quote":"q"}'::jsonb); RAISE EXCEPTION '0144-entity-kinds-open: a basis with no method_version was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name, basis, method_version) VALUES ('cl:material:0123456789abcdef', 'material', 'x', '[1]'::jsonb, 'reader@1.0.0'); RAISE EXCEPTION '0144-entity-kinds-open: a non-object basis was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO selfcheck_0144_r (parent_entity_id, child_entity_id, relation, asserted_by) VALUES ('a', 'b', 'Not Snake', 'selfcheck'); RAISE EXCEPTION '0144-entity-kinds-open: a malformed relation was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO selfcheck_0144_e (entity_id, kind, canonical_name, basis, method_version) VALUES
    ('cl:vessel_class:0123456789abcdef', 'vessel_class', 'A new kind', '{"quote":"q","capture_id":"c"}'::jsonb, 'reader@1.0.0'),
    ('cl:organisation:fedcba9876543210', 'organisation', 'A seeded organisation', NULL, NULL);
  INSERT INTO selfcheck_0144_r (parent_entity_id, child_entity_id, relation, asserted_by) VALUES ('a', 'b', 'a_new_relation', 'selfcheck');
  IF (SELECT count(*) FROM selfcheck_0144_e) <> 2 OR (SELECT count(*) FROM selfcheck_0144_r) <> 1 THEN
    RAISE EXCEPTION '0144-entity-kinds-open: a valid row was not accepted';
  END IF;
  RAISE NOTICE '0144-entity-kinds-open OK';
END
$$;

COMMIT;
