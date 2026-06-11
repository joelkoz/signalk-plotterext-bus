import {
  isNotification,
  isRequest,
  isResponse,
  unwrap,
  wrap
} from './codec'
import {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  RPC_ERRORS,
  RpcError
} from './protocol'
import { BusPort } from './port'
import { matchesAny } from './wildcard'

export interface MethodContext {
  endpoint: BusEndpoint
}

export type MethodHandler = (
  params: unknown,
  ctx: MethodContext
) => unknown | Promise<unknown>

export type EventHandler = (name: string, params: unknown) => void

export interface BusEndpointOptions {
  port: BusPort
  /** Default timeout for outgoing calls. */
  callTimeoutMs?: number
  /** Reporter for handler/dispatch errors. Defaults to console.warn. */
  onError?: (err: unknown) => void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: RpcError) => void
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_CALL_TIMEOUT_MS = 10_000

/**
 * One end of the bus: sends/receives envelopes over a BusPort, dispatches
 * incoming requests to registered methods, correlates responses to pending
 * calls by per-call nonce, and fans incoming notifications out to wildcard
 * event handlers. Symmetric — both host and extension build on this.
 */
export class BusEndpoint {
  readonly callTimeoutMs: number

  private readonly port: BusPort
  private readonly unlisten: () => void
  private readonly onError: (err: unknown) => void
  private readonly pending = new Map<JsonRpcId, PendingCall>()
  private readonly methods = new Map<string, MethodHandler>()
  private readonly eventHandlers = new Set<{
    patterns: string[]
    fn: EventHandler
  }>()
  private readonly idPrefix = Math.random().toString(36).slice(2, 8)
  private seq = 0
  private closed = false

  constructor(opts: BusEndpointOptions) {
    this.port = opts.port
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.onError =
      opts.onError ??
      ((err) => console.warn('[plotterext-bus]', err))
    this.unlisten = this.port.listen((data) => this.onData(data))
  }

  registerMethod(name: string, handler: MethodHandler): void {
    this.methods.set(name, handler)
  }

  unregisterMethod(name: string): void {
    this.methods.delete(name)
  }

  /**
   * Handle incoming notifications whose names match any of the wildcard
   * patterns. Returns an unsubscribe function. This is local dispatch only;
   * telling the peer which events to forward is a separate concern
   * (`events.subscribe`).
   */
  onEvent(patterns: string[], fn: EventHandler): () => void {
    const entry = { patterns, fn }
    this.eventHandlers.add(entry)
    return () => this.eventHandlers.delete(entry)
  }

  /** Send a notification (an event) to the peer. */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  /** Call a method on the peer; resolves with its result. */
  call(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new RpcError('Bus endpoint is closed', {
          code: RPC_ERRORS.CONNECTION_CLOSED,
          reason: 'CLOSED'
        })
      )
    }
    const id = `${this.idPrefix}-${++this.seq}`
    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(
                new RpcError(`Call timed out after ${timeoutMs}ms: ${method}`, {
                  code: RPC_ERRORS.TIMEOUT,
                  reason: 'TIMEOUT'
                })
              )
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve, reject, timer })
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {})
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unlisten()
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(
        new RpcError('Bus endpoint closed', {
          code: RPC_ERRORS.CONNECTION_CLOSED,
          reason: 'CLOSED'
        })
      )
    }
    this.pending.clear()
    this.eventHandlers.clear()
  }

  private send(msg: JsonRpcMessage): void {
    if (this.closed) return
    this.port.post(wrap(msg))
  }

  private onData(data: unknown): void {
    const msg = unwrap(data)
    if (!msg) return
    if (isResponse(msg)) {
      this.onResponse(msg)
    } else if (isRequest(msg)) {
      void this.onRequest(msg)
    } else if (isNotification(msg)) {
      this.onNotification(msg.method, msg.params)
    }
  }

  private onResponse(msg: JsonRpcResponse): void {
    if (msg.id === null) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (p.timer) clearTimeout(p.timer)
    if ('error' in msg) {
      p.reject(RpcError.fromErrorObject(msg.error))
    } else {
      p.resolve(msg.result)
    }
  }

  private async onRequest(msg: {
    id: JsonRpcId
    method: string
    params?: unknown
  }): Promise<void> {
    const handler = this.methods.get(msg.method)
    if (!handler) {
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${msg.method}`
        }
      })
      return
    }
    try {
      const result = await handler(msg.params, { endpoint: this })
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: result === undefined ? null : result
      })
    } catch (err) {
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: RpcError.from(err).toErrorObject()
      })
    }
  }

  private onNotification(name: string, params: unknown): void {
    for (const entry of [...this.eventHandlers]) {
      if (matchesAny(entry.patterns, name)) {
        try {
          entry.fn(name, params)
        } catch (err) {
          this.onError(err)
        }
      }
    }
  }
}
