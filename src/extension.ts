import { BusEndpoint, EventHandler } from './endpoint'
import { BusPort, windowPort } from './port'
import {
  ChartLayer,
  EVENT_HANDSHAKE,
  EVENT_READY,
  Handshake,
  HandshakeContext,
  MapView,
  NightModeState,
  ReadyParams,
  RouteData,
  RoutePoint,
  RouteSummary,
  RPC_ERRORS,
  RpcError,
  SignalKValueEvent,
  StateScope
} from './protocol'

export interface ConnectOptions {
  /** Transport. Defaults to window.postMessage to window.parent. */
  port?: BusPort
  /**
   * Caller-asserted context id, sent in the `bus.ready` payload. A host that
   * adopts caller ids (an embedding-host connection) uses it as `context.id`;
   * standard extension hosts ignore it. Omit for the standard extension case.
   */
  id?: string
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

  /**
   * The host's visible routes (capability `routes`). Thin **typed** wrappers over
   * the host's `route.*` methods — each just delegates to `this.call(...)`, so a
   * plain-JS extension can call `client.call('route.replace', …)` directly and a
   * TypeScript extension gets the typed `client.route.replace(…)` sugar with no
   * behavioural difference. Follow lifecycle + mutations by subscribing to
   * `route.**` events (`RouteVisibleEvent` / `RouteDirtyEvent` / `RouteSavedEvent`
   * / `RouteHiddenEvent`). Further operations (rename/point ops) extend this
   * surface as the capability fills out.
   */
  readonly route = {
    list: async (): Promise<RouteSummary[]> => {
      const result = (await this.call('route.list')) as {
        routes?: RouteSummary[]
      }
      return result.routes ?? []
    },
    create: async (opts: {
      points: RoutePoint[]
      name?: string
      description?: string
    }): Promise<{ routeId: string; rev: number }> => {
      // A route needs at least two points to form a segment; the host rejects
      // fewer with routes.badRequest.
      return (await this.call('route.create', opts)) as {
        routeId: string
        rev: number
      }
    },
    get: async (routeId: string): Promise<RouteData> => {
      return (await this.call('route.get', { routeId })) as RouteData
    },
    replace: async (
      routeId: string,
      points: RoutePoint[]
    ): Promise<{ rev: number }> => {
      return (await this.call('route.replace', { routeId, points })) as {
        rev: number
      }
    },
    save: async (
      routeId: string,
      opts?: { name?: string; description?: string; dialog?: boolean }
    ): Promise<{ href: string; rev: number }> => {
      return (await this.call('route.save', {
        routeId,
        ...(opts ?? {})
      })) as { href: string; rev: number }
    },
    show: async (ref: string): Promise<{ routeId: string; rev: number }> => {
      return (await this.call('route.show', { ref })) as {
        routeId: string
        rev: number
      }
    },
    hide: async (routeId: string): Promise<void> => {
      await this.call('route.hide', { routeId })
    },
    delete: async (routeId: string): Promise<void> => {
      await this.call('route.delete', { routeId })
    }
  }

  /**
   * The host's chart layers (capability `charts`). Thin **typed** wrappers over
   * the host's `chart.*` methods — a lightweight facade over the charts the host
   * already manages: enumerate them, toggle visibility, opacity and stacking
   * order (all batch). It does not create, add, or delete chart sources. Follow
   * changes (from any origin, including the host's own chart controls) by
   * subscribing to `chart.**` events (`ChartVisibilityEvent` / `ChartOpacityEvent`
   * / `ChartOrderEvent`) and re-reading `chart.list` where needed. As with every
   * wrapper, a plain-JS extension can call `client.call('chart.list', …)`
   * directly with no behavioural difference.
   */
  readonly chart = {
    list: async (): Promise<ChartLayer[]> => {
      const result = (await this.call('chart.list')) as { charts?: ChartLayer[] }
      return result.charts ?? []
    },
    setVisibility: async (ids: string[], visible: boolean): Promise<void> => {
      await this.call('chart.setVisibility', { ids, visible })
    },
    setOpacity: async (ids: string[], opacity: number): Promise<void> => {
      await this.call('chart.setOpacity', { ids, opacity })
    },
    setOrder: async (order: string[]): Promise<void> => {
      await this.call('chart.setOrder', { order })
    }
  }

  /**
   * The host's night-vision display mode (capability `nightMode`). Read the
   * current `{ enabled, auto }` state, change it, and follow changes by
   * subscribing to the `nightMode.changed` event (`NightModeChangedEvent`).
   * `set` expresses the three states the spec defines: force on
   * (`{ enabled: true }`), force off (`{ enabled: false }`), follow the server
   * (`{ auto: true }`); setting `enabled` implies `auto: false`. As with every
   * wrapper, a plain-JS extension can call `client.call('nightMode.get' |
   * 'nightMode.set', …)` directly with no behavioural difference.
   */
  readonly nightMode = {
    get: async (): Promise<NightModeState> => {
      return (await this.call('nightMode.get')) as NightModeState
    },
    set: async (state: Partial<NightModeState>): Promise<void> => {
      await this.call('nightMode.set', state)
    }
  }

  /**
   * The host's chart viewport (capability `map`). Read the current
   * `{ center, zoom, bounds }`, drive it, and follow it by subscribing to the
   * `map.view` event (`MapViewEvent`), which carries the same shape and fires
   * once per settled pan/zoom. Seed with `getView` so a follower has a view
   * before the first change. As with every wrapper, a plain-JS extension can
   * call `client.call('map.getView' | 'map.center' | 'map.fitBounds', …)`
   * directly with no behavioural difference.
   */
  readonly map = {
    getView: async (): Promise<MapView> => {
      return (await this.call('map.getView')) as MapView
    },
    center: async (
      position: [number, number],
      zoom?: number
    ): Promise<void> => {
      await this.call('map.center', {
        position,
        ...(typeof zoom === 'number' ? { zoom } : {})
      })
    },
    fitBounds: async (
      bounds: [number, number, number, number]
    ): Promise<void> => {
      await this.call('map.fitBounds', { bounds })
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
  // Default transport: postMessage to the embedding window. Origin checks
  // are relaxed to '*' on the extension side because the host page's origin
  // may legitimately differ from the extension asset origin (e.g. a host dev
  // server embedding extension assets served by the Signal K server); the
  // peer-source check in windowPort still applies, and the host side
  // enforces a strict origin for the extension's frame.
  const port =
    opts.port ??
    windowPort((globalThis as unknown as Window).parent as Window, {
      origin: '*'
    })
  const endpoint = new BusEndpoint({
    port,
    callTimeoutMs: opts.callTimeoutMs,
    onError: opts.onError
  })
  const readyParams: ReadyParams | undefined = opts.id ? { id: opts.id } : undefined
  return new Promise<ExtensionClient>((resolve, reject) => {
    let done = false
    const off = endpoint.onEvent([EVENT_HANDSHAKE], (_name, params) => {
      if (done) return
      done = true
      cleanup()
      resolve(new ExtensionClient(endpoint, params as Handshake))
    })
    const interval = setInterval(
      () => endpoint.notify(EVENT_READY, readyParams),
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
    endpoint.notify(EVENT_READY, readyParams)
  })
}

export * from './protocol'
export * from './wildcard'
export { BusEndpoint } from './endpoint'
export type { MethodHandler, MethodContext, EventHandler } from './endpoint'
export * from './port'
