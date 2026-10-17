// Resolves when everything written to `stream` so far has been handed to the OS. A CI script that prints a large result and then exits must await this first: on a pipe (Linux CI) stdout writes are
// asynchronous, and process.exit() cut the catalog snapshot short, which the catalog diff read as removed policies and triggers.
export const drained = (stream) => new Promise((resolve) => stream.write("", () => resolve()));
