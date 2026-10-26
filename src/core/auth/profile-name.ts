// The name the sign-in provider gave the user (Supabase auth user_metadata: full_name, else name). An e-mail address is never a name, and the name is kept as the provider wrote it.
export function nameFromMetadata(metadata: unknown): string | null {
  const m = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  for (const key of ["full_name", "name"]) {
    const v = typeof m[key] === "string" ? m[key].trim() : "";
    if (v && v.length <= 200 && !v.includes("@")) return v;
  }
  return null;
}
