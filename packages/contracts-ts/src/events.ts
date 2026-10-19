// Curated event-payload aliases over the generated OpenAPI component schemas.
// NOT generated code — a thin, stable public surface so AsyncAPI consumers
// import clean names (e.g. `import type { Event } from
// '@flutterwavebnw/checkout-contracts/events'`) instead of reaching into `components`.
//
// The types themselves are single-sourced: the event payload schema
// (contracts/schemas/Event.json) is registered in the OpenAPI components, so
// openapi-typescript emits it once and both the REST client and these event
// aliases point at the same definition — they cannot drift.

import type { components } from './gen/rest.js';

type Schemas = components['schemas'];

/** Typed, signed event envelope emitted on every state transition. */
export type Event = Schemas['Event'];

/** The event catalog. */
export type EventType = Schemas['EventType'];
