-- 0108 DATA migration: name the claim in each fact paragraph that already stands (R2f F7; register K:50, rule 20).
--
-- A fact card drew its tier and source link by comparing the card's text with every claim's text (containment): two claims with one text collided, a short claim attached to the wrong paragraph. The card now reads the claim by ID: a section
-- paragraph names its claim with `<!-- claim:<uuid> -->` on its own first line (an HTML comment, invisible in the render) and a paragraph with no marker draws no tier and no link. New paragraphs are marked by the grounding pass that has just
-- written their claims (src/core/brief/claim-marker.ts bindClaimMarkers). This file marks the paragraphs that stood BEFORE that, once. IT IS THE ONLY PLACE TEXT MATCHING EVER BINDS A CLAIM TO A PARAGRAPH AFTER THE GROUNDING PASS, AND IT RUNS ONCE:
-- for every section paragraph with no marker (blank paragraphs and record-grade `[slot]` lines excepted), the ONE FACT claim of the item whose text (24 characters or more) is verbatim in the paragraph by the database rule
-- (public.is_verbatim, 0106) is named; no match, or two or more different claims, names nothing. A paragraph is the text between blank lines; separators are kept byte for byte, so a section changes only by the marker lines added. The cards the old
-- containment rule linked wrongly (ambiguous text, first match) lose their link by design. The file prints the counts it marked and left unmarked, and its self-check prints the paragraphs marked and unmarked over the whole table.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (the fact model and the card read the marker) and is run after 0106; the CI schema job never commits it, it runs it once in a rolled-back transaction after the fixture named
-- below (rule 15: the SQL is proven to execute), and the assertions in scripts/ci/fixtures/data-0108-markers.assert.sql prove the rule on the same nine paragraphs tests/r2f/markers.test.ts runs through the JavaScript rule.
--
-- irreversible: UPDATE public.intelligence_item_sections SET content_md = regexp_replace(content_md, '(^|\n)[ \t]*<!--\s*claim:[0-9a-fA-F-]{36}\s*-->[ \t]*\r?\n', '\1', 'g') WHERE content_md LIKE '%<!-- claim:%'; the file only adds marker lines, so removing them returns every section to its text before the run (a marker the grounding pass wrote later goes with them, and the next grounding pass writes it again)

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0108-markers.sql

BEGIN;

DO $$
DECLARE
  s record;
  paras text[];
  seps text[];
  outs text;
  para text;
  hits uuid[];
  i integer;
  n_seps integer;
  v_marked integer := 0;
  v_unmarked integer := 0;
  v_already integer := 0;
  v_skipped integer := 0;
  v_changed integer := 0;
BEGIN
  FOR s IN SELECT id, item_id, content_md FROM public.intelligence_item_sections WHERE content_md IS NOT NULL AND btrim(content_md) <> '' ORDER BY item_id, id LOOP
    paras := regexp_split_to_array(s.content_md, '\n\s*\n');
    seps := ARRAY(SELECT m[1] FROM regexp_matches(s.content_md, '(\n\s*\n)', 'g') AS m);
    n_seps := coalesce(array_length(seps, 1), 0);
    outs := '';
    FOR i IN 1 .. coalesce(array_length(paras, 1), 0) LOOP
      para := paras[i];
      IF btrim(para, E' \t\r\n') <> '' THEN
        IF para ~ '^[ \t]*<!--\s*claim:[0-9a-fA-F-]{36}\s*-->' THEN
          v_already := v_already + 1;
        ELSIF para ~* '^\s*(-\s+)?\[[a-z0-9_]+\]' THEN
          v_skipped := v_skipped + 1;
        ELSE
          SELECT array_agg(DISTINCT c.id) INTO hits
            FROM public.section_claim_provenance c
           WHERE c.intelligence_item_id = s.item_id AND c.claim_kind = 'FACT'
             AND length(regexp_replace(c.claim_text, '^\s+|\s+$', '', 'g')) >= 24
             AND public.is_verbatim(para, c.claim_text);
          IF cardinality(hits) = 1 THEN
            para := '<!-- claim:' || hits[1]::text || E' -->\n' || para;
            v_marked := v_marked + 1;
          ELSE
            v_unmarked := v_unmarked + 1;
          END IF;
        END IF;
      END IF;
      outs := outs || para;
      IF i <= n_seps THEN outs := outs || seps[i]; END IF;
    END LOOP;
    IF outs IS DISTINCT FROM s.content_md THEN
      UPDATE public.intelligence_item_sections SET content_md = outs WHERE id = s.id;
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0108-claim-markers run: % paragraphs marked, % left unmarked (no claim or more than one), % already marked, % record-grade lines skipped, % sections changed', v_marked, v_unmarked, v_already, v_skipped, v_changed;
END $$;

-- Self-check 0108-claim-markers: over the whole table, every marker names a FACT claim of the item whose section carries it, no paragraph carries two, and the paragraphs marked and unmarked are counted and printed.
DO $$
DECLARE
  v_marked bigint;
  v_unmarked bigint;
  v_dangling bigint;
BEGIN
  SELECT count(*) FILTER (WHERE p ~ '^[ \t]*<!--\s*claim:'),
         count(*) FILTER (WHERE btrim(p, E' \t\r\n') <> '' AND p !~ '^[ \t]*<!--\s*claim:' AND p !~* '^\s*(-\s+)?\[[a-z0-9_]+\]')
    INTO v_marked, v_unmarked
    FROM public.intelligence_item_sections s, LATERAL regexp_split_to_table(coalesce(s.content_md, ''), '\n\s*\n') AS p;
  SELECT count(*) INTO v_dangling
    FROM public.intelligence_item_sections s, LATERAL regexp_matches(coalesce(s.content_md, ''), '<!-- claim:([0-9a-fA-F-]{36}) -->', 'g') AS m
   WHERE NOT EXISTS (SELECT 1 FROM public.section_claim_provenance c WHERE c.id = m[1]::uuid AND c.intelligence_item_id = s.item_id AND c.claim_kind = 'FACT');
  IF v_dangling > 0 THEN RAISE EXCEPTION '0108-claim-markers: % marker(s) name a claim that is not a FACT of their item', v_dangling; END IF;
  IF EXISTS (SELECT 1 FROM public.intelligence_item_sections s, LATERAL regexp_split_to_table(coalesce(s.content_md, ''), '\n\s*\n') AS p WHERE p ~ '<!-- claim:[0-9a-fA-F-]{36} -->[\s\S]*<!-- claim:[0-9a-fA-F-]{36} -->') THEN
    RAISE EXCEPTION '0108-claim-markers: a paragraph carries two markers';
  END IF;
  RAISE NOTICE '0108-claim-markers: % paragraphs marked, % paragraphs unmarked', v_marked, v_unmarked;
  RAISE NOTICE '0108-claim-markers OK';
END $$;

COMMIT;
