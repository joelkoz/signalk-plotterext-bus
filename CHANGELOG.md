# Changelog

## 0.17.0

Extension-originated events. A new capability, `events.publish`, lets an
extension context publish events onto the bus as well as subscribe to them.
`BUS_ID` stays `plotterExt/1`: everything is additive.

- **New client method `client.publish(topic, params?, scope?)`** over the new
  host method `events.publish`. `scope` is `'all'` (default — every subscribed
  context, any extension) or `'extension'` (the publisher's own contexts). The
  publisher receives its own event if it subscribed. Delivered events carry no
  sender identity and look exactly like host events.
- **New host helper `parsePublishParams(params)`** validates the params, applies
  the default scope and throws `events.badRequest`, so every host rejects the
  same inputs. Routing stays with the host application.
- **New types:** `PublishScope`, `PublishParams`, `PublishErrorReason`.
- The `sendMessage` button action is renamed `publish` (with the same `scope`
  option); `sendMessage` remains a permanent deprecated alias.
- Spec: Plotter Extensions API, "Publishing events".

## 0.16.0

Floating windows. A new capability, `windows`, lets an extension show one of its
own iframe panels in a window over the chart instead of the host's drawer —
several at once, each its own context. `BUS_ID` stays `plotterExt/1`: everything
is additive.

- **New context kind `window`.** `ContextKind` gains `'window'`, and
  `HandshakeContext` gains optional `windowId` and `params` (the object the
  window was opened with).
- **New client wrapper `client.windows`:** `open`, `update`, `focus`, `close`
  and `list`, over `ui.openWindow`, `ui.updateWindow`, `ui.focusWindow`,
  `ui.closeWindow` and `ui.listWindows`. In a window context, leaving out
  `windowId` addresses the window itself.
- **New types:** `WindowAnchor`, `WindowLength`, `WindowGeometry`,
  `WindowOpenParams`, `WindowUpdateParams`, `WindowBounds`, `WindowArea`,
  `WindowPresentation`, `WindowState`, `WindowListResult`, the event payloads
  `WindowBoundsEvent` / `WindowStateEvent` / `WindowClosedEvent`,
  `WindowCloseReason` and `WindowErrorReason`.
- Geometry is a request: the host clamps it and reports the actual `bounds`,
  and may show a window as a `sheet` or `fullscreen` instead of `floating`.
- Spec: Plotter Extensions API, "Windows".

## 0.15.0

Waypoint links on route points. `RoutePoint` gains an optional `href` — a link
to a saved waypoint as a Signal K resource path (`/resources/waypoints/<id>`),
the same reference a Signal K route stores in its per-point metadata. It
round-trips through `route.create`, `route.get`, `route.replace` and
`route.save`, so editing a route no longer has to lose the links its points had
on the server. `BUS_ID` stays `plotterExt/1`: the field is optional and additive.

- A link is a reference, not a copy: `position` alone defines the geometry, and
  the host does not keep the point and the waypoint in step — a client that
  moves a linked point off its waypoint should drop the `href`.
- A host built before this field drops it when copying points; nothing on the
  wire tells the two apart, so an extension that depends on links should
  `route.get` after writing and check.
- Spec: Plotter Extensions API, "Live routes" → "Waypoint links".

## 0.14.0

Bounding boxes and the antimeridian. Every lon/lat box in the API — `MapView`
`bounds` (`map.getView` / `map.view`), `map.fitBounds`, and `ChartInfo.bounds` —
is `[west, south, east, north]` with longitudes in `[-180, 180]`; a box that
crosses the antimeridian has `west > east` (RFC 7946 §5.2), the Signal K Track
API's convention. `map.fitBounds` also accepts the unwrapped form map engines use
(`east` past 180). No wire change: `BUS_ID` stays `plotterExt/1` and the tuple
type is unchanged; this pins down what its numbers mean. Minor bump for the new
exports.

- **New helpers** (from the root, `/host` and `/extension` entry points):
  - `normalizeBounds(bounds)` — a box in the API's form from either form;
    wraps longitudes into range, turns a 360°+ box into `-180`..`180`, and
    returns `undefined` for anything that is not a box. For a host building
    `map.view` from its map engine's extent, and for an extension handling a
    `map.fitBounds`-style box of its own.
  - `boundsLonSpan(bounds)` — width in degrees, the short way round a crossing.
  - `boundsContainsLon(bounds, lon)` — whether a box takes in a longitude.
- **New type `LonLatBounds`** — `[west, south, east, north]`.
- **Doc comments** on `MapView.bounds`, `ChartInfo.bounds` and
  `client.map.fitBounds` state the convention.

## 0.13.0

`resourceGroups` capability — apply a stored resource group (a named set of
routes, waypoints, regions and charts in the server's `groups` collection) to
the host's display. `BUS_ID` stays `plotterExt/1` (new method and event
vocabulary only; the envelope is unchanged). Minor bump.

- **New capability id `resourceGroups`.**
- **New method `resourceGroup.apply`** (`ResourceGroupApplyParams`, `{ id }`) →
  `ResourceGroupApplyResult` (`{ applied }`): the types the host made a
  best-effort attempt to carry out. A type the host does not act on, or whose key
  is absent from the group, is omitted. It reports what was attempted, not the
  resulting display.
- **New type `ResourceGroup`** — the group document. Each of `routes`,
  `waypoints`, `regions`, `charts` is optional with three distinct meanings:
  `[ids]` display these, `[]` display none, key absent leave that type alone.
- **New event `resourceGroup.applied`** (`ResourceGroupAppliedEvent`,
  `{ id, applied }`) — origin-transparent: an extension's apply or the user's own
  group picker. There is no "current group" query.
- **New error reasons** `ResourceGroupErrorReason`: `resourceGroups.unknownId`,
  `resourceGroups.fetchFailed`, `resourceGroups.badRequest`,
  `resourceGroups.notSupported`.
- **New typed wrapper `client.resourceGroup.apply(id)`.** Group create / edit /
  delete / list stay on the server's resources API — not wrapped by the bus.

## 0.12.0

`charts.time` — retarget a time-varying chart. The `charts` capability gains an
optional sub-capability so an extension can scrub one weather-radar / satellite
chart through its frames instead of a provider publishing one chart resource
per frame and swapping visibility. `BUS_ID` stays `plotterExt/1` (new method and
event vocabulary only; the envelope is unchanged). Minor bump.

- **New sub-capability id `charts.time`** (requires `charts`).
- **New method `chart.setTime`** (`ChartSetTimeParams`) — `{ ids, time }`, batch
  like the other chart mutators; `time` is an ISO 8601 instant or `null` for the
  live/current frame. The host passes the instant through — no snapping or
  clamping.
- **New type `ChartTime`** and optional `ChartLayer.time` — present only on a
  time-addressable chart: `{ value, current, from?, to?, step?, values? }`.
  The timeline fields are best-effort metadata, not the source of truth.
- **New event `chart.time`** (`ChartTimeEvent`) — `{ id, time }`,
  origin-transparent like the other chart events; one per changed chart.
- **New error reason `charts.notTemporal`** on `ChartErrorReason`.
- **New typed wrapper `client.chart.setTime(ids, time)`**.
- Additive and backward-compatible: a host without `charts.time` never reports
  `time` on a chart, never emits `chart.time`, and answers `chart.setTime` with
  `charts.notSupported`.

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
