/** What a sign-in or reset failure says to the visitor. The auth service's own words name what is wrong (a wrong password, an unconfirmed address, a closed sign-up), which tells a stranger whether an address has an account; the page shows one of these two sentences and the raw message goes to the log. */
const SIGN_IN_INVALID = "That e-mail and password do not match.";
const SIGN_IN_UNAVAILABLE = "Sign-in is not available right now; try again in a minute.";

const AUTH_SENTENCES = { invalid: SIGN_IN_INVALID, unavailable: SIGN_IN_UNAVAILABLE } as const;

interface AuthFailure {
  message?: string | undefined;
  code?: string | undefined;
}

/** A wrong password, an unknown address and an unconfirmed address are one kind: the visitor cannot tell them apart. */
export function authSentence(failure: AuthFailure): string {
  const invalid = failure.code === "invalid_credentials" || failure.code === "email_not_confirmed" || /invalid login credentials|email not confirmed/i.test(failure.message ?? "");
  return AUTH_SENTENCES[invalid ? "invalid" : "unavailable"];
}

/** A sign-up the service refuses because the address has an account (it does so when e-mail confirmation is off): shown as a sent confirmation, like every other new address. */
export function isAlreadyRegistered(failure: AuthFailure): boolean {
  return failure.code === "user_already_exists" || /already registered/i.test(failure.message ?? "");
}
