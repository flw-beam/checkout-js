import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The browser entry must bundle for the browser, so nothing in its module graph
// may import a `node:*` builtin. The webhook verifier (node:crypto) is
// deliberately outside this graph — it lives only on the server entry. This
// reads the compiled output and fails if a node: specifier ever creeps in.
test('the browser entry module graph imports no node: builtins', () => {
  const graph = ['browser.js', 'browser-client.js', 'store.js', 'http.js', 'watch.js', 'errors.js', 'types.js'];
  for (const file of graph) {
    const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.ok(
      !/from\s+['"]node:/.test(source) && !/require\(['"]node:/.test(source),
      `${file} must not import a node: builtin (found one in the browser module graph)`,
    );
  }
});
