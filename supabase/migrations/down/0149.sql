-- Down for 0149_agent_run_searches_transform: the index, the pair constraint and both columns go (the transform names are lost; the capture text stays).
DROP INDEX IF EXISTS public.agent_run_searches_transform_capture_uidx;
ALTER TABLE public.agent_run_searches DROP CONSTRAINT IF EXISTS agent_run_searches_transform_pair_check, DROP COLUMN IF EXISTS transform_version, DROP COLUMN IF EXISTS transform;
