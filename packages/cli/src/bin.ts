#!/usr/bin/env node
// The executable. A shim on purpose: everything it does lives in cli.ts, which
// imports without side effects so it can be tested.
import { run } from './cli.js';

process.exit(await run(process.argv.slice(2)));
