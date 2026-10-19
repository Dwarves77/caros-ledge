// New in R2e (M3). Who may edit a group's settings, decided once: the route and the header both ask here (the route let the owner, an admin or a moderator in while the screen offered Settings to admins only). A moderator
// moderates posts; the owner is always an admin member of their group (create_group_for_self), so the admin role is the whole rule.
import type { GroupRole } from "./types";

export const canEditGroup = (role: GroupRole | null | undefined): boolean => role === "admin";
