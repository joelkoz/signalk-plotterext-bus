import { BusEndpoint, MethodHandler } from './endpoint'
import { BusPort } from './port'
import {
  EVENT_HANDSHAKE,
  EVENT_READY,
  HandshakeContext,
  ReadyParams,
  RPC_ERRORS,
  RpcError
} from './protocol'
import { matchesAny } from './wildcard'

export interface HostInfo {
  host: string
  hostVersion: string
  apiVersion: string
  capabilities: string[]
}

export interface HostConnectionOptions {
  port: BusPort
  hostInfo: HostInfo
  context: HandshakeContext
  /** Host API methods (e.g. 'state.get', 'signalk.subscribe', 'map.center'). */
  methods?: Record<string, MethodHandler>
  callTimeoutMs?: number
  onError?: (err: unknown) => void
  /**
   * Called whenever the union of subscribed event patterns changes, with the
   * current pattern list. Lets the host start/stop upstream work lazily.
   */
  onSubscriptionsChanged?: (patterns: string[]) => void
  /**
   * When true, adopt a caller-asserted `id` from the `bus.ready` payload as
   * `context.id` in the handshake. Used for embedding-host connections, where
   * the host does not know the caller in advance. Defaults to false: the
   * host-provided `context.id` is authoritative and the ready payload is
   * ignored (the standard extension case, where the host created the iframe
   * and already knows the contribution).
   */
  adoptCallerId?: boolean
}

/**
 * The host side of one extension context (one iframe). Sends the handshake
 * in reply to `bus.ready`, dispatches host API methods, and tracks the
 * context's event subscriptions so `publish()` only forwards events the
 * context asked for.
 */
export class HostConnection {
  readonly endpoint: BusEndpoint
  readonly context: HandshakeContext

  private readonly hostInfo: HostInfo
  private readonly subs = new Map<string, string[]>()
  private readonly onSubscriptionsChanged?: (patterns: string[]) => void
  private readonly adoptCallerId: boolean
  private subSeq = 0

  constructor(opts: HostConnectionOptions) {
    this.hostInfo = opts.hostInfo
    this.context = opts.context
    this.onSubscriptionsChanged = opts.onSubscriptionsChanged
    this.adoptCallerId = opts.adoptCallerId ?? false
    this.endpoint = new BusEndpoint({
      port: opts.port,
      callTimeoutMs: opts.callTimeoutMs,
      onError: opts.onError
    })
    for (const [name, handler] of Object.entries(opts.methods ?? {})) {
      this.endpoint.registerMethod(name, handler)
    }
    this.endpoint.registerMethod('events.subscribe', (params) =>
      this.handleSubscribe(params)
    )
    this.endpoint.registerMethod('events.unsubscribe', (params) =>
      this.handleUnsubscribe(params)
    )
    this.endpoint.onEvent([EVENT_READY], (_name, params) =>
      this.sendHandshake(params as ReadyParams | undefined)
    )
  }

  registerMethod(name: string, handler: MethodHandler): void {
    this.endpoint.registerMethod(name, handler)
  }

  /**
   * Publish an event to this context. Delivered only when the context has a
   * matching subscription; returns whether it was delivered.
   */
  publish(eventName: string, params?: unknown): boolean {
    if (!this.hasSubscriber(eventName)) return false
    this.endpoint.notify(eventName, params)
    return true
  }

  hasSubscriber(eventName: string): boolean {
    for (const [, patterns] of this.subs) {
      if (matchesAny(patterns, eventName)) return true
    }
    return false
  }

  /** Union of currently subscribed patterns. */
  subscribedPatterns(): string[] {
    const all = new Set<string>()
    for (const [, patterns] of this.subs) {
      for (const p of patterns) all.add(p)
    }
    return [...all]
  }

  close(): void {
    this.endpoint.close()
    this.subs.clear()
  }

  private sendHandshake(ready?: ReadyParams): void {
    const context =
      this.adoptCallerId && ready?.id
        ? { ...this.context, id: ready.id }
        : this.context
    this.endpoint.notify(EVENT_HANDSHAKE, {
      ...this.hostInfo,
      context
    })
  }

  private handleSubscribe(params: unknown): { subscriptionId: string } {
    const patterns = (params as { patterns?: unknown })?.patterns
    if (
      !Array.isArray(patterns) ||
      patterns.length === 0 ||
      !patterns.every((p) => typeof p === 'string' && p.length > 0)
    ) {
      throw new RpcError('events.subscribe requires a non-empty patterns array', {
        code: RPC_ERRORS.INVALID_PARAMS,
        reason: 'INVALID_PATTERNS'
      })
    }
    const subscriptionId = `sub-${++this.subSeq}`
    this.subs.set(subscriptionId, patterns as string[])
    this.onSubscriptionsChanged?.(this.subscribedPatterns())
    return { subscriptionId }
  }

  private handleUnsubscribe(params: unknown): Record<string, never> {
    const id = (params as { subscriptionId?: unknown })?.subscriptionId
    if (typeof id !== 'string' || !this.subs.has(id)) {
      throw new RpcError('Unknown subscriptionId', {
        code: RPC_ERRORS.INVALID_PARAMS,
        reason: 'UNKNOWN_SUBSCRIPTION'
      })
    }
    this.subs.delete(id)
    this.onSubscriptionsChanged?.(this.subscribedPatterns())
    return {}
  }
}

export * from './protocol'
export * from './wildcard'
export { BusEndpoint } from './endpoint'
export type { MethodHandler, MethodContext, EventHandler } from './endpoint'
export * from './port'
