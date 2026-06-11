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
