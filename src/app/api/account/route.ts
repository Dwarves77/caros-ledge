// New in R2e (M5): delete the signed-in member's own account.
import { DELETE as deleteAccount } from "@/features/auth/api/account";

export const DELETE = deleteAccount;
