/**
 * Wire protocol types and constants for the Signal K plotter extension bus.
 *
 * The wire format is JSON-RPC 2.0 (https://www.jsonrpc.org/specification)
 * inside a routing envelope: `{ bus: "plotterExt/1", msg: <JSON-RPC object> }`.
 * Calls are JSON-RPC requests; events are JSON-RPC notifications whose
 * `method` is a hierarchical dot-separated event name.
 */

export const BUS_ID = 'plotterExt/1'

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: { reason?: string; [key: string]: unknown }
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse

export interface Envelope {
  bus: typeof BUS_ID
  msg: JsonRpcMessage
}

/**
 * JSON-RPC reserved codes for protocol errors, plus implementation-defined
 * codes (-32000..-32099 range) used by this package. Host API errors should
 * use HOST_ERROR with a stable string identifier in `error.data.reason`.
 */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HOST_ERROR: -32000,
  TIMEOUT: -32001,
  CONNECTION_CLOSED: -32002
} as const

export class RpcError extends Error {
  readonly code: number
  readonly data?: { reason?: string; [key: string]: unknown }

  constructor(
    message: string,
    opts: {
      code?: number
      reason?: string
      data?: Record<string, unknown>
    } = {}
  ) {
    super(message)
    this.name = 'RpcError'
    this.code = opts.code ?? RPC_ERRORS.HOST_ERROR
    const data: Record<string, unknown> = { ...(opts.data ?? {}) }
    if (opts.reason !== undefined) data.reason = opts.reason
    this.data = Object.keys(data).length > 0 ? data : undefined
  }

  get reason(): string | undefined {
    return typeof this.data?.reason === 'string' ? this.data.reason : undefined
  }

  toErrorObject(): JsonRpcErrorObject {
    return {
      code: this.code,
      message: this.message,
      ...(this.data ? { data: this.data } : {})
    }
  }

  static fromErrorObject(err: JsonRpcErrorObject): RpcError {
    return new RpcError(err.message, { code: err.code, data: err.data })
  }

  /** Normalize any thrown value into an RpcError suitable for the wire. */
  static from(err: unknown): RpcError {
    if (err instanceof RpcError) return err
    if (err instanceof Error) {
      return new RpcError(err.message, { code: RPC_ERRORS.INTERNAL_ERROR })
    }
    return new RpcError(String(err), { code: RPC_ERRORS.INTERNAL_ERROR })
  }
}

/** Reserved event names used to establish a connection. */
export const EVENT_READY = 'bus.ready'
export const EVENT_HANDSHAKE = 'bus.handshake'

/**
 * Optional payload a caller may send with `bus.ready`. Additive and
 * backward-compatible: a host that predates it (or does not adopt caller ids)
 * ignores it.
 */
export interface ReadyParams {
  /**
   * Caller-asserted context id. A host that adopts caller ids — an
   * embedding-host connection, where the host does not know the caller in
   * advance — uses it as `context.id`; otherwise it is ignored.
   */
  id?: string
}

export type ContextKind =
  | 'panel'
  | 'widget'
  | 'window'
  | 'background'
  | 'embedding-host'

export interface HandshakeContext {
  kind: ContextKind
  /** Manifest-local contribution id. */
  id: string
  /** Host-assigned unique id for this placed instance (widgets). */
  instanceId?: string | null
  /** Widget instance a configuration panel was opened for. */
  targetInstance?: string | null
  /** Manifest-local widget id of the target instance (configuration panels). */
  targetWidget?: string | null
  /** Host-assigned id of this window (`window` contexts; capability `windows`). */
  windowId?: string
  /** The `params` the window was opened with (`window` contexts). */
  params?: Record<string, unknown>
}

export interface Handshake {
  host: string
  hostVersion: string
  apiVersion: string
  capabilities: string[]
  context: HandshakeContext
}

