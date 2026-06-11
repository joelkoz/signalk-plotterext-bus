import {
  BUS_ID,
  Envelope,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse
} from './protocol'

export function wrap(msg: JsonRpcMessage): Envelope {
  return { bus: BUS_ID, msg }
}

/**
 * Returns the JSON-RPC message inside a bus envelope, or null when the data
 * is not valid protocol traffic (so unrelated postMessage noise is ignored).
 */
export function unwrap(data: unknown): JsonRpcMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const env = data as Record<string, unknown>
  if (env.bus !== BUS_ID) return null
  return isJsonRpcMessage(env.msg) ? env.msg : null
}

export function isJsonRpcMessage(v: unknown): v is JsonRpcMessage {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  if (m.jsonrpc !== '2.0') return false
  if (typeof m.method === 'string') {
    // Request (with id) or notification (without).
    return (
      m.id === undefined ||
      typeof m.id === 'string' ||
      typeof m.id === 'number'
    )
  }
  // Response: id required (null allowed for unroutable errors), exactly one
  // of result / error.
  const idOk =
    typeof m.id === 'string' || typeof m.id === 'number' || m.id === null
  if (!idOk) return false
  const hasResult = 'result' in m
  const err = m.error as Record<string, unknown> | undefined
  const hasError =
    typeof err === 'object' &&
    err !== null &&
    typeof err.code === 'number' &&
    typeof err.message === 'string'
  return hasResult ? !('error' in m) : hasError
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg && msg.id !== undefined
}

export function isNotification(
  msg: JsonRpcMessage
): msg is JsonRpcNotification {
  return 'method' in msg && (!('id' in msg) || msg.id === undefined)
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !('method' in msg)
}
