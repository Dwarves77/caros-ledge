// Next calls register() once when the server starts. It wires the cross-slice dependencies the handlers call and refuses to serve when a required one is unwired (IMP-026: a missing dep is a build defect, not a runtime degradation).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { wireAll } = await import("@/core/turn/wiring");
  wireAll();
}
