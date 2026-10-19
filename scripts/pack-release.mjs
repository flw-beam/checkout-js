#!/usr/bin/env node
//
// pack-release.mjs — build the release assets for every package in this
// repository, exactly as integrators download them.
//
// A release is one GitHub Release on this repository, tagged vX.Y.Z, with one
// tarball per package attached. Nothing is published to a registry. This
// script builds what a release carries and uploads nothing; the Release
// workflow attaches its output.
//
//   node scripts/pack-release.mjs
//
// Every package shares one version. A package pins the exact version of each
// sibling it depends on, so releasing them apart would leave an application
// holding two copies of the SDK. One version keeps "take them from the same
// release" true by construction.
//
// For each package, it:
//   - packs it with pnpm, which turns each workspace dependency into an exact
//     version;
//   - rewrites every dependency on a sibling to that sibling's asset URL on
//     this version's release. A bare version would send a package manager to
//     a registry for the sibling, where these packages are not published and
//     where anyone could publish the name; a URL makes one tarball install with
//     everything it needs, under npm, pnpm and yarn alike;
//   - repacks it with npm, keeping the file name npm gives a scoped package
//     (@flutterwavebnw/checkout-sdk becomes flutterwavebnw-checkout-sdk-X.Y.Z.tgz).
//     Package managers read a package's name from inside the tarball, so the
//     file name only has to be unique within the release.
//
// It refuses a package that is private, misnamed, unlicensed, or on a version
// the others are not, and a version CHANGELOG.md has no entry for.
//
// Output, in dist-release/:
//   *.tgz        one per package, to attach to the release
//   SHA256SUMS   the assets' digests, in the format `sha256sum -c` reads
//   notes.md     the release notes: the changelog entry, then how to install
//                and verify the assets
//
// Environment:
//   RELEASE_BASE_URL  where the assets are downloaded from (default: this
//                     repository's GitHub Releases); override it only to test
//                     installs against a local server
//   OUT               output directory (default: dist-release)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = '@flutterwavebnw/';
const NAME = /^@flutterwavebnw\/checkout-[a-z0-9]+(-[a-z0-9]+)*$/;

// Plain X.Y.Z only. A pre-release would need its own rules for which release a
// sibling URL points at; extend this deliberately if one is ever needed.
const VERSION = /^\d+\.\d+\.\d+$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// owner/name, from the root package.json, which is the one place this
// repository names itself.
function repository() {
  const url = readJson(join(root, 'package.json')).repository?.url ?? '';
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) fail(`the root package.json does not name a GitHub repository (repository.url is "${url}")`);
  return match[1];
}

function readPackages() {
  const base = join(root, 'packages');
  const packages = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => {
      const dir = join('packages', entry.name);
      const pkg = readJson(join(root, dir, 'package.json'));
      if (!NAME.test(pkg.name ?? '')) fail(`${dir} is named "${pkg.name}", not ${SCOPE}checkout-<role>`);
      if (pkg.private) fail(`${pkg.name} is private, and every package in this repository is released`);
      if (!pkg.license) fail(`${pkg.name} declares no license`);
      if (!existsSync(join(root, dir, 'LICENSE'))) fail(`${pkg.name} has no LICENSE file in ${dir}`);
      return { dir, name: pkg.name, version: pkg.version };
    });
  if (packages.length === 0) fail('there are no packages to release');
  return packages;
}

// The body of the `## X.Y.Z` entry in CHANGELOG.md, which becomes the top of
// the release notes. A release without one is refused, so every version
// arrives with a description of what changed.
function changelogEntry(version) {
  const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
  const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) fail(`CHANGELOG.md has no "## ${version}" entry`);
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) fail(`CHANGELOG.md's "## ${version}" entry is empty`);
  return body;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function notes({ entry, released, repo }) {
  const sdk = released.find((p) => p.name === `${SCOPE}checkout-sdk`) ?? released[0];
  return [
    entry,
    '',
    '## Install',
    '',
    'Every package installs from its URL with npm, pnpm, yarn or bun, and brings the',
    'packages it depends on from this same release:',
    '',
    '```bash',
    `npm install ${sdk.url}`,
    '```',
    '',
    '| Package | Asset |',
    '|---|---|',
    ...released.map((p) => `| \`${p.name}\` | ${p.url} |`),
    '',
    '## Verify',
    '',
    'Each asset carries a build provenance attestation from the workflow run that',
    'built it, and `SHA256SUMS` lists its digest:',
    '',
    '```bash',
    `gh attestation verify ${sdk.asset} --repo ${repo}`,
    'sha256sum -c SHA256SUMS --ignore-missing',
    '```',
    '',
  ].join('\n');
}

