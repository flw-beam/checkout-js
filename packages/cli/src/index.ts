// Public surface of the CLI package. The executable is bin.ts; this exports the
// pieces it is built from so they can be tested, and reused if someone wants the
// forwarding loop inside their own tooling.
export { listen, assertTestModeKey, resolveTarget } from './listen.js';
export type { ListenOptions, ListenResult, ForwardedEvent } from './listen.js';
export { run, parseArgs } from './cli.js';
