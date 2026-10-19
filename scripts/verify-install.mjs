#!/usr/bin/env node
//
// verify-install.mjs — install the release assets the way an integrator does,
// in an empty project, and prove they arrive whole.
//
//   node scripts/verify-install.mjs --local            pack for a local server and install from it
//   node scripts/verify-install.mjs --release X.Y.Z    install from this repository's published release
//   ... --client npm|pnpm                              one package manager (default: both)
//
// --local runs pack-release.mjs with its asset URLs pointed at a server this
// script starts, so the whole path, sibling URLs included, is exercised before
// anything is published. --release checks what is actually live.
//
// The project's .npmrc sends the package scope to an address nothing listens
// on. Every sibling must therefore arrive from its release URL: one looked up
// by name, on a registry where someone else could publish it, fails the
// install instead of passing quietly.
//
// It installs the packages no sibling depends on, plus the SDK itself, and then
// checks that:
//   - every package is installed exactly once, at the release's version, so an
//     application holds one copy of the SDK however many packages it uses;
//   - every entry point of every directly installed package imports;
//   - the React and Vue bindings share the SDK's session store rather than
//     carrying copies;
//   - the CLI runs.

import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@flutterwavebnw/';
const SDK = `${SCOPE}checkout-sdk`;
const DEAD_REGISTRY = 'http://127.0.0.1:9/';
const PEERS = ['react@^19', 'react-dom@^19', 'vue@^3.5'];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`verify-install: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

// For the installs, which fetch from the server this process runs: a
// synchronous child would block the event loop the server answers on.
function runAsync(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(`${command} ${args[0]} exited with ${code}`))));
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { clients: ['npm', 'pnpm'] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--local') args.local = true;
    else if (arg === '--release') args.release = argv[++i];
    else if (arg === '--client') args.clients = [argv[++i]];
    else fail(`unknown argument "${arg}"`);
  }
  if (Boolean(args.local) === Boolean(args.release)) fail('pass either --local or --release X.Y.Z');
  if (args.release && !/^\d+\.\d+\.\d+$/.test(args.release)) fail(`"${args.release}" is not an X.Y.Z version`);
  for (const client of args.clients) {
    if (client !== 'npm' && client !== 'pnpm') fail(`--client takes npm or pnpm, not "${client}"`);
  }
  return args;
}

// The packages in this repository, and which of them a sibling depends on.
function readPackages() {
  const base = join(root, 'packages');
  const packages = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => readJson(join(base, entry.name, 'package.json')));
  const depended = new Set(packages.flatMap((p) => Object.keys(p.dependencies ?? {})));
  return {
    names: packages.map((p) => p.name),
    version: packages[0].version,
    direct: packages.map((p) => p.name).filter((name) => !depended.has(name) || name === SDK),
  };
}

const assetOf = (name, version) => `${name.slice(1).replace('/', '-')}-${version}.tgz`;

function repository() {
  const url = readJson(join(root, 'package.json')).repository?.url ?? '';
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) fail(`the root package.json does not name a GitHub repository (repository.url is "${url}")`);
  return match[1];
}

// Serves /v<version>/<asset> from a directory, the shape of a GitHub Release
// download URL.
async function serve(dir, version) {
  const server = createServer((req, res) => {
    const match = (req.url ?? '').match(/^\/v([^/]+)\/([^/]+\.tgz)$/);
    const file = match && match[1] === version ? join(dir, basename(match[2])) : undefined;
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

// Every installed copy of a package in the scope, found by walking node_modules
// without following links, so a pnpm symlink and its target count once.
function installedCopies(dir, found = new Map()) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) continue;
    const manifest = join(path, 'package.json');
    if (existsSync(manifest) && dirname(dirname(path)).endsWith('node_modules') && basename(dirname(path)) === SCOPE.slice(0, -1)) {
      const { name, version } = readJson(manifest);
      found.set(name, [...(found.get(name) ?? []), version]);
    }
    installedCopies(path, found);
  }
  return found;
}

function smoke(project, direct) {
  const imports = [];
  for (const name of direct) {
    const manifest = readJson(join(project, 'node_modules', ...name.split('/'), 'package.json'));
    for (const key of Object.keys(manifest.exports ?? { '.': null })) imports.push(name + key.slice(1));
  }
  const lines = [
    "import assert from 'node:assert/strict';",
    ...imports.map((specifier, i) => `import * as m${i} from '${specifier}';`),
    `const loaded = { ${imports.map((specifier, i) => `'${specifier}': m${i}`).join(', ')} };`,
    `const store = loaded['${SDK}/browser']?.CheckoutSessionStore;`,
    `for (const binding of ['${SCOPE}checkout-react', '${SCOPE}checkout-vue']) {`,
    '  if (!loaded[binding] || !store) continue;',
    "  assert.equal(loaded[binding].CheckoutSessionStore, store, `${binding} carries its own copy of the SDK's session store`);",
    '}',
    `console.log('  imported ' + Object.keys(loaded).length + ' entry points');`,
  ];
  writeFileSync(join(project, 'smoke.mjs'), `${lines.join('\n')}\n`);
  run('node', ['smoke.mjs'], { cwd: project, stdio: 'inherit' });
}

