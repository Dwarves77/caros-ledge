-- Down for 0096_workspace_category_lists: the two workspace lists go; the public lists are untouched.
DROP FUNCTION public.get_research_items(uuid);
DROP FUNCTION public.get_operations_items(uuid);
