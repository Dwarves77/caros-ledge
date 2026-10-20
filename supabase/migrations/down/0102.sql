-- Down for 0102: the nine functions go.
DROP FUNCTION public.admin_set_source_switch(uuid, text, boolean, text);
DROP FUNCTION public.admin_set_flag_status(uuid, text, text);
DROP FUNCTION public.admin_resolve_brief_flag(uuid, text, text, text);
DROP FUNCTION public.admin_triage_rejection(uuid, text, text);
DROP FUNCTION public.admin_resolve_jurisdiction_review(uuid, text, text, text);
DROP FUNCTION public.admin_set_hold(boolean, text, date, boolean, text, text);
DROP FUNCTION public.admin_corpus_turn_preview(text, uuid);
DROP FUNCTION public.admin_request_corpus_turns(text, uuid, uuid, text);
DROP FUNCTION public.admin_require(text);