async function verify({ client, base, version, packages, packageManager }) {
  console.log(`verify-install: ${client}, ${packages.direct.length} packages from ${base}/v${version}`);
  const project = mkdtempSync(join(tmpdir(), 'checkout-verify-'));
  try {
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'verify-install', version: '0.0.0', private: true, type: 'module', packageManager }, null, 2)}\n`,
    );
    writeFileSync(join(project, '.npmrc'), `${SCOPE.slice(0, -1)}:registry=${DEAD_REGISTRY}\n`);

    const urls = packages.direct.map((name) => `${base}/v${version}/${assetOf(name, version)}`);
    if (client === 'npm') {
      await runAsync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...urls, ...PEERS], {
        cwd: project,
      });
    } else {
      await runAsync('pnpm', ['add', '--ignore-scripts', '--reporter=append-only', ...urls, ...PEERS], { cwd: project });
    }

    const copies = installedCopies(join(project, 'node_modules'));
    for (const name of packages.names) {
      const versions = copies.get(name) ?? [];
      if (versions.length !== 1) fail(`${client} installed ${versions.length} copies of ${name} (${versions.join(', ') || 'none'})`);
      if (versions[0] !== version) fail(`${client} installed ${name}@${versions[0]}, not ${version}`);
    }
    console.log(`  one copy of each of ${packages.names.length} packages, all at ${version}`);

    smoke(project, packages.direct);

    const cli = join(project, 'node_modules', '.bin', 'flutterwavebnw-checkout');
    if (packages.names.includes(`${SCOPE}checkout-cli`)) {
      run(cli, ['--help'], { cwd: project });
      console.log('  flutterwavebnw-checkout --help ran');
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packages = readPackages();
  const { packageManager } = readJson(join(root, 'package.json'));

  let server;
  let assets;
  let base;
  let version;
  try {
    if (args.local) {
      version = packages.version;
      assets = mkdtempSync(join(tmpdir(), 'checkout-assets-'));
      server = await serve(assets, version);
      base = `http://127.0.0.1:${server.address().port}`;
      run('node', [join(root, 'scripts', 'pack-release.mjs')], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, RELEASE_BASE_URL: base, OUT: assets },
      });
    } else {
      version = args.release;
      base = `https://github.com/${repository()}/releases/download`;
    }
    for (const client of args.clients) await verify({ client, base, version, packages, packageManager });
    console.log(`verify-install: ${version} installs whole with ${args.clients.join(' and ')}`);
  } finally {
    server?.close();
    if (assets) rmSync(assets, { recursive: true, force: true });
  }
}

await main();
