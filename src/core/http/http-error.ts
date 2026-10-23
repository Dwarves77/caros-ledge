// The error class every route throws, in a module of its own so the parsers (and through them the client bundle) can import it without the telemetry wrapper in errors.ts (scripts/ci/checks/client-walk.mjs).
/** The one error shape: `{ error: string }` with a status. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** What the response body says. It is `message` unless a subclass holds a driver sentence back for the log. */
  readonly publicMessage: string;
  constructor(status: number, message: string, headers: Record<string, string> = {}, publicMessage?: string) {
    super(message);
    this.publicMessage = publicMessage ?? message;
    this.name = "HttpError";
    this.status = status;
    this.headers = headers;
  }
}
