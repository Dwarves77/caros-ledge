-- Down for 0073: nothing to undo. The file changes no object (its fixtures roll back inside the file); the statement is a no-op so the schema job has a body to apply.
DO $$ BEGIN NULL; END $$;
