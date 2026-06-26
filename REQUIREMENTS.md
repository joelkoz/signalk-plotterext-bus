# Requirements: signalk-plotterext-bus

The authoritative implementation spec for this package. The wire format
itself is documented in `README.md`; this file defines what the
implementation must guarantee. When the two disagree, fix the code or the
docs in the same change.

## 1. Scope

Reference implementation of the plotter extension message bus:

- A routing envelope and JSON-RPC 2.0 message layer over `postMessage`.
- Wildcard event subscription semantics.
- A host-side connection class (`HostConnection`) managing one extension
  iframe context.
- An extension-side client (`connectExtension` / `ExtensionClient`).

Out of scope: manifest discovery, widget layout, capability policy, and any
host UI — those belong to host applications and to the plotter extension
specification (proposed to `SignalK/signalk-server` under
`docs/develop/rest-api/proposed/`).

## 2. Wire protocol invariants

- Envelope: `{ bus: 'plotterExt/1', msg: <JSON-RPC 2.0 object> }`. Anything
  else arriving on the transport is silently ignored (other libraries also
  use `postMessage`).
- Calls are JSON-RPC requests with a fresh per-call `id` nonce. Responses
  carry `result` XOR `error`. Exactly one response per request.
- Events are JSON-RPC notifications (no `id`); the notification `method` is
  a dot-separated event name.
- Error objects: JSON-RPC reserved codes for protocol errors
  (`-32601` method not found, `-32602` invalid params, `-32603` internal);
  implementation-defined codes elsewhere, with a stable string identifier in
  `error.data.reason` for programmatic handling.
- Wildcards in subscription patterns: `*` matches exactly one name segment,
  `**` matches zero or more segments, including mid-pattern.

## 3. Connection establishment

- The extension sends the `bus.ready` notification immediately on connect
  and repeats it (default every 250 ms) until answered or a timeout
  (default 10 s) rejects the connect promise.
- The host answers every `bus.ready` with a `bus.handshake` notification
  carrying `{ host, hostVersion, apiVersion, capabilities, context }`.
- `context`: `{ kind: 'panel'|'widget'|'background', id, instanceId?,
  targetInstance?, targetWidget? }`. `instanceId` identifies a placed widget
  instance; `targetInstance`/`targetWidget` identify the widget a
  configuration panel was opened for.
- Either side may come up first; the retry loop makes load order irrelevant.

## 4. Host endpoint (`HostConnection`)

- Registers embedder-supplied method handlers plus the built-ins
  `events.subscribe` (`{ patterns: string[] } -> { subscriptionId }`) and
  `events.unsubscribe` (`{ subscriptionId } -> {}`); invalid params reject
  with `-32602`.
- `publish(eventName, params)` delivers a notification **only** when the
  context holds a matching subscription, and reports whether it delivered.
- Exposes the union of subscribed patterns and notifies the embedder on
  subscription changes (so upstream work can start/stop lazily).
- Method handler exceptions are converted to JSON-RPC error responses;
  `RpcError` passes through its code/reason/data, other errors map to
  `-32603` with their message.
- `close()` rejects all pending calls with `CONNECTION_CLOSED`, clears
  subscriptions, and detaches the transport.

## 5. Extension client (`ExtensionClient`)

- `call`, `notify`, and `subscribe(patterns, handler)` (which performs both
  local dispatch registration and the host-side `events.subscribe`, and
  returns an async unsubscribe that tears down both).
- `state.get(keys?, scope?)` / `state.set(values, scope?)` wrapping the
  host's `state.*` methods.
- `signalk.subscribe(paths, handler)`: subscribes to `sk.<path>` events
  *and* calls the host's `signalk.subscribe`; the unsubscribe function
  reverses both. `signalk.put(path, value)` wraps `signalk.put`.
- `route.*` (capability `routes`): typed wrappers over the host's live route
  edit-buffer methods. Current surface: `route.list()`, `route.create({ name?,
  points? })`, `route.get(routeId)`, `route.delete(routeId)`; mutations are
  followed via `route.**` events (`route.created`/`route.deleted`/`route.dirty`,
  with `route.dirty` the conformance-floor re-snapshot signal). Point ops,
  `route.replace`/`route.rename` and `route.save` extend this surface in later
  work. Authoritative method/event contract lives in the Plotter Extensions API
  spec ("Live route editing").
- Default transport posts to `window.parent` with target origin `'*'`,
  filtering received messages by peer source. Rationale: the host page's
  origin may legitimately differ from the extension asset origin (e.g. a
  host dev server embedding assets served by the Signal K server). The host
  side compensates by enforcing the extension frame's exact origin. This
  asymmetry is deliberate — do not "fix" it to same-origin.

## 6. Transports

- `windowPort(peer, { origin?, listenWindow? })`: window `postMessage`;
  drops messages whose `source` is not the peer or whose origin fails the
  check (unless `'*'`).
- `messagePort(port)`: browser or Node `MessagePort` (calls `start()` when
  present). This is what the tests use.
- Any object satisfying `{ post(data), listen(handler) -> unlisten }` is an
  acceptable custom transport.

## 7. Trust model

Install time is the trust decision (a Signal K plugin already runs
unrestricted on the server). The bus provides fault containment and
accident prevention, not adversarial isolation:

- Hosts validate method arguments and apply call timeouts.
- One misbehaving extension context must not break the host or other
  contexts.
- Handler exceptions on event dispatch are reported to the `onError`
  callback, never thrown across the bus.

## 8. Packaging

- npm package `signalk-plotterext-bus`, MIT, zero runtime dependencies.
- Entry points: `.` (everything), `./host`, `./extension`; ESM + CJS + type
  declarations, built with tsup from `src/`.
- TypeScript is a convenience, not a requirement, for consumers.

## 9. Test plan

Must stay covered (vitest, Node, no DOM):

- Wildcard matcher truth table (exact, `*`, trailing/mid `**`, mismatches).
- Codec: round-trip, foreign-traffic rejection, malformed JSON-RPC
  rejection, message-kind classification.
- RPC: result delivery, undefined->null results, method-not-found, error
  code/reason/data propagation, plain-exception wrapping, **concurrent
  same-method correlation**, timeout with pending-table cleanup,
  close-rejects-pending.
- Events: wildcard dispatch, local unsubscribe.
- Integration over a MessageChannel pair: handshake content, host-attaches-
  late, subscription-filtered publish, wildcard subscribe/unsubscribe,
  subscription-change notification, invalid subscribe params, state helper
  round-trip, signalk.subscribe event flow, signalk.put relay.
- `route.*` helper conformance: `routes` capability advertised,
  create→`route.created`→`route.get` round-trip, list/delete→`route.deleted`,
  `routes.unknownId` reason propagation, `route.dirty` delivery via `route.**`.