/** Payload of an `sk.<path>` Signal K value event. */
export interface SignalKValueEvent {
  path: string
  value: unknown
  timestamp?: string
  $source?: string
}

export type StateScope = 'instance' | 'extension'

/** Payload of a `state.changed` host event. */
export interface StateChangedEvent {
  scope: StateScope
  instanceId?: string | null
  keys: string[]
}

/**
 * Types for the `routes` capability — the routes the host currently has visible
 * on the chart (drafts plus stored routes the user is displaying), each
 * addressed by an opaque host-assigned `routeId`. Extensions read/write them and
 * follow lifecycle + mutation events (`route.visible` / `route.dirty` /
 * `route.saved` / `route.hidden`). Two orthogonal flags travel with a route:
 * `saved` (backed by a persisted resource) and `dirty` (has pending unsaved
 * changes). See the Plotter Extensions API spec, "Live routes".
 */

/** A single point in a route edit buffer (`[lon, lat, alt?]`). */
export interface RoutePoint {
  position: [number, number, number?]
  name?: string
  description?: string
  /**
   * Link to a saved waypoint, as a Signal K resource path
   * (`/resources/waypoints/<id>`). A reference, not a copy: `position` alone
   * defines the route's geometry, and the host does not keep the point and the
   * waypoint in step — drop the link when moving the point off its waypoint. A
   * host built before this field existed drops it. See the Plotter Extensions
   * API spec, "Waypoint links".
   */
  href?: string
}

/** Snapshot of a route — result of `route.get`. */
export interface RouteData {
  routeId: string
  name: string | null
  /** Route-level description (distinct from a waypoint's RoutePoint.description). */
  description: string | null
  /** Monotonic revision; increments on every mutation. */
  rev: number
  /** Whether the route is backed by a persisted routes resource. */
  saved: boolean
  /** Whether the in-memory route has pending unsaved changes. */
  dirty: boolean
  points: RoutePoint[]
}

/** Summary entry in a `route.list` result (the visible set). */
export interface RouteSummary {
  routeId: string
  name: string | null
  rev: number
  pointCount: number
  saved: boolean
  dirty: boolean
}

/**
 * Payload of a `route.visible` host event — a route entered the visible set
 * (became rendered on the chart). A freshly drawn/created draft arrives
 * `saved:false, dirty:true`; a stored route brought into view arrives
 * `saved:true, dirty:false`.
 */
export interface RouteVisibleEvent {
  routeId: string
  rev: number
  name: string | null
  pointCount: number
  saved: boolean
  dirty: boolean
}

/**
 * Payload of a `route.hidden` host event — a route left the visible set.
 * `saved:true` ⇒ a stored route was made invisible (the resource is untouched);
 * `saved:false` ⇒ an unsaved draft was deleted (gone for good).
 */
export interface RouteHiddenEvent {
  routeId: string
  rev: number
  saved: boolean
}

/**
 * Payload of a `route.dirty` host event — the conformance-floor catch-all for
 * any structural/bulk change the host does not express granularly. A subscriber
 * should re-seed via `route.get`.
 */
export interface RouteDirtyEvent {
  routeId: string
  rev: number
  reason?: string
}

/**
 * Payload of a `route.saved` host event — the route's current state was
 * persisted to the routes resource collection. Arrives `saved:true,
 * dirty:false`; the route stays visible under the same `routeId`.
 */
export interface RouteSavedEvent {
  routeId: string
  rev: number
  /** Stored resource id of the persisted route. */
  href: string
  /** The route's name as persisted (may have just been set in the host's save
   *  dialog), so followers can update a label without re-fetching. */
  name: string | null
  saved: boolean
  dirty: boolean
}

/** Stable `error.data.reason` strings for `route.*` host-method failures. */
export type RouteErrorReason =
  | 'routes.unknownId'
  | 'routes.badRequest'
  | 'routes.badRef'
  | 'routes.saveFailed'
  | 'routes.deleteFailed'
  | 'routes.saveCancelled'
  | 'routes.notSupported'

