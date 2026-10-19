// A real DOM for the components to mount into, installed before Vue is first
// imported: Vue's DOM renderer captures `document` when its module loads, so a
// test file imports this ahead of anything that pulls in Vue.
import { JSDOM } from 'jsdom';

export const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://shop.example/checkout',
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
for (const name of ['Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MutationObserver'] as const) {
  g[name] = dom.window[name];
}

/** Let queued promise callbacks — the runtime load, a store update — run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
