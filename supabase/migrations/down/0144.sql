-- Down for 0144_entity_kinds_and_relations_open: the entity_kind enum, the closed relation list and the old checks come back, and the two entity columns go. It fails, loudly, if a kind or relation outside the old lists was minted since (those rows must be removed first).
CREATE TYPE public.entity_kind AS ENUM ('corridor', 'node', 'jurisdiction', 'organisation', 'asset', 'instrument', 'obligation', 'method', 'technology', 'signpost', 'person', 'material');
ALTER TABLE public.entities DROP CONSTRAINT entities_entity_level_organisation_only, DROP CONSTRAINT id_matches_kind, DROP CONSTRAINT entities_kind_shape;
ALTER TABLE public.entities ALTER COLUMN kind TYPE public.entity_kind USING kind::public.entity_kind;
ALTER TABLE public.entities
  ADD CONSTRAINT id_matches_kind CHECK (entity_id ~~ (('cl:'::text || (kind)::text) || ':%'::text)),
  ADD CONSTRAINT entities_entity_level_organisation_only CHECK (entity_level IS NULL OR kind = 'organisation'::public.entity_kind);
ALTER TABLE public.entities DROP CONSTRAINT entities_basis_with_method_check, DROP CONSTRAINT entities_basis_is_object_check, DROP COLUMN method_version, DROP COLUMN basis;
ALTER TABLE public.community_thread_entities DROP CONSTRAINT community_thread_entities_kind_shape;
ALTER TABLE public.community_thread_entities ALTER COLUMN entity_kind TYPE public.entity_kind USING entity_kind::public.entity_kind;
ALTER TABLE public.entity_relations DROP CONSTRAINT entity_relations_relation_shape;
ALTER TABLE public.entity_relations ADD CONSTRAINT entity_relations_relation_values CHECK (relation = ANY (ARRAY['group_of', 'legal_entity_of', 'operating_identity_of', 'feedstock_of', 'fuel_for_mode', 'competes_for_feedstock', 'shares_grid_zone', 'serves_hub', 'corridor_links', 'implements', 'amends', 'consignment_wide']));