/**
 * Types for the `charts` capability — a lightweight facade over the chart
 * layers the host already manages. An extension enumerates them, reads which
 * are shown and in what stacking order, and toggles visibility, opacity and
 * order. It does **not** add, create, or delete chart sources — only manages
 * charts the host already knows about. Follow changes (from any origin,
 * including the user's own chart controls) via the `chart.visibility` /
 * `chart.opacity` / `chart.order` events. With the `charts.time` sub-capability
 * a host also retargets time-varying charts (`chart.setTime`, `ChartTime`,
 * `chart.time`). See the Plotter Extensions API spec, "Chart layers" and
 * "Time-varying charts".
 */

/**
 * One chart layer the host manages — an entry in a `chart.list` result. The
 * array order is the display/stacking order (index 0 = topmost/frontmost).
 */
export interface ChartLayer {
  /** Opaque, stable, host-assigned id. Treat as a token; never parse it. */
  id: string
  /** Human-readable chart name. */
  name: string
  /** Whether the chart is currently displayed. */
  visible: boolean
  /** Display opacity, 0..1. */
  opacity: number
  /** Best-effort source kind, e.g. 'raster' | 'vector' | 'S-57' | 'WMS'. */
  type?: string
  /**
   * Geographic extent `[west, south, east, north]`, when known. Longitudes are
   * in `[-180, 180]`; a chart that crosses the antimeridian has `west > east`.
   * See `LonLatBounds`.
   */
  bounds?: [number, number, number, number]
  /** Minimum usable zoom level, when known. */
  minZoom?: number
  /** Maximum usable zoom level, when known. */
  maxZoom?: number
  /**
   * Present only on a time-addressable chart (hosts with `charts.time`): the
   * instant currently shown and the source's timeline, as far as the host knows
   * it. Absent on a chart with no time dimension.
   */
  time?: ChartTime
}

/**
 * The time dimension of a time-varying chart (weather radar, satellite,
 * nowcast) — the `time` object on a `chart.list` entry. `value` and `current`
 * are always present; the timeline fields are best-effort metadata as the host
 * last learned them (from the chart resource or the source's capabilities),
 * not the contract's source of truth — a rolling product's newest frame moves
 * on between reads.
 */
export interface ChartTime {
  /** Instant currently shown (ISO 8601), or `null` for the live/current frame. */
  value: string | null
  /** Whether the source serves a live/current frame (so `null` is a valid target). */
  current: boolean
  /** Earliest instant offered (ISO 8601), when known. */
  from?: string
  /** Latest instant offered (ISO 8601), when known. */
  to?: string
  /** Milliseconds between frames, when the timeline is regular. */
  step?: number
  /** The explicit instants offered (ISO 8601), when the timeline is a list. */
  values?: string[]
}

/**
 * Params of `chart.setTime` — retarget each named time-varying chart to an
 * instant (ISO 8601) or back to its live frame (`null`). The host passes the
 * instant through to the source without snapping or clamping.
 */
export interface ChartSetTimeParams {
  ids: string[]
  time: string | null
}

/**
 * Payload of a `chart.time` host event — a time-varying chart was retargeted
 * (`time` is an ISO 8601 instant) or returned to live (`time: null`). Emitted
 * for every change regardless of origin; a batch `chart.setTime` emits one
 * event per changed chart.
 */
export interface ChartTimeEvent {
  id: string
  time: string | null
}

/**
 * Payload of a `chart.visibility` host event — one chart's display was turned
 * on or off. A batch `chart.setVisibility` emits one event per changed chart,
 * as does the user toggling a chart in the host's own chart controls.
 */
export interface ChartVisibilityEvent {
  id: string
  visible: boolean
}

/** Payload of a `chart.opacity` host event — one chart's opacity changed. */
export interface ChartOpacityEvent {
  id: string
  /** New opacity, 0..1. */
  opacity: number
}

