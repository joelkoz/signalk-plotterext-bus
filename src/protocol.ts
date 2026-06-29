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

export type ContextKind = 'panel' | 'widget' | 'background'

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
