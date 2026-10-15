// The one logger. The only file under src/ allowed to touch the console.
export function logError(message: string, detail?: unknown): void {
  console.error(message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  console.warn(message, detail);
}