/**
 * Payload of a `chart.order` host event — the display/stacking order changed.
 * `order` is the new full order, topmost first (the same order `chart.list`
 * returns).
 */
export interface ChartOrderEvent {
  order: string[]
}

/** Stable `error.data.reason` strings for `chart.*` host-method failures. */
export type ChartErrorReason =
  | 'charts.unknownId'
  | 'charts.badRequest'
  | 'charts.notSupported'
  | 'charts.notTemporal'

/**
 * Types for the `nightMode` capability — the host's night-vision display mode
 * (a dimmed, low-blue appearance for use after dark). An extension reads the
 * current state, changes it, and follows changes so an embedded panel matches
 * the host instead of glowing white on a dark bridge. See the Plotter
 * Extensions API spec, "Night mode".
 */

/**
 * The host's night-mode state — the `nightMode.get` result and the payload of
 * the `nightMode.changed` event.
 */
export interface NightModeState {
  /** Whether night mode is currently applied (the resolved state the user sees). */
  enabled: boolean
  /**
   * Whether the host is deriving `enabled` from the server's `environment.mode`
   * (`night` -> on). While `true`, `enabled` tracks the server automatically.
   */
  auto: boolean
}

/**
 * Payload of a `nightMode.changed` host event — the night-mode state changed.
 * Emitted **origin-transparently** for every change: an extension's own
 * `nightMode.set`, the user toggling the host's night-mode control, or the
 * server's `environment.mode` flipping while `auto` is on.
 */
export type NightModeChangedEvent = NightModeState

/** Stable `error.data.reason` strings for `nightMode.*` host-method failures. */
export type NightModeErrorReason =
  | 'nightMode.badRequest'
  | 'nightMode.notSupported'

/**
 * Types for the `map` capability — the chart viewport. An extension reads it
 * with `map.getView`, drives it with `map.center` / `map.fitBounds`, and follows
 * it with the `map.view` event. See the Plotter Extensions API spec, "Map view".
 */

/**
 * The chart viewport — the `map.getView` result and the payload of the
 * `map.view` event, which carry the same shape.
 */
export interface MapView {
  /** Viewport centre as `[lon, lat]`. */
  center: [number, number]
  /** Current zoom level; may be fractional. */
  zoom: number
  /**
   * Axis-aligned lon/lat box covering what is rendered, as
   * `[west, south, east, north]`. On a host whose map can be rotated this is the
   * box containing the rotated view — "at least this much is on screen".
   * Longitudes are always in `[-180, 180]`, even when the chart has been panned
   * into another copy of the world; a view straddling the antimeridian has
   * `west > east`, and one showing every longitude is `-180` to `180`. See
   * `LonLatBounds`.
   */
  bounds: [number, number, number, number]
}

/**
 * Payload of a `map.view` host event — the chart viewport was panned and/or
 * zoomed. Emitted once the view has **settled** (the gesture and any kinetic
 * glide have come to rest), not continuously during the gesture, and
 * **origin-transparently**: for the user dragging the chart, the host recentring
 * on the vessel, or an extension's own `map.center` / `map.fitBounds`.
 */
export type MapViewEvent = MapView

/**
 * Types for the `resourceGroups` capability — applying a stored resource group
 * to the host's display. Groups are ordinary Signal K resources in the `groups`
 * collection; an extension creates, edits and lists them through the server's
 * resources API. The capability adds only what the host alone can do: apply one.
 * See the Plotter Extensions API spec, "Resource groups".
 */

/** The resource types a group can carry an instruction for. */
export type ResourceGroupType = 'routes' | 'waypoints' | 'regions' | 'charts'

/**
 * A resource group document, as stored at `/resources/groups/{id}`. Each list
 * is an instruction for its type, with three distinct meanings:
 * - `["a", …]` — display these (ids that resolve to no resource are ignored);
 * - `[]` — display none of this type;
 * - key absent — leave this type's display as it is.
 * `[]` and an absent key are **not** interchangeable.
 */
