// The one logger. The only file under src/ allowed to touch the console.
function logError(message: string, detail?: unknown): void {
  console.error(message, detail);
}

function logWarn(message: string, detail?: unknown): void {
  console.warn(message, detail);
}

export const log = { error: logError, warn: logWarn };
