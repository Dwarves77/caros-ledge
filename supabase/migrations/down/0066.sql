-- Down for 0066_profiles_email_lower_unique: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP INDEX public.profiles_email_lower_key;
CREATE INDEX profiles_email_lower_idx ON public.profiles USING btree (lower(email));