export interface ResourceGroup {
  name: string
  description?: string
  routes?: string[]
  waypoints?: string[]
  regions?: string[]
  charts?: string[]
}

/** Params of `resourceGroup.apply`. */
export interface ResourceGroupApplyParams {
  /** Id of the group in the server's `groups` collection. */
  id: string
}

/**
 * Result of `resourceGroup.apply`. `applied` lists every type for which the
 * host made a best-effort attempt to carry out the group's instruction. A type
 * the host did not act on — or whose key is absent from the group — is omitted.
 * It reports what the host **attempted**, not the resulting display.
 */
export interface ResourceGroupApplyResult {
  applied: ResourceGroupType[]
}

/**
 * Payload of a `resourceGroup.applied` host event — a group was applied.
 * Emitted **origin-transparently**: for an extension's `resourceGroup.apply`
 * and for the user choosing a group in the host's own UI. It reports an action,
 * not a readable state — there is no "current group" query.
 */
export interface ResourceGroupAppliedEvent extends ResourceGroupApplyResult {
  /** Id of the group that was applied. */
  id: string
}

/** Stable `error.data.reason` strings for `resourceGroup.*` host-method failures. */
export type ResourceGroupErrorReason =
  | 'resourceGroups.unknownId'
  | 'resourceGroups.fetchFailed'
  | 'resourceGroups.badRequest'
  | 'resourceGroups.notSupported'

/**
 * Types for the `windows` capability — an extension's iframe panels shown as
 * floating windows over the chart. Each window is its own context
 * (`context.kind === 'window'`) carrying `windowId` and `params`. Geometry the
 * extension sends is a request; the host clamps it and reports the actual
 * `bounds` in the window state. See the Plotter Extensions API spec, "Windows".
 */

/** Where a window is anchored in the host's window area. */
export type WindowAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

/**
 * A length: CSS pixels as a number, or a percentage of the window area as a
 * string such as `"40%"`.
 */
export type WindowLength = number | `${number}%`

/**
 * Requested size and position, relative to the host's window area. `offset` is
 * measured inward from the anchored edges (on a centered axis, positive moves
 * right/down). Fields left out take the host's choice (on open) or keep their
 * current value (on update).
 */
export interface WindowGeometry {
  anchor?: WindowAnchor
  offset?: { x?: WindowLength; y?: WindowLength }
  width?: WindowLength
  height?: WindowLength
  minWidth?: WindowLength
  minHeight?: WindowLength
  maxWidth?: WindowLength
  maxHeight?: WindowLength
}

/** Params of `ui.openWindow`. */
export interface WindowOpenParams {
  /** Id of an iframe panel in the caller's manifest. */
  panel: string
  /** Handed to the window in its handshake as `context.params`. */
  params?: Record<string, unknown>
  /** Title-bar text; defaults to the panel's `title`. */
  title?: string
  geometry?: WindowGeometry
  /** Block the chart and every other window until closed. Default `false`. */
  modal?: boolean
  /** Whether the user may resize it. Default `true`. */
  resizable?: boolean
  /** Whether the user may move it. Default `true`. */
  movable?: boolean
  /** Default `'fixed'`; `'autoHide'` hides the title bar when idle. */
  titleBar?: 'fixed' | 'autoHide'
  /** What the user's close control does. Default `'close'`. */
  userClose?: 'close' | 'hide'
  /** `false` opens the window hidden (loaded, not shown). Default `true`. */
  visible?: boolean
  /** Reuse an open window of this panel instead of opening another. */
  single?: boolean
  /** Remember this window's geometry under this key (per extension). */
  restoreKey?: string
}

/** Params of `ui.updateWindow`. `windowId` defaults to self in a window context. */
export interface WindowUpdateParams {
  windowId?: string
  title?: string
  geometry?: WindowGeometry
  visible?: boolean
}

