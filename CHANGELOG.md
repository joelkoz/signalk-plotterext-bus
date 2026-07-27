# Changelog

## 0.11.0

`map.view` event — follow the chart viewport instead of polling it. The `map`
capability gains a change event so an extension whose work depends on what the
user is looking at (search-in-view, area downloads, overlays) is told when the
view moves. `BUS_ID` stays `plotterExt/1` (new event vocabulary only; the
envelope is unchanged). Minor bump.

- **New event `map.view`** (`MapViewEvent`) — `{ center, zoom, bounds }`, the same
  shape `map.getView` returns. Emitted once per **settled** pan/zoom (after the
  gesture and any kinetic glide), not per frame, and origin-transparently: the
  user dragging the chart, the host recentring, or an extension's own
  `map.center` / `map.fitBounds`.
- **New type `MapView`** — the viewport shape, shared by `map.getView` and the
  event.
- **New typed wrapper `client.map`** — `getView()`, `center(position, zoom?)`,
  `fitBounds(bounds)`. The `map.*` methods were previously reachable only through
  the generic `client.call`.
- Additive and backward-compatible: a host that predates this simply never emits
  `map.view`, and an extension that must run on one can still poll `map.getView`.

## 0.10.0

Reverse embedding — support a plotter running **inside** an iframe embedded by
another application (an "embedding host", e.g. KIP hosting Freeboard-SK). The
plotter stays the API host but points its port at `window.parent`; the embedding
host is the caller and initiates the handshake. `BUS_ID` stays `plotterExt/1`
(additive field + a new context kind; the envelope is unchanged). Minor bump.

- **New context kind `embedding-host`** (`ContextKind`), with `instanceId: null`.
- **Optional `bus.ready` payload `{ id? }`** (`ReadyParams`) — a caller may assert
  its own context id. Additive and backward-compatible: a host that predates it
  ignores it.
- **`HostConnection` option `adoptCallerId`** — when true, the host adopts the
  caller-asserted `id` as `context.id` (falling back to its configured id when
  the caller sends none). Default false: the standard extension case is
  unchanged, host-configured id authoritative.
- **`connectExtension` option `id`** — sends the caller-asserted id in `bus.ready`.
  Omit for the standard extension case.

## 0.9.0

`nightMode` capability — read, set and follow the host's night-vision display
mode (the dimmed, low-blue "night" appearance marine plotters use after dark).
`BUS_ID` stays `plotterExt/1` (additive vocabulary; the core envelope is
unchanged). Minor bump for the new capability.

- **Read.** `client.nightMode.get()` returns `NightModeState`
  (`{ enabled, auto }`): `enabled` is whether night mode is currently applied
  (the resolved state), `auto` is whether the host is deriving it from the
  server's `environment.mode`.
- **Set — three effective states.** `client.nightMode.set({ enabled?, auto? })`:
  force on (`{ enabled: true }`), force off (`{ enabled: false }`), or follow the
  server (`{ auto: true }`). Setting `enabled` is a manual override — it implies
  `auto: false`, so an explicit off wins even while the server says night.
- **Origin-transparent event.** `nightMode.changed` (`{ enabled, auto }`) is
  emitted for every change regardless of origin — an extension's own `set`, the
  user toggling the host's night-mode control, or the server's `environment.mode`
  flipping while `auto` is on. Follow with
  `client.subscribe(['nightMode.changed'], …)`.
- New typed payloads `NightModeState`, `NightModeChangedEvent` and error reasons
  `NightModeErrorReason` (`nightMode.badRequest` / `nightMode.notSupported`).

## 0.8.0

`charts` capability — a lightweight facade over the chart layers the host
already manages. `BUS_ID` stays `plotterExt/1` (additive vocabulary; the core
envelope is unchanged). Minor bump for the new capability.

- **Enumerate + read.** `client.chart.list()` returns the host's chart layers as
  `ChartLayer[]` in display/stacking order (index 0 = topmost), each with
  `id` (opaque, host-assigned), `name`, `visible`, `opacity` and best-effort
  `type` / `bounds` / `minZoom` / `maxZoom`.
- **Batch mutators.** `client.chart.setVisibility(ids, visible)` turns one or
  more charts on/off; `client.chart.setOpacity(ids, opacity)` sets opacity for a
  set; `client.chart.setOrder(order)` reorders (host-clamped — hosts with
  z-bands / pinning honor the requested relative order within their own
  constraints). **Not** a chart provider: no create/add/delete of chart sources.
