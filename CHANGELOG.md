# Changelog

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