function pack() {
  const repo = repository();
  const packages = readPackages();
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size !== 1) {
    fail(`packages disagree on their version (${packages.map((p) => `${p.name} ${p.version}`).join(', ')})`);
  }
  const [version] = versions;
  if (!VERSION.test(version)) fail(`"${version}" is not a plain X.Y.Z version`);
  const entry = changelogEntry(version);

  const baseUrl = (process.env.RELEASE_BASE_URL ?? `https://github.com/${repo}/releases/download`).replace(/\/+$/, '');
  const out = resolve(root, process.env.OUT ?? 'dist-release');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // npm's file name for a scoped package: @scope/name becomes scope-name.
  const assetOf = (p) => `${p.name.slice(1).replace('/', '-')}-${version}.tgz`;
  const urlOf = (p) => `${baseUrl}/v${version}/${assetOf(p)}`;
  const byName = new Map(packages.map((p) => [p.name, p]));

  console.log(`release: building ${packages.length} packages at ${version}`);
  run('pnpm', ['-r', 'run', 'build'], { stdio: 'inherit' });

  for (const p of packages) {
    const scratch = mkdtempSync(join(tmpdir(), 'checkout-release-'));
    try {
      run('pnpm', ['pack', '--pack-destination', scratch], { cwd: join(root, p.dir) });
      const packed = readdirSync(scratch).find((file) => file.endsWith('.tgz'));
      if (!packed) fail(`pnpm pack produced no tarball for ${p.name}`);

      const stage = join(scratch, 'package');
      mkdirSync(stage);
      run('tar', ['-xzf', join(scratch, packed), '-C', stage, '--strip-components=1']);

      const file = join(stage, 'package.json');
      const manifest = readJson(file);
      for (const field of ['peerDependencies', 'optionalDependencies']) {
        const sibling = Object.keys(manifest[field] ?? {}).find((dep) => dep.startsWith(SCOPE));
        if (sibling) fail(`${p.name} names ${sibling} in ${field}; only dependencies can name a sibling`);
      }
      for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (spec.startsWith('workspace:')) fail(`${p.name} still names ${dep} as ${spec} after packing`);
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = byName.get(dep);
        if (!sibling) fail(`${p.name} depends on ${dep}, which this repository does not release`);
        if (spec !== version) fail(`${p.name} pins ${dep} at ${spec}, not ${version}`);
        manifest.dependencies[dep] = urlOf(sibling);
      }
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

      run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', out], { cwd: stage });
      if (!existsSync(join(out, assetOf(p)))) fail(`npm pack did not produce ${assetOf(p)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // Read back what was written: each tarball must carry the release version,
  // name its siblings by URLs that are assets of this release, and ship its
  // LICENSE.
  const urls = new Set(packages.map(urlOf));
  for (const p of packages) {
    const asset = join(out, assetOf(p));
    const manifest = JSON.parse(run('tar', ['-xzOf', asset, 'package/package.json']));
    if (manifest.name !== p.name || manifest.version !== version) {
      fail(`${assetOf(p)} carries ${manifest.name}@${manifest.version}, not ${p.name}@${version}`);
    }
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (dep.startsWith(SCOPE) && !urls.has(spec)) {
        fail(`${assetOf(p)} names ${dep} as ${spec}, which is not an asset of this release`);
      }
    }
    if (!run('tar', ['-tzf', asset]).split('\n').includes('package/LICENSE')) {
      fail(`${assetOf(p)} does not include its LICENSE`);
    }
  }

  const released = packages
    .map((p) => ({ name: p.name, asset: assetOf(p), url: urlOf(p), sha256: sha256(join(out, assetOf(p))) }))
    .sort((a, b) => a.asset.localeCompare(b.asset));
  writeFileSync(join(out, 'SHA256SUMS'), released.map((p) => `${p.sha256}  ${p.asset}\n`).join(''));
  writeFileSync(join(out, 'notes.md'), notes({ entry, released, repo }));

  const shown = relative(root, out).startsWith('..') ? out : relative(root, out);
  console.log(`release: ${shown} holds ${released.length} packages at ${version}`);
  for (const p of released) console.log(`  ${p.asset}`);
}

pack();
