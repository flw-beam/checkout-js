// @flutterwavebnw/checkout-contracts — TypeScript bindings generated from /contracts.
//
// `paths` / `operations` / `components` come from openapi-typescript over the
// bundled OpenAPI 3.1 spec; the event-payload aliases come from ./events.
// `apiIndex` is the documentation-facing description of the same spec — the one
// the docs surface, API explorer, llms.txt corpus, and MCP docs server read, so
// what they describe cannot drift from what the core serves.
// Never hand-edit ./gen — change /contracts and regenerate (pnpm gen). CI
// drift-checks the output (scripts/check-codegen-drift.sh).

export type { paths, operations, components } from './gen/rest.js';
export type {
  ApiAuth,
  ApiField,
  ApiIndex,
  ApiOperation,
  ApiParameter,
  ApiResponse,
  ApiSchema,
  ApiSecurityScheme,
  ApiTag,
} from './gen/api-index.js';
export { apiIndex } from './gen/api-index.js';
export type {
  Event,
  EventType,
} from './events.js';