/** A window's actual position and size, in CSS px from the window area's top-left. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The size of the host's window area, in CSS px. */
export interface WindowArea {
  width: number
  height: number
}

/** How the host is showing a window. */
export type WindowPresentation = 'floating' | 'sheet' | 'fullscreen'

/**
 * A window's state — the result of `ui.openWindow` / `ui.updateWindow`, an
 * entry of `ui.listWindows`, and the payload of `window.state`.
 */
export interface WindowState {
  windowId: string
  /** The manifest panel the window shows. */
  panel: string
  title: string
  presentation: WindowPresentation
  bounds: WindowBounds
  area: WindowArea
  visible: boolean
  /** Host feature: collapsed to its title bar (still running). */
  collapsed: boolean
  /** Host feature: popped out into a separate browser window. */
  poppedOut: boolean
  modal: boolean
}

/** Result of `ui.listWindows` — the caller's extension's open windows. */
export interface WindowListResult {
  windows: WindowState[]
}

/** Payload of a `window.bounds` host event — a window's actual geometry changed. */
export interface WindowBoundsEvent {
  windowId: string
  bounds: WindowBounds
  area: WindowArea
}

/** Payload of a `window.state` host event (visibility, collapse, pop-out, presentation or title changed). */
export type WindowStateEvent = WindowState

/** Why a window closed. */
export type WindowCloseReason = 'user' | 'extension' | 'host'

/** Payload of a `window.closed` host event — the window closed and its page unloaded. */
export interface WindowClosedEvent {
  windowId: string
  reason: WindowCloseReason
}

/** Stable `error.data.reason` strings for window host-method failures. */
export type WindowErrorReason =
  | 'windows.badRequest'
  | 'windows.unknownId'
  | 'windows.limit'
  | 'windows.modalOpen'
  | 'windows.notSupported'
  | 'UNKNOWN_PANEL'

/**
 * Types for the `panels.state` capability — whether each of an extension's
 * loaded panels is on screen. `visible` is the host's presentation (its drawer
 * showing the panel, its dialog open), not the browser tab's visibility. A
 * panel shown in a window is a `window` context and is not covered here. See
 * the Plotter Extensions API spec, "Panel state".
 */

/** A loaded panel's state — an entry of `ui.listPanels` and the payload of `panel.state`. */
export interface PanelState {
  /** The panel's manifest id. */
  panel: string
  /** Whether the host is presenting the panel in its UI. */
  visible: boolean
  /** Host feature: shown reduced to its header (still `visible`). Always `false` without it. */
  collapsed: boolean
  /** Configuration panels opened for a widget instance: the instance being configured. */
  targetInstance?: string
}

/** Result of `ui.listPanels` — the caller's extension's loaded panels. */
export interface PanelListResult {
  panels: PanelState[]
}

/** Payload of a `panel.state` host event — a loaded panel was shown, hidden, collapsed or expanded. */
export type PanelStateEvent = PanelState

/** Stable `error.data.reason` strings for `ui.listPanels` failures. */
export type PanelErrorReason = 'panels.notSupported'

/**
 * Types for the `events.publish` capability — extension-originated events. A
 * context publishes a topic and the host delivers it, exactly like a host
 * event, to every subscribed context in `scope` (the publisher included). The
 * delivered event carries no sender identity. The `publish` button action
 * (deprecated alias `sendMessage`) is the same operation. See the Plotter
 * Extensions API spec, "Publishing events".
 */

/** Who may receive a published event. */
export type PublishScope = 'all' | 'extension'

/** Params of `events.publish`. */
export interface PublishParams {
  /** Literal event name: non-empty, no `*`, not in the `bus.*` namespace. */
  topic: string
  /** Delivered unchanged as the event's `params`. */
  params?: unknown
  /** Default `'all'`. */
  scope?: PublishScope
}

/** Stable `error.data.reason` strings for `events.publish` failures. */
export type PublishErrorReason = 'events.badRequest'
