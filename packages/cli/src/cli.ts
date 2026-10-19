// The flutterwavebnw-checkout command, as a function of its arguments.
//
// Kept separate from the executable so the whole command — parsing, validation,
// exit codes — is reachable from a test. Importing this module runs nothing.
//
// Argument parsing is hand-rolled rather than pulled from a dependency: the
// surface is one command with a few flags, and a CLI developers install is a
// place to keep the dependency count honest.
import { CheckoutClient } from '@flutterwavebnw/checkout-sdk';

import { assertTestModeKey, listen, resolveTarget } from './listen.js';

const USAGE = `flutterwavebnw-checkout — command-line tooling for Flutterwave Checkout

Usage:
  flutterwavebnw-checkout listen --forward-to <host:port/path> [options]

Forwards your test-mode events to a handler on this machine, so your webhook
code runs against genuine signed events while you build.

Options:
  --forward-to <target>   Where to POST each event. Required.
                          A bare host defaults to http, e.g. localhost:3000/webhooks
  --cursor <cursor>       Resume from a feed cursor instead of the oldest retained event
  --poll <ms>             Interval between feed polls (default 1000)
  --base-url <url>        Checkout API base URL (or set FLW_BASE_URL)
  -h, --help              Show this help

Environment:
  FLW_API_KEY    Your test-mode Dashboard API key (sk_test_...). Required.
  FLW_BASE_URL   Checkout API base URL, if --base-url is not given.

Note: this is a development tool. In production you receive events as webhooks,
which carry delivery retries and a delivery history; the feed this reads is for
building and reconciliation.
`;

interface Args {
  command?: string;
  forwardTo?: string;
  cursor?: string;
  poll?: number;
  baseUrl?: string;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { help: false };
  let i = 0;
  // A flag whose value is missing is an error rather than a silent undefined,
  // so `--forward-to` with nothing after it says so instead of failing later
  // with something less obvious.
  const value = (flag: string): string => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('-')) throw new Error(`${flag} expects a value`);
    return v;
  };

  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--forward-to':
        args.forwardTo = value(arg);
        break;
      case '--cursor':
        args.cursor = value(arg);
        break;
      case '--poll': {
        const raw = value(arg);
        const ms = Number(raw);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`--poll expects milliseconds, got "${raw}"`);
        args.poll = ms;
        break;
      }
      case '--base-url':
        args.baseUrl = value(arg);
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option "${arg}"`);
        if (args.command === undefined) args.command = arg;
        else throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return args;
}

export async function run(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${message(err)}\n\n${USAGE}`);
    return 2;
  }

  if (args.help || args.command === undefined) {
    process.stdout.write(USAGE);
    return args.command === undefined && !args.help ? 2 : 0;
  }
  if (args.command !== 'listen') {
    process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
    return 2;
  }
  if (!args.forwardTo) {
    process.stderr.write(`listen requires --forward-to\n\n${USAGE}`);
    return 2;
  }

  const apiKey = process.env.FLW_API_KEY;
  if (!apiKey) {
    process.stderr.write('FLW_API_KEY is not set. Export your test-mode key (sk_test_...).\n');
    return 2;
  }
  const baseUrl = args.baseUrl ?? process.env.FLW_BASE_URL;
  if (!baseUrl) {
    process.stderr.write('No API base URL. Pass --base-url or set FLW_BASE_URL.\n');
    return 2;
  }

  try {
    assertTestModeKey(apiKey);
  } catch (err) {
    process.stderr.write(`${message(err)}\n`);
    return 2;
  }

  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => controller.abort());
  }

  const client = new CheckoutClient({ apiKey, baseUrl });
  process.stdout.write(`listening for test-mode events, forwarding to ${resolveTarget(args.forwardTo)}\n`);

  try {
    const result = await listen({
      client,
      forwardTo: args.forwardTo,
      cursor: args.cursor,
      pollMs: args.poll,
      signal: controller.signal,
    });
    if (result.cursor) {
      process.stdout.write(`\nstopped. resume with --cursor ${result.cursor}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${message(err)}\n`);
    return 1;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