- **Fine-grained, origin-transparent events.** `chart.visibility`
  (`{ id, visible }`, one per changed chart), `chart.opacity` (`{ id, opacity }`)
  and `chart.order` (`{ order }`, the new full order) — emitted for every change
  regardless of origin, including the user's own chart controls. Follow with
  `client.subscribe(['chart.**'], …)`.
- New typed payloads `ChartLayer`, `ChartVisibilityEvent`, `ChartOpacityEvent`,
  `ChartOrderEvent` and error reasons `ChartErrorReason`
  (`charts.unknownId` / `charts.badRequest` / `charts.notSupported`).

## 0.7.0

`routes` capability redesign — the capability now spans the host's **visible
routes** (drafts plus stored routes the user is displaying), addressed by an
**opaque** `routeId` handle. `BUS_ID` stays `plotterExt/1` (the core envelope is
unchanged; only the routes-capability vocabulary evolved). Breaking within the
routes capability — hence the minor bump.

- **Route-level metadata.** `RouteData` carries a route-level `description`
  (distinct from a waypoint's per-point `RoutePoint.description`); `route.create`
  accepts `name?` / `description?` and both round-trip through `route.get` and
  `route.save`. `RouteSavedEvent` also carries the persisted `name` so a follower
  can relabel without re-fetching.
- **Two flags split.** `RouteData` / `RouteSummary` now carry both `saved`
  (backed by a persisted resource) **and** `dirty` (pending unsaved changes),
  replacing the single overloaded `saved`. Editing a stored route makes it
  `dirty` without un-`saved`-ing it.
- **Events renamed + enriched.** `route.created` → **`route.visible`** (adds
  `saved`, `dirty`); `route.deleted` → **`route.hidden`** (adds `saved`:
  `true` = a stored route was made invisible, `false` = a draft was deleted).
  New typed `RouteSavedEvent` (`{ routeId, rev, href, saved, dirty }`) formalizes
  the `route.saved` event; `route.dirty` now sets the `dirty` flag and leaves
  `saved` untouched.
- **Methods — traditional create/show/hide/delete.** `client.route.create`
  requires `points` (≥2 — a route needs a segment; host rejects fewer with
  `routes.badRequest`). `client.route.show(ref)` brings a stored route into the
  visible set. `client.route.hide(routeId)` removes a route from the map —
  unchecking a saved route's visibility (resource intact) or deleting an unsaved
  draft (it has no store but the visibility buffer). `client.route.delete(routeId)`
  permanently deletes a saved route from the store (and discards an unsaved one,
  same effect as hide). The lifecycle *events* stay visibility-based: `hide`/
  `delete` both emit `route.hidden`, with `saved` reflecting the outcome
  (`true` = still on the server, `false` = gone).
- **Save keeps the handle.** `route.save` persists the current state and the
  route stays visible/addressable under the same `routeId` (`saved:true,
  dirty:false`) — it no longer consumes the route.
- New error reasons `routes.badRef` (`route.show` ref not found) and
  `routes.saveCancelled` (dialog dismissed).

## 0.6.1

- Add `client.route.save(routeId, { name?, description?, dialog? })` →
  `{ href, rev }` — asks the host to persist a live buffer to the routes
  resource and emits `route.saved`. Headless by default (saves with the supplied
  or buffer name); pass `dialog: true` to have the host prompt for the
  name/description instead (prefilled). Additive; delegates to
  `call('route.save', …)` like the rest of the `route.*` namespace.

## 0.6.0

Additive `routes` capability support — no wire-format change, `BUS_ID` stays
`plotterExt/1`. Existing consumers are unaffected.

- **Types** for the `routes` capability live-route-editing surface: `RoutePoint`,
  `RouteData`, `RouteSummary`, and the event payloads `RouteCreatedEvent`,
  `RouteDeletedEvent`, `RouteDirtyEvent` (plus the `RouteErrorReason` union).
- **Typed extension wrappers** on `ExtensionClient`: `client.route.list()`,
  `client.route.create()`, `client.route.get()`, `client.route.replace()`,
  `client.route.delete()` — thin typed sugar that delegates to
  `client.call('route.…', …)`. Plain-JavaScript extensions keep using the
  generic `call()`; the bus stays framework-neutral.
- Conformance tests for the typed wrappers and the generic-call path.

## 0.5.0

Initial published implementation: JSON-RPC 2.0 over `postMessage` with wildcard
event subscriptions; `/host` (`HostConnection`) and `/extension`
(`connectExtension` / `ExtensionClient`) entry points; `state.*` and `signalk.*`
typed helpers.
