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

- The caller sends the `bus.ready` notification immediately on connect
  and repeats it (default every 250 ms) until answered or a timeout
  (default 10 s) rejects the connect promise. The `bus.ready` payload is
  optional and additive: `{ id? }`, a caller-asserted context id.
- The host answers every `bus.ready` with a `bus.handshake` notification
  carrying `{ host, hostVersion, apiVersion, capabilities, context }`.
- `context`: `{ kind: 'panel'|'widget'|'background'|'embedding-host', id,
  instanceId?, targetInstance?, targetWidget? }`. `instanceId` identifies a
  placed widget instance; `targetInstance`/`targetWidget` identify the widget a
  configuration panel was opened for.
- **Caller id adoption.** A host constructed with `adoptCallerId: true` uses the
  `id` from the `bus.ready` payload as `context.id` (falling back to its own
  configured id when the caller sends none). This serves `embedding-host`
  connections, where the host does not know the caller in advance. The default
  is false: the host-configured `context.id` is authoritative and the payload is
  ignored (the standard extension case).
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
- `route.*` (capability `routes`): typed wrappers over the host's visible-route
  methods. Surface: `route.list()`, `route.create({ points (≥2),
  name?, description? })`, `route.show(ref)`, `route.get(routeId)`,
  `route.replace(routeId, points)`, `route.save(routeId, { name?, description?,
  dialog? })`, `route.hide(routeId)`, `route.delete(routeId)`. A route carries
  `saved` (backed by a stored resource) and `dirty` (pending unsaved changes)
  flags; mutations are followed via `route.**` events
  (`route.visible`/`route.dirty`/`route.saved`/`route.hidden`, with `route.dirty`
  the conformance-floor re-snapshot signal). Failures reject with a stable
  `error.data.reason` from `RouteErrorReason` (`routes.unknownId`/`badRef`/
  `badRequest`/`saveFailed`/`deleteFailed`/`saveCancelled`/`notSupported`
  — see the README "Route error reasons" table); a server-rejected persist is
  `routes.saveFailed`, distinct from the user-cancel `routes.saveCancelled`.
  Authoritative method/event contract lives in the Plotter Extensions API spec
  ("Live routes").
- `chart.*` (capability `charts`): typed wrappers over the host's chart-layer
  management — a lightweight facade, **not** a chart provider (no
  create/add/delete of sources). Surface: `chart.list()` → `ChartLayer[]` in
  display order (index 0 topmost), `chart.setVisibility(ids, visible)`,
  `chart.setOpacity(ids, opacity)`, `chart.setOrder(order)` (all batch;
  `setOrder` is host-clamped). Changes are followed via `chart.**` events
  (`chart.visibility`/`chart.opacity`/`chart.order`), emitted for every change
  regardless of origin (including the host's own chart controls). Failures reject
  with a stable `error.data.reason` from `ChartErrorReason`
  (`charts.unknownId`/`badRequest`/`notSupported` — see the README "Chart error
  reasons" table). Authoritative method/event contract lives in the Plotter
  Extensions API spec ("Chart layers").
- `nightMode.*` (capability `nightMode`): typed wrappers over the host's
  night-vision display state. Surface: `nightMode.get()` → `NightModeState`
  (`{ enabled, auto }`) and `nightMode.set({ enabled?, auto? })`. Three effective
  states — force on (`{ enabled: true }`), force off (`{ enabled: false }`),
  follow the server (`{ auto: true }`); setting `enabled` implies `auto: false`.
  Changes are followed via the `nightMode.changed` event (`NightModeChangedEvent`),
  emitted for every change regardless of origin (an extension's set, the host's own
  toggle, or the server's `environment.mode` flipping while `auto` is on). Failures
  reject with a stable `error.data.reason` from `NightModeErrorReason`
  (`nightMode.badRequest`/`notSupported`). Authoritative method/event contract lives
  in the Plotter Extensions API spec ("Night mode").
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
  create→`route.visible`→`route.get` round-trip, list, `route.show`,
  hide/delete→`route.hidden` (with `saved` reflecting the outcome),
  `route.save`→`route.saved`,
  `routes.unknownId`/`routes.badRequest`/`routes.badRef` reason propagation,
  `route.dirty` delivery via `route.**`.
- `chart.*` helper conformance: `charts` capability advertised, `chart.list`
  order + metadata, batch `chart.setVisibility` emitting one `chart.visibility`
  per *changed* chart, batch `chart.setOpacity`→`chart.opacity`,
  `chart.setOrder`→`chart.order` (new full order), `charts.unknownId` reason
  propagation, generic `call()` path.
- `nightMode.*` helper conformance: `nightMode` capability advertised,
  `nightMode.get` returns `{ enabled, auto }`, force on / force off (off wins
  even while `auto`+server say night), follow-server derives `enabled` from
  `environment.mode` and re-emits `nightMode.changed` on a server-mode flip,
  `nightMode.badRequest` on an empty set, generic `call()` path.
