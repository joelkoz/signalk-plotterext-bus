import { BusEndpoint, EventHandler } from './endpoint'
import { BusPort, windowPort } from './port'
import {
  EVENT_HANDSHAKE,
  EVENT_READY,
  Handshake,
  HandshakeContext,
  RPC_ERRORS,
  RpcError,
  SignalKValueEvent,
  StateScope
} from './protocol'

export interface ConnectOptions {
  /** Transport. Defaults to window.postMessage to window.parent. */
  port?: BusPort
  /** Interval for re-sending bus.ready until the handshake arrives. */
  readyIntervalMs?: number
  /** How long to wait for the host handshake before rejecting. */
  timeoutMs?: number
  /** Default timeout for host API calls. */
  callTimeoutMs?: number
  onError?: (err: unknown) => void
}

export type Unsubscribe = () => Promise<void>

/**
 * The extension side of the bus: one per iframe context (panel, widget, or
 * background runtime). Create via connectExtension().
 */
export class ExtensionClient {
  readonly handshake: Handshake
  readonly endpoint: BusEndpoint

  constructor(endpoint: BusEndpoint, handshake: Handshake) {
    this.endpoint = endpoint
    this.handshake = handshake
  }

  get context(): HandshakeContext {
    return this.handshake.context
  }

  get apiVersion(): string {
    return this.handshake.apiVersion
  }

  get capabilities(): string[] {
    return this.handshake.capabilities
  }

  hasCapability(id: string): boolean {
    return this.handshake.capabilities.includes(id)
  }

  /** Call a host API method. */
  call(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<unknown> {
    return this.endpoint.call(method, params, opts)
  }

  /** Send a notification to the host. */
  notify(method: string, params?: unknown): void {
    this.endpoint.notify(method, params)
  }

  /**
   * Subscribe to host events matching wildcard patterns. Registers both the
   * host-side forwarding subscription and local dispatch; the returned
   * function tears down both.
   */
  async subscribe(
    patterns: string[],
    handler: EventHandler
  ): Promise<Unsubscribe> {
    const off = this.endpoint.onEvent(patterns, handler)
    let subscriptionId: string
    try {
      const result = (await this.call('events.subscribe', { patterns })) as {
        subscriptionId: string
      }
      subscriptionId = result.subscriptionId
    } catch (err) {
      off()
      throw err
    }
    return async () => {
      off()
      await this.call('events.unsubscribe', { subscriptionId }).catch(() => {
        // Best-effort: the host may already have dropped the connection.
      })
    }
  }

  /** Host-persisted key/value state (see spec: State Storage). */
  readonly state = {
    get: async (
      keys?: string[],
      scope?: StateScope
    ): Promise<Record<string, unknown>> => {
      const result = (await this.call('state.get', {
        ...(scope ? { scope } : {}),
        ...(keys ? { keys } : {})
      })) as { values: Record<string, unknown> }
      return result.values ?? {}
    },
    set: async (
      values: Record<string, unknown>,
      scope?: StateScope
    ): Promise<void> => {
      await this.call('state.set', {
        ...(scope ? { scope } : {}),
        values
      })
    }
  }

  /** Signal K data relayed by the host (capabilities signalk.stream / .put). */
  readonly signalk = {
    /**
     * Subscribe to Signal K path values. The host publishes them as
     * `sk.<path>` events; this helper hides the event-name mapping and
     * establishes both the event-forwarding subscription and the host's
     * upstream Signal K subscription.
     */
    subscribe: async (
      paths: string[],
      handler: (ev: SignalKValueEvent) => void
    ): Promise<Unsubscribe> => {
      const patterns = paths.map((p) => `sk.${p}`)
      const offEvents = await this.subscribe(patterns, (_name, params) =>
        handler(params as SignalKValueEvent)
      )
      let subscriptionId: string
      try {
        const result = (await this.call('signalk.subscribe', { paths })) as {
          subscriptionId: string
        }
        subscriptionId = result.subscriptionId
      } catch (err) {
        await offEvents()
        throw err
      }
      return async () => {
        await offEvents()
        await this.call('signalk.unsubscribe', { subscriptionId }).catch(
          () => {}
        )
      }
    },
    put: (path: string, value: unknown): Promise<unknown> => {
      return this.call('signalk.put', { path, value })
    }
  }

  close(): void {
    this.endpoint.close()
  }
}

/**
 * Connect to the host from inside an extension iframe. Sends `bus.ready`
 * (repeating until answered) and resolves once the host's `bus.handshake`
 * arrives.
 */
export function connectExtension(
  opts: ConnectOptions = {}
): Promise<ExtensionClient> {
  const port =
    opts.port ??
    windowPort((globalThis as unknown as Window).parent as Window)
  const endpoint = new BusEndpoint({
    port,
    callTimeoutMs: opts.callTimeoutMs,
    onError: opts.onError
  })
  return new Promise<ExtensionClient>((resolve, reject) => {
    let done = false
    const off = endpoint.onEvent([EVENT_HANDSHAKE], (_name, params) => {
      if (done) return
      done = true
      cleanup()
      resolve(new ExtensionClient(endpoint, params as Handshake))
    })
    const interval = setInterval(
      () => endpoint.notify(EVENT_READY),
      opts.readyIntervalMs ?? 250
    )
    const timeout = setTimeout(() => {
      if (done) return
      done = true
      cleanup()
      endpoint.close()
      reject(
        new RpcError('Timed out waiting for host handshake', {
          code: RPC_ERRORS.TIMEOUT,
          reason: 'HANDSHAKE_TIMEOUT'
        })
      )
    }, opts.timeoutMs ?? 10_000)
    const cleanup = () => {
      off()
      clearInterval(interval)
      clearTimeout(timeout)
    }
    endpoint.notify(EVENT_READY)
  })
}

export * from './protocol'
export * from './wildcard'
export { BusEndpoint } from './endpoint'
export type { MethodHandler, MethodContext, EventHandler } from './endpoint'
export * from './port'
