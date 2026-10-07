import { afterEach, describe, expect, it } from 'vitest'
import { HostConnection } from '../src/host'
import { connectExtension, ExtensionClient } from '../src/extension'
import { messagePort } from '../src/port'
import {
  ChartLayer,
  ChartOpacityEvent,
  ChartOrderEvent,
  ChartTime,
  ChartTimeEvent,
  ChartVisibilityEvent,
  MapView,
  MapViewEvent,
  NightModeChangedEvent,
  PanelState,
  PanelStateEvent,
  ResourceGroup,
  ResourceGroupAppliedEvent,
  ResourceGroupType,
  RPC_ERRORS,
  RpcError,
  RouteDirtyEvent,
  RoutePoint,
  SignalKValueEvent,
  WindowClosedEvent,
  WindowState
} from '../src/protocol'

const HOST_INFO = {
  host: 'test-host',
  hostVersion: '1.0.0',
  apiVersion: '1',
  capabilities: ['widgets', 'panels.iframe', 'signalk.stream', 'signalk.put']
}

interface Rig {
  host: HostConnection
  client: ExtensionClient
}

const rigs: Rig[] = []
afterEach(() => {
  while (rigs.length) {
    const rig = rigs.pop()!
    rig.client.close()
    rig.host.close()
  }
})

async function rig(
  hostOpts: Partial<ConstructorParameters<typeof HostConnection>[0]> = {}
): Promise<Rig> {
  const channel = new MessageChannel()
  const host = new HostConnection({
    port: messagePort(channel.port1),
    hostInfo: HOST_INFO,
    context: {
      kind: 'widget',
      id: 'gauge',
      instanceId: 'instance-123',
      targetInstance: null
    },
    onError: () => {},
    ...hostOpts
  })
  const client = await connectExtension({
    port: messagePort(channel.port2),
    timeoutMs: 2000,
    onError: () => {}
  })
  const r = { host, client }
  rigs.push(r)
  return r
}

describe('handshake', () => {
  it('delivers host identity, capabilities and context', async () => {
    const { client } = await rig()
    expect(client.handshake.host).toBe('test-host')
    expect(client.apiVersion).toBe('1')
    expect(client.hasCapability('widgets')).toBe(true)
    expect(client.hasCapability('map')).toBe(false)
    expect(client.context.kind).toBe('widget')
    expect(client.context.instanceId).toBe('instance-123')
  })

  it('connects even when the host attaches after the first bus.ready', async () => {
    const channel = new MessageChannel()
    const clientPromise = connectExtension({
      port: messagePort(channel.port2),
      readyIntervalMs: 20,
      timeoutMs: 2000,
      onError: () => {}
    })
    await new Promise((r) => setTimeout(r, 60))
    const host = new HostConnection({
      port: messagePort(channel.port1),
      hostInfo: HOST_INFO,
      context: { kind: 'panel', id: 'config' },
      onError: () => {}
    })
    const client = await clientPromise
    rigs.push({ host, client })
    expect(client.context.id).toBe('config')
  })
})

describe('embedding-host connection (reverse embedding)', () => {
  // The plotter is the host but the child iframe; the embedder is the caller
  // and initiates. The host does not know the caller in advance, so it adopts
  // the id the caller asserts in bus.ready.
  async function embedRig(
    hostOpts: Partial<ConstructorParameters<typeof HostConnection>[0]> = {},
    clientOpts: Parameters<typeof connectExtension>[0] = {}
  ): Promise<Rig> {
    const channel = new MessageChannel()
    const host = new HostConnection({
      port: messagePort(channel.port1),
      hostInfo: HOST_INFO,
      context: { kind: 'embedding-host', id: 'embedding-host', instanceId: null },
      adoptCallerId: true,
      onError: () => {},
      ...hostOpts
    })
    const client = await connectExtension({
      port: messagePort(channel.port2),
      timeoutMs: 2000,
      onError: () => {},
      ...clientOpts
    })
    const r = { host, client }
    rigs.push(r)
    return r
  }

  it('adopts the caller-asserted id as context.id', async () => {
    const { client } = await embedRig({}, { id: 'kip' })
    expect(client.context.kind).toBe('embedding-host')
    expect(client.context.id).toBe('kip')
    expect(client.context.instanceId).toBe(null)
  })

  it('falls back to the host default id when the caller asserts none', async () => {
    const { client } = await embedRig()
    expect(client.context.id).toBe('embedding-host')
  })

  it('ignores a caller id when the host does not adopt it (default)', async () => {
    const { client } = await embedRig(
      { adoptCallerId: false, context: { kind: 'widget', id: 'gauge' } },
      { id: 'kip' }
    )
    expect(client.context.id).toBe('gauge')
  })
})

describe('event subscription and publish', () => {
  it('only delivers events the context subscribed to', async () => {
    const { host, client } = await rig()
    const seen: string[] = []
    await client.subscribe(['state.changed'], (name) => seen.push(name))
    expect(host.publish('state.changed', { keys: ['a'] })).toBe(true)
    expect(host.publish('map.view', { zoom: 12 })).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['state.changed'])
  })

  it('supports wildcard subscriptions and unsubscribe', async () => {
    const { host, client } = await rig()
    const seen: string[] = []
    const unsubscribe = await client.subscribe(['sk.**'], (name) =>
      seen.push(name)
    )
    host.publish('sk.navigation.speedOverGround', { value: 1 })
    await new Promise((r) => setTimeout(r, 20))
    await unsubscribe()
    expect(host.hasSubscriber('sk.navigation.speedOverGround')).toBe(false)
    host.publish('sk.navigation.speedOverGround', { value: 2 })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['sk.navigation.speedOverGround'])
  })

  it('reports subscription changes to the host embedder', async () => {
    const changes: string[][] = []
    const { client } = await rig({
      onSubscriptionsChanged: (patterns) => changes.push(patterns)
    })
    const unsubscribe = await client.subscribe(['map.view'], () => {})
    await unsubscribe()
    expect(changes).toEqual([['map.view'], []])
  })

  it('rejects invalid subscribe params', async () => {
    const { client } = await rig()
    const err: RpcError = await client
      .call('events.subscribe', { patterns: [] })
      .catch((e) => e)
    expect(err.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })
})

describe('state helpers', () => {
  it('round-trips state through host methods', async () => {
    const store = new Map<string, unknown>()
    const { client } = await rig({
      methods: {
        'state.get': (params) => {
          const { keys } = params as { keys?: string[] }
          const values: Record<string, unknown> = {}
          for (const [k, v] of store) {
            if (!keys || keys.includes(k)) values[k] = v
          }
          return { values }
        },
        'state.set': (params) => {
          const { values } = params as { values: Record<string, unknown> }
          for (const [k, v] of Object.entries(values)) store.set(k, v)
          return {}
        }
      }
    })
    await client.state.set({ path: 'navigation.speedOverGround' })
    await expect(client.state.get()).resolves.toEqual({
      path: 'navigation.speedOverGround'
    })
    await expect(client.state.get(['missing'])).resolves.toEqual({})
  })
})

describe('signalk helpers', () => {
  it('subscribes to paths and receives sk.<path> events', async () => {
    let subscribedPaths: string[] = []
    const { host, client } = await rig({
      methods: {
        'signalk.subscribe': (params) => {
          subscribedPaths = (params as { paths: string[] }).paths
          return { subscriptionId: 'sk-1' }
        },
        'signalk.unsubscribe': () => ({})
      }
    })
    const seen: SignalKValueEvent[] = []
    const unsubscribe = await client.signalk.subscribe(
      ['navigation.speedOverGround'],
      (ev) => seen.push(ev)
    )
    expect(subscribedPaths).toEqual(['navigation.speedOverGround'])
    // The host publishes through the normal event channel; the client's
    // signalk.subscribe established an events.subscribe for sk.<path>.
    host.publish('sk.navigation.speedOverGround', {
      path: 'navigation.speedOverGround',
      value: 3.6,
      timestamp: '2026-01-01T00:00:00Z'
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(3.6)
    await unsubscribe()
  })

  it('relays signalk.put', async () => {
    const puts: Array<{ path: string; value: unknown }> = []
    const { client } = await rig({
      methods: {
        'signalk.put': (params) => {
          puts.push(params as { path: string; value: unknown })
          return { state: 'COMPLETED' }
        }
      }
    })
    await expect(
      client.signalk.put('electrical.switches.demo.state', true)
    ).resolves.toEqual({ state: 'COMPLETED' })
    expect(puts).toEqual([
      { path: 'electrical.switches.demo.state', value: true }
    ])
  })
})

describe('route helpers', () => {
  // A tiny in-memory registry mirroring the `routes` capability surface a real
  // host implements: the visible set (drafts + shown stored routes), each with
  // an opaque routeId and two flags — `saved` (backed by a resource) and
  // `dirty` (pending unsaved changes) — plus lifecycle events.
  interface Buf {
    name: string | null
    description: string | null
    rev: number
    saved: boolean
    dirty: boolean
    points: RoutePoint[]
  }

  async function routeRig(): Promise<Rig> {
    const buffers = new Map<string, Buf>()
    let seq = 0
    let host: HostConnection
    const summary = (routeId: string, b: Buf) => ({
      routeId,
      name: b.name,
      rev: b.rev,
      pointCount: b.points.length,
      saved: b.saved,
      dirty: b.dirty
    })
    const r = await rig({
      hostInfo: { ...HOST_INFO, capabilities: [...HOST_INFO.capabilities, 'routes'] },
      methods: {
        'route.create': (params) => {
          const { name, description, points } = (params ?? {}) as {
            name?: string
            description?: string
            points?: RoutePoint[]
          }
          if (!points || points.length < 2) {
            throw new RpcError('a route needs at least two points', {
              reason: 'routes.badRequest'
            })
          }
          const routeId = `route-${++seq}`
          const buf: Buf = {
            name: name ?? null,
            description: description ?? null,
            rev: 1,
            saved: false,
            dirty: true,
            points: points ? [...points] : []
          }
          buffers.set(routeId, buf)
          host.publish('route.visible', {
            routeId,
            rev: buf.rev,
            name: buf.name,
            pointCount: buf.points.length,
            saved: buf.saved,
            dirty: buf.dirty
          })
          return { routeId, rev: buf.rev }
        },
        'route.show': (params) => {
          const { ref } = (params ?? {}) as { ref?: string }
          if (!ref) throw new RpcError('missing ref', { reason: 'routes.badRef' })
          const routeId = `route-${++seq}`
          const buf: Buf = {
            name: `Stored ${ref}`,
            description: null,
            rev: 1,
            saved: true,
            dirty: false,
            points: [{ position: [0, 0] }]
          }
          buffers.set(routeId, buf)
          host.publish('route.visible', {
            routeId,
            rev: buf.rev,
            name: buf.name,
            pointCount: buf.points.length,
            saved: buf.saved,
            dirty: buf.dirty
          })
          return { routeId, rev: buf.rev }
        },
        'route.list': () => ({
          routes: [...buffers].map(([id, b]) => summary(id, b))
        }),
        'route.get': (params) => {
          const { routeId } = params as { routeId: string }
          const b = buffers.get(routeId)
          if (!b) throw new RpcError('no such route', { reason: 'routes.unknownId' })
          return {
            routeId,
            name: b.name,
            description: b.description,
            rev: b.rev,
            saved: b.saved,
            dirty: b.dirty,
            points: b.points
          }
        },
        'route.replace': (params) => {
          const { routeId, points } = params as {
            routeId: string
            points: RoutePoint[]
          }
          const b = buffers.get(routeId)
          if (!b) throw new RpcError('no such route', { reason: 'routes.unknownId' })
          if (!points || points.length < 2) {
            throw new RpcError('a route needs at least two points', {
              reason: 'routes.badRequest'
            })
          }
          b.points = points
          b.rev++
          b.dirty = true
          host.publish('route.dirty', { routeId, rev: b.rev, reason: 'replaced' })
          return { rev: b.rev }
        },
        'route.save': (params) => {
          const { routeId } = params as { routeId: string }
          const b = buffers.get(routeId)
          if (!b) throw new RpcError('no such route', { reason: 'routes.unknownId' })
          b.rev++
          b.saved = true
          b.dirty = false
          const href = `routes/saved-${routeId}`
          host.publish('route.saved', {
            routeId,
            rev: b.rev,
            href,
            name: b.name,
            saved: b.saved,
            dirty: b.dirty
          })
          return { href, rev: b.rev }
        },
        'route.hide': (params) => {
          const { routeId } = params as { routeId: string }
          const b = buffers.get(routeId)
          if (!b) throw new RpcError('no such route', { reason: 'routes.unknownId' })
          b.rev++
          // Hiding a saved route leaves the resource intact (saved:true); hiding
          // an unsaved draft deletes it (saved:false).
          const saved = b.saved
          buffers.delete(routeId)
          host.publish('route.hidden', { routeId, rev: b.rev, saved })
          return {}
        },
        'route.delete': (params) => {
          const { routeId } = params as { routeId: string }
          const b = buffers.get(routeId)
          if (!b) throw new RpcError('no such route', { reason: 'routes.unknownId' })
          b.rev++
          // Permanent delete — the route is gone from the store, so it leaves
          // the visible set as saved:false (not retrievable).
          buffers.delete(routeId)
          host.publish('route.hidden', { routeId, rev: b.rev, saved: false })
          return {}
        }
      }
    })
    host = r.host
    return r
  }

  it('advertises the routes capability', async () => {
    const { client } = await routeRig()
    expect(client.hasCapability('routes')).toBe(true)
  })

  it('creates a draft, emits route.visible (saved:false, dirty:true), round-trips route.get', async () => {
    const { client } = await routeRig()
    const events: Array<{ name: string; params: Record<string, unknown> }> = []
    await client.subscribe(['route.**'], (name, params) =>
      events.push({ name, params: params as Record<string, unknown> })
    )
    const { routeId, rev } = await client.route.create({
      name: 'Test',
      points: [{ position: [-80.1, 25.7] }, { position: [-80.2, 25.8] }]
    })
    expect(rev).toBe(1)
    const data = await client.route.get(routeId)
    expect(data.name).toBe('Test')
    expect(data.rev).toBe(1)
    expect(data.saved).toBe(false)
    expect(data.dirty).toBe(true)
    expect(data.points).toHaveLength(2)
    expect(data.points[0].position).toEqual([-80.1, 25.7])
    await new Promise((r) => setTimeout(r, 20))
    const visible = events.find((e) => e.name === 'route.visible')
    expect(visible?.params.routeId).toBe(routeId)
    expect(visible?.params.pointCount).toBe(2)
    expect(visible?.params.saved).toBe(false)
    expect(visible?.params.dirty).toBe(true)
  })

  it('carries a point href (waypoint link) through route.create, route.get and route.replace', async () => {
    const { client } = await routeRig()
    const href = '/resources/waypoints/0b3d4a2e-1f6c-4c8e-9a51-7d2e8f4b6a10'
    const { routeId } = await client.route.create({
      points: [
        { position: [-80.1, 25.7], href },
        { position: [-80.2, 25.8], name: 'Mark', href }
      ]
    })
    const created = await client.route.get(routeId)
    expect(created.points[0]).toEqual({ position: [-80.1, 25.7], href })
    expect(created.points[1]).toEqual({ position: [-80.2, 25.8], name: 'Mark', href })

    // Moving a linked point off its waypoint drops the link.
    await client.route.replace(routeId, [
      { position: [-80.15, 25.75] },
      created.points[1]
    ])
    const replaced = await client.route.get(routeId)
    expect(replaced.points[0].href).toBeUndefined()
    expect(replaced.points[1].href).toBe(href)
  })

  it('route.show brings a stored route into the visible set (saved:true, dirty:false)', async () => {
    const { client } = await routeRig()
    const visible: Array<Record<string, unknown>> = []
    await client.subscribe(['route.visible'], (_name, params) =>
      visible.push(params as Record<string, unknown>)
    )
    const { routeId } = await client.route.show('abc-uuid')
    const data = await client.route.get(routeId)
    expect(data.saved).toBe(true)
    expect(data.dirty).toBe(false)
    await new Promise((r) => setTimeout(r, 20))
    expect(visible).toHaveLength(1)
    expect(visible[0].saved).toBe(true)
    expect(visible[0].dirty).toBe(false)
  })

  it('lists the visible set and hides a draft, emitting route.hidden (saved:false)', async () => {
    const { client } = await routeRig()
    const hidden: Array<Record<string, unknown>> = []
    await client.subscribe(['route.hidden'], (_name, params) =>
      hidden.push(params as Record<string, unknown>)
    )
    const a = await client.route.create({ name: 'A', points: [{ position: [0, 0] }, { position: [1, 1] }] })
    const b = await client.route.create({ name: 'B', points: [{ position: [0, 0] }, { position: [1, 1] }] })
    const list = await client.route.list()
    expect(list.map((r) => r.routeId).sort()).toEqual(
      [a.routeId, b.routeId].sort()
    )
    await client.route.hide(a.routeId)
    await new Promise((r) => setTimeout(r, 20))
    expect(hidden).toHaveLength(1)
    expect(hidden[0].routeId).toBe(a.routeId)
    expect(hidden[0].saved).toBe(false)
    expect((await client.route.list()).map((r) => r.routeId)).toEqual([
      b.routeId
    ])
  })

  it('hiding a stored (saved) route reports saved:true on route.hidden', async () => {
    const { client } = await routeRig()
    const hidden: Array<Record<string, unknown>> = []
    await client.subscribe(['route.hidden'], (_name, params) =>
      hidden.push(params as Record<string, unknown>)
    )
    const { routeId } = await client.route.show('xyz-uuid')
    await client.route.hide(routeId)
    await new Promise((r) => setTimeout(r, 20))
    expect(hidden).toHaveLength(1)
    expect(hidden[0].saved).toBe(true)
  })

  it('surfaces an unknown route id as routes.unknownId', async () => {
    const { client } = await routeRig()
    const err: RpcError = await client.route.get('nope').catch((e) => e)
    expect(err.reason).toBe('routes.unknownId')
  })

  it('delivers route.dirty so a mirror can re-snapshot', async () => {
    const { host, client } = await routeRig()
    const { routeId } = await client.route.create({ name: 'X', points: [{ position: [0, 0] }, { position: [1, 1] }] })
    const seen: RouteDirtyEvent[] = []
    await client.subscribe(['route.dirty'], (_name, params) =>
      seen.push(params as RouteDirtyEvent)
    )
    expect(host.publish('route.dirty', { routeId, rev: 2, reason: 'replaced' })).toBe(
      true
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0].reason).toBe('replaced')
  })

  it('replaces a buffer via the typed client.route.replace wrapper', async () => {
    const { client } = await routeRig()
    const { routeId } = await client.route.create({
      points: [{ position: [0, 0] }, { position: [0.5, 0.5] }]
    })
    const dirty: RouteDirtyEvent[] = []
    await client.subscribe(['route.dirty'], (_name, params) =>
      dirty.push(params as RouteDirtyEvent)
    )
    const { rev } = await client.route.replace(routeId, [
      { position: [1, 1] },
      { position: [2, 2] }
    ])
    expect(rev).toBe(2)
    const data = await client.route.get(routeId)
    expect(data.points).toHaveLength(2)
    expect(data.rev).toBe(2)
    expect(data.dirty).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(dirty).toHaveLength(1)
    expect(dirty[0].reason).toBe('replaced')
  })

  it('exposes route.replace through the generic call() too (JS path)', async () => {
    const { client } = await routeRig()
    const { routeId } = await client.route.create({ points: [{ position: [0, 0] }, { position: [1, 1] }] })
    const res = (await client.call('route.replace', {
      routeId,
      points: [{ position: [3, 3] }, { position: [4, 4] }]
    })) as { rev: number }
    expect(res.rev).toBe(2)
  })

  it('persists via client.route.save, emits route.saved, keeps the route visible (saved:true, dirty:false)', async () => {
    const { client } = await routeRig()
    const { routeId } = await client.route.create({ name: 'Plan A', points: [{ position: [0, 0] }, { position: [1, 1] }] })
    const saved: Array<Record<string, unknown>> = []
    await client.subscribe(['route.saved'], (_name, params) =>
      saved.push(params as Record<string, unknown>)
    )
    const res = await client.route.save(routeId)
    expect(typeof res.href).toBe('string')
    expect(res.rev).toBe(2)
    // The route stays addressable under the same id, now saved + clean.
    const data = await client.route.get(routeId)
    expect(data.saved).toBe(true)
    expect(data.dirty).toBe(false)
    expect((await client.route.list()).map((r) => r.routeId)).toContain(routeId)
    await new Promise((r) => setTimeout(r, 20))
    expect(saved).toHaveLength(1)
    expect(saved[0].href).toBe(res.href)
    expect(saved[0].name).toBe('Plan A')
    expect(saved[0].saved).toBe(true)
    expect(saved[0].dirty).toBe(false)
  })

  it('route.create with fewer than two points rejects routes.badRequest', async () => {
    const { client } = await routeRig()
    await expect(
      client.route.create({ points: [{ position: [0, 0] }] })
    ).rejects.toHaveProperty('reason', 'routes.badRequest')
  })

  it('route.delete removes a saved route, emitting route.hidden saved:false (gone)', async () => {
    const { client } = await routeRig()
    const hidden: Array<Record<string, unknown>> = []
    await client.subscribe(['route.hidden'], (_name, params) =>
      hidden.push(params as Record<string, unknown>)
    )
    const { routeId } = await client.route.show('to-delete')
    await client.route.delete(routeId)
    await new Promise((r) => setTimeout(r, 20))
    expect(hidden).toHaveLength(1)
    expect(hidden[0].routeId).toBe(routeId)
    expect(hidden[0].saved).toBe(false)
    expect((await client.route.list()).map((r) => r.routeId)).not.toContain(
      routeId
    )
  })

  it('route.create stores a route-level description, returned by route.get', async () => {
    const { client } = await routeRig()
    const { routeId } = await client.route.create({
      name: 'Desc test',
      description: 'around the shoal',
      points: [{ position: [0, 0] }, { position: [1, 1] }]
    })
    const data = await client.route.get(routeId)
    expect(data.description).toBe('around the shoal')
  })
})

describe('chart helpers', () => {
  // A tiny in-memory registry mirroring the `charts` capability surface a real
  // host implements: the chart layers the host already manages, held in
  // top-to-bottom display order, each with an opaque id, a visible flag and an
  // opacity. Mutations are batch and emit per-chart / whole-order events.
  interface ChartRec {
    id: string
    name: string
    visible: boolean
    opacity: number
    type?: string
    bounds?: [number, number, number, number]
    minZoom?: number
    maxZoom?: number
    time?: ChartTime
  }

  async function chartRig(): Promise<Rig> {
    // Seeded top-to-bottom (index 0 = topmost).
    const order: string[] = ['osm', 'noaa-12345', 's57-1', 'radar']
    const charts = new Map<string, ChartRec>([
      ['osm', { id: 'osm', name: 'OpenStreetMap', visible: true, opacity: 1, type: 'raster' }],
      [
        'noaa-12345',
        {
          id: 'noaa-12345',
          name: 'NOAA 12345',
          visible: false,
          opacity: 1,
          type: 'raster',
          bounds: [-80.5, 25.5, -80.0, 26.0],
          minZoom: 4,
          maxZoom: 18
        }
      ],
      ['s57-1', { id: 's57-1', name: 'ENC US5FL', visible: true, opacity: 0.8, type: 'S-57' }],
      // A time-varying chart: the host reports its time dimension and can
      // retarget it (sub-capability `charts.time`).
      [
        'radar',
        {
          id: 'radar',
          name: 'NOAA NEXRAD composite',
          visible: true,
          opacity: 0.65,
          type: 'raster',
          time: {
            value: null,
            current: true,
            from: '2026-09-18T12:00:00Z',
            to: '2026-09-18T15:00:00Z',
            step: 300000
          }
        }
      ]
    ])
    let host: HostConnection
    const snapshot = (id: string): ChartLayer => {
      const c = charts.get(id)!
      return {
        id: c.id,
        name: c.name,
        visible: c.visible,
        opacity: c.opacity,
        ...(c.type ? { type: c.type } : {}),
        ...(c.bounds ? { bounds: c.bounds } : {}),
        ...(c.minZoom !== undefined ? { minZoom: c.minZoom } : {}),
        ...(c.maxZoom !== undefined ? { maxZoom: c.maxZoom } : {}),
        ...(c.time ? { time: { ...c.time } } : {})
      }
    }
    const ISO_INSTANT =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
    const r = await rig({
      hostInfo: {
        ...HOST_INFO,
        capabilities: [...HOST_INFO.capabilities, 'charts', 'charts.time']
      },
      methods: {
        'chart.list': () => ({ charts: order.map(snapshot) }),
        'chart.setVisibility': (params) => {
          const { ids, visible } = (params ?? {}) as {
            ids?: string[]
            visible?: boolean
          }
          if (!Array.isArray(ids) || typeof visible !== 'boolean') {
            throw new RpcError('ids[] and visible required', {
              reason: 'charts.badRequest'
            })
          }
          for (const id of ids) {
            const c = charts.get(id)
            if (!c) throw new RpcError('no such chart', { reason: 'charts.unknownId' })
            if (c.visible !== visible) {
              c.visible = visible
              host.publish('chart.visibility', { id, visible })
            }
          }
          return {}
        },
        'chart.setOpacity': (params) => {
          const { ids, opacity } = (params ?? {}) as {
            ids?: string[]
            opacity?: number
          }
          if (!Array.isArray(ids) || typeof opacity !== 'number') {
            throw new RpcError('ids[] and opacity required', {
              reason: 'charts.badRequest'
            })
          }
          for (const id of ids) {
            const c = charts.get(id)
            if (!c) throw new RpcError('no such chart', { reason: 'charts.unknownId' })
            c.opacity = opacity
            host.publish('chart.opacity', { id, opacity })
          }
          return {}
        },
        'chart.setOrder': (params) => {
          const { order: next } = (params ?? {}) as { order?: string[] }
          if (!Array.isArray(next) || next.some((id) => !charts.has(id))) {
            throw new RpcError('order must reference known charts', {
              reason: 'charts.badRequest'
            })
          }
          // Named ids take the requested relative order at the top; any chart the
          // caller omitted keeps its existing relative position after them.
          const rest = order.filter((id) => !next.includes(id))
          order.splice(0, order.length, ...next, ...rest)
          host.publish('chart.order', { order: [...order] })
          return {}
        },
        'chart.setTime': (params) => {
          const { ids, time } = (params ?? {}) as {
            ids?: string[]
            time?: string | null
          }
          if (
            !Array.isArray(ids) ||
            !(time === null || (typeof time === 'string' && ISO_INSTANT.test(time)))
          ) {
            throw new RpcError('ids[] and an ISO 8601 instant or null required', {
              reason: 'charts.badRequest'
            })
          }
          for (const id of ids) {
            const c = charts.get(id)
            if (!c) throw new RpcError('no such chart', { reason: 'charts.unknownId' })
            if (!c.time) {
              throw new RpcError('chart has no time dimension', {
                reason: 'charts.notTemporal'
              })
            }
            // Passed through as-is — the host neither snaps nor clamps.
            if (c.time.value !== time) {
              c.time.value = time
              host.publish('chart.time', { id, time })
            }
          }
          return {}
        }
      }
    })
    host = r.host
    return r
  }

  it('advertises the charts capability', async () => {
    const { client } = await chartRig()
    expect(client.hasCapability('charts')).toBe(true)
  })

  it('lists chart layers in display order with metadata', async () => {
    const { client } = await chartRig()
    const list = await client.chart.list()
    expect(list.map((c) => c.id)).toEqual(['osm', 'noaa-12345', 's57-1', 'radar'])
    const noaa = list.find((c) => c.id === 'noaa-12345')!
    expect(noaa.visible).toBe(false)
    expect(noaa.type).toBe('raster')
    expect(noaa.bounds).toEqual([-80.5, 25.5, -80.0, 26.0])
    expect(noaa.minZoom).toBe(4)
    const s57 = list.find((c) => c.id === 's57-1')!
    expect(s57.opacity).toBe(0.8)
  })

  it('toggles visibility for a set of charts and emits one chart.visibility per change', async () => {
    const { client } = await chartRig()
    const seen: ChartVisibilityEvent[] = []
    await client.subscribe(['chart.visibility'], (_name, params) =>
      seen.push(params as ChartVisibilityEvent)
    )
    // osm is already visible; only noaa-12345 changes.
    await client.chart.setVisibility(['osm', 'noaa-12345'], true)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([{ id: 'noaa-12345', visible: true }])
    const list = await client.chart.list()
    expect(list.find((c) => c.id === 'noaa-12345')!.visible).toBe(true)
  })

  it('sets opacity for a set of charts and emits chart.opacity', async () => {
    const { client } = await chartRig()
    const seen: ChartOpacityEvent[] = []
    await client.subscribe(['chart.opacity'], (_name, params) =>
      seen.push(params as ChartOpacityEvent)
    )
    await client.chart.setOpacity(['osm', 's57-1'], 0.5)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([
      { id: 'osm', opacity: 0.5 },
      { id: 's57-1', opacity: 0.5 }
    ])
    const list = await client.chart.list()
    expect(list.find((c) => c.id === 'osm')!.opacity).toBe(0.5)
  })

  it('reorders charts and emits chart.order with the new full order', async () => {
    const { client } = await chartRig()
    const seen: ChartOrderEvent[] = []
    await client.subscribe(['chart.order'], (_name, params) =>
      seen.push(params as ChartOrderEvent)
    )
    // Bring the S-57 chart to the top; omitted charts keep their relative order.
    await client.chart.setOrder(['s57-1'])
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toHaveLength(1)
    expect(seen[0].order).toEqual(['s57-1', 'osm', 'noaa-12345', 'radar'])
    const list = await client.chart.list()
    expect(list.map((c) => c.id)).toEqual(['s57-1', 'osm', 'noaa-12345', 'radar'])
  })

  it('surfaces an unknown chart id as charts.unknownId', async () => {
    const { client } = await chartRig()
    const err: RpcError = await client.chart
      .setVisibility(['nope'], true)
      .catch((e) => e)
    expect(err.reason).toBe('charts.unknownId')
  })

  it('exposes chart.setVisibility through the generic call() too (JS path)', async () => {
    const { client } = await chartRig()
    const res = await client.call('chart.setVisibility', {
      ids: ['noaa-12345'],
      visible: true
    })
    expect(res).toEqual({})
  })

  // ---- charts.time --------------------------------------------------------

  it('advertises charts.time and reports a time dimension only on temporal charts', async () => {
    const { client } = await chartRig()
    expect(client.hasCapability('charts.time')).toBe(true)
    const list = await client.chart.list()
    const radar = list.find((c) => c.id === 'radar')!
    expect(radar.time).toEqual({
      value: null,
      current: true,
      from: '2026-09-18T12:00:00Z',
      to: '2026-09-18T15:00:00Z',
      step: 300000
    })
    expect(list.find((c) => c.id === 'osm')!.time).toBeUndefined()
  })

  it('retargets a chart to an instant, then back to live, emitting chart.time per change', async () => {
    const { client } = await chartRig()
    const seen: ChartTimeEvent[] = []
    await client.subscribe(['chart.time'], (_name, params) =>
      seen.push(params as ChartTimeEvent)
    )
    await client.chart.setTime(['radar'], '2026-09-18T13:35:00Z')
    // Same instant again: no change, no event.
    await client.chart.setTime(['radar'], '2026-09-18T13:35:00Z')
    await client.chart.setTime(['radar'], null)
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([
      { id: 'radar', time: '2026-09-18T13:35:00Z' },
      { id: 'radar', time: null }
    ])
    const radar = (await client.chart.list()).find((c) => c.id === 'radar')!
    expect(radar.time!.value).toBeNull()
  })

  it('rejects a chart with no time dimension as charts.notTemporal', async () => {
    const { client } = await chartRig()
    const err: RpcError = await client.chart
      .setTime(['osm'], '2026-09-18T13:35:00Z')
      .catch((e) => e)
    expect(err.reason).toBe('charts.notTemporal')
  })

  it('rejects a non-instant time as charts.badRequest', async () => {
    const { client } = await chartRig()
    const err: RpcError = await client.chart
      .setTime(['radar'], 'yesterday')
      .catch((e) => e)
    expect(err.reason).toBe('charts.badRequest')
  })
})

describe('nightMode helpers', () => {
  // A tiny in-memory host mirroring the `nightMode` capability: a resolved
  // `enabled` flag plus an `auto` flag that, when set, derives `enabled` from
  // the server's environment.mode. Every change publishes nightMode.changed.
  interface NightRig extends Rig {
    setServerMode: (mode: 'day' | 'night') => void
  }

  async function nightRig(
    initial: { enabled?: boolean; auto?: boolean; serverMode?: 'day' | 'night' } = {}
  ): Promise<NightRig> {
    const state = { enabled: initial.enabled ?? false, auto: initial.auto ?? false }
    let serverMode: 'day' | 'night' = initial.serverMode ?? 'day'
    let host: HostConnection
    const snapshot = () => ({ enabled: state.enabled, auto: state.auto })
    const publishChanged = () => host.publish('nightMode.changed', snapshot())
    // Resolve enabled from the server when auto is on; used by set({auto}) and
    // by a server-mode change while auto is on.
    const applyAuto = () => {
      if (state.auto) state.enabled = serverMode === 'night'
    }
    const r = (await rig({
      hostInfo: {
        ...HOST_INFO,
        capabilities: [...HOST_INFO.capabilities, 'nightMode']
      },
      methods: {
        'nightMode.get': () => snapshot(),
        'nightMode.set': (params) => {
          const p = (params ?? {}) as { enabled?: unknown; auto?: unknown }
          const hasEnabled = p.enabled !== undefined
          const hasAuto = p.auto !== undefined
          if (!hasEnabled && !hasAuto) {
            throw new RpcError('enabled or auto required', {
              reason: 'nightMode.badRequest'
            })
          }
          if (
            (hasEnabled && typeof p.enabled !== 'boolean') ||
            (hasAuto && typeof p.auto !== 'boolean')
          ) {
            throw new RpcError('enabled/auto must be boolean', {
              reason: 'nightMode.badRequest'
            })
          }
          const before = snapshot()
          if (hasAuto) state.auto = p.auto as boolean
          if (hasEnabled) {
            // Manual set is an override: it takes the display off the server.
            state.auto = false
            state.enabled = p.enabled as boolean
          } else if (hasAuto && state.auto) {
            applyAuto()
          }
          if (before.enabled !== state.enabled || before.auto !== state.auto) {
            publishChanged()
          }
          return {}
        }
      }
    })) as NightRig
    host = r.host
    r.setServerMode = (mode) => {
      serverMode = mode
      const before = snapshot()
      applyAuto()
      if (before.enabled !== state.enabled) publishChanged()
    }
    return r
  }

  it('advertises the nightMode capability', async () => {
    const { client } = await nightRig()
    expect(client.hasCapability('nightMode')).toBe(true)
  })

  it('get returns the current { enabled, auto } state', async () => {
    const { client } = await nightRig({ enabled: true, auto: true })
    expect(await client.nightMode.get()).toEqual({ enabled: true, auto: true })
  })

  it('force on: set({ enabled: true }) applies night and clears auto, emitting changed', async () => {
    const { client } = await nightRig({ enabled: false, auto: true })
    const events: NightModeChangedEvent[] = []
    await client.subscribe(['nightMode.changed'], (_n, p) =>
      events.push(p as NightModeChangedEvent)
    )
    await client.nightMode.set({ enabled: true })
    expect(await client.nightMode.get()).toEqual({ enabled: true, auto: false })
    expect(events.at(-1)).toEqual({ enabled: true, auto: false })
  })

  it('force off: set({ enabled: false }) turns night off even while auto+server say night', async () => {
    const { client } = await nightRig({ enabled: true, auto: true, serverMode: 'night' })
    await client.nightMode.set({ enabled: false })
    expect(await client.nightMode.get()).toEqual({ enabled: false, auto: false })
  })

  it('follow server: set({ auto: true }) derives enabled from environment.mode', async () => {
    const { client, setServerMode } = await nightRig({ serverMode: 'night' })
    await client.nightMode.set({ auto: true })
    expect(await client.nightMode.get()).toEqual({ enabled: true, auto: true })
    // Origin-transparent: a server mode flip while auto is on emits changed.
    const events: NightModeChangedEvent[] = []
    await client.subscribe(['nightMode.changed'], (_n, p) =>
      events.push(p as NightModeChangedEvent)
    )
    setServerMode('day')
    await new Promise((r) => setTimeout(r, 20))
    expect(await client.nightMode.get()).toEqual({ enabled: false, auto: true })
    expect(events.at(-1)).toEqual({ enabled: false, auto: true })
  })

  it('rejects an empty set with nightMode.badRequest', async () => {
    const { client } = await nightRig()
    const err = await client.nightMode.set({}).catch((e: RpcError) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).reason).toBe('nightMode.badRequest')
  })

  it('exposes nightMode.set through the generic call() too (JS path)', async () => {
    const { client } = await nightRig()
    const res = await client.call('nightMode.set', { enabled: true })
    expect(res).toEqual({})
    expect(await client.call('nightMode.get')).toEqual({ enabled: true, auto: false })
  })
})

describe('map helpers', () => {
  // A tiny in-memory host mirroring the `map` capability: a viewport the
  // extension can read and drive, and that the user can also move. Every
  // settled change publishes one map.view carrying the whole view.
  interface MapRig extends Rig {
    userMoves: (center: [number, number], zoom?: number) => void
  }

  // Stand-in for a real projection: a span that halves with each zoom level.
  const boundsFor = (
    center: [number, number],
    zoom: number
  ): [number, number, number, number] => {
    const span = 180 / 2 ** zoom
    return [
      center[0] - span,
      center[1] - span / 2,
      center[0] + span,
      center[1] + span / 2
    ]
  }

  async function mapRig(
    initial: { center?: [number, number]; zoom?: number } = {}
  ): Promise<MapRig> {
    const view = {
      center: initial.center ?? ([-80.19, 25.77] as [number, number]),
      zoom: initial.zoom ?? 13
    }
    let host: HostConnection
    const snapshot = (): MapView => ({
      center: view.center,
      zoom: view.zoom,
      bounds: boundsFor(view.center, view.zoom)
    })
    // One event per settled change, whoever caused it.
    const settle = (center: [number, number], zoom: number) => {
      if (center[0] === view.center[0] && center[1] === view.center[1] && zoom === view.zoom) {
        return
      }
      view.center = center
      view.zoom = zoom
      host.publish('map.view', snapshot())
    }
    const r = (await rig({
      hostInfo: {
        ...HOST_INFO,
        capabilities: [...HOST_INFO.capabilities, 'map']
      },
      methods: {
        'map.getView': () => snapshot(),
        'map.center': (params) => {
          const p = (params ?? {}) as { position: [number, number]; zoom?: number }
          settle(p.position, typeof p.zoom === 'number' ? p.zoom : view.zoom)
          return {}
        },
        'map.fitBounds': (params) => {
          const { bounds } = (params ?? {}) as { bounds: number[] }
          const [minLon, minLat, maxLon, maxLat] = bounds
          // Frame the box: centre on it, zoom so its width fills the view.
          settle(
            [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
            Math.log2(360 / (maxLon - minLon))
          )
          return {}
        }
      }
    })) as MapRig
    host = r.host
    r.userMoves = (center, zoom) => settle(center, zoom ?? view.zoom)
    return r
  }

  it('advertises the map capability', async () => {
    const { client } = await mapRig()
    expect(client.hasCapability('map')).toBe(true)
  })

  it('getView returns the current { center, zoom, bounds }', async () => {
    const { client } = await mapRig({ center: [-80, 25], zoom: 2 })
    expect(await client.map.getView()).toEqual({
      center: [-80, 25],
      zoom: 2,
      bounds: [-125, 2.5, -35, 47.5]
    })
  })

  it('emits one map.view per settled change, carrying the same shape as getView', async () => {
    const { client } = await mapRig()
    const events: MapViewEvent[] = []
    await client.subscribe(['map.view'], (_n, p) => events.push(p as MapViewEvent))
    await client.map.center([-80, 25], 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(await client.map.getView())
  })

  it('emits map.view origin-transparently when the user moves the map', async () => {
    const { client, userMoves } = await mapRig()
    const events: MapViewEvent[] = []
    await client.subscribe(['map.view'], (_n, p) => events.push(p as MapViewEvent))
    userMoves([-64.75, 32.3], 9)
    await new Promise((r) => setTimeout(r, 20))
    expect(events.at(-1)?.center).toEqual([-64.75, 32.3])
    expect(events.at(-1)?.zoom).toBe(9)
  })

  it('emits a single map.view when fitBounds changes centre and zoom together', async () => {
    const { client } = await mapRig()
    const events: MapViewEvent[] = []
    await client.subscribe(['map.view'], (_n, p) => events.push(p as MapViewEvent))
    await client.map.fitBounds([-90, 20, -70, 30])
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0].center).toEqual([-80, 25])
    expect(events[0].zoom).toBeCloseTo(Math.log2(18))
  })

  it('does not emit map.view when a move leaves the view unchanged', async () => {
    const { client } = await mapRig({ center: [-80, 25], zoom: 2 })
    const events: MapViewEvent[] = []
    await client.subscribe(['map.view'], (_n, p) => events.push(p as MapViewEvent))
    await client.map.center([-80, 25], 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toHaveLength(0)
  })

  it('exposes the map methods through the generic call() too (JS path)', async () => {
    const { client } = await mapRig()
    expect(await client.call('map.center', { position: [-80, 25], zoom: 2 })).toEqual({})
    expect(await client.call('map.getView')).toEqual({
      center: [-80, 25],
      zoom: 2,
      bounds: [-125, 2.5, -35, 47.5]
    })
  })
})

describe('resourceGroup helpers', () => {
  // A tiny in-memory host mirroring the `resourceGroups` capability. It keeps a
  // per-id display selection for routes, waypoints and charts, and does NOT
  // display regions at all — so it exercises the best-effort rule: a type the
  // host cannot act on is omitted from `applied`. Every apply (extension or the
  // host's own UI) publishes resourceGroup.applied.
  interface GroupRig extends Rig {
    shown: Record<'routes' | 'waypoints' | 'charts', string[]>
    userApply: (id: string) => void
  }

  const HOST_TYPES = ['routes', 'waypoints', 'charts'] as const

  async function groupRig(
    groups: Record<string, ResourceGroup>,
    shown: GroupRig['shown'] = { routes: ['r0'], waypoints: ['w0'], charts: ['c0'] }
  ): Promise<GroupRig> {
    let host: HostConnection
    const apply = (id: unknown) => {
      if (typeof id !== 'string' || !id) {
        throw new RpcError('id required', { reason: 'resourceGroups.badRequest' })
      }
      const group = groups[id]
      if (!group) {
        throw new RpcError(`no group ${id}`, { reason: 'resourceGroups.unknownId' })
      }
      const applied: ResourceGroupType[] = []
      for (const type of HOST_TYPES) {
        const ids = group[type]
        if (!Array.isArray(ids)) continue // absent: leave this type alone
        shown[type] = [...ids]
        applied.push(type)
      }
      host.publish('resourceGroup.applied', { id, applied })
      return { applied }
    }
    const r = (await rig({
      hostInfo: {
        ...HOST_INFO,
        capabilities: [...HOST_INFO.capabilities, 'resourceGroups']
      },
      methods: {
        'resourceGroup.apply': (params) =>
          apply((params as { id?: unknown } | undefined)?.id)
      }
    })) as GroupRig
    host = r.host
    r.shown = shown
    r.userApply = (id) => void apply(id)
    return r
  }

  it('advertises the resourceGroups capability', async () => {
    const { client } = await groupRig({})
    expect(client.hasCapability('resourceGroups')).toBe(true)
  })

  it('[ids] replaces the selection, [] clears it, an absent key leaves it', async () => {
    const { client, shown } = await groupRig({
      g1: { name: 'Crossing', routes: ['r1', 'r2'], charts: [] }
    })
    const res = await client.resourceGroup.apply('g1')
    expect(shown.routes).toEqual(['r1', 'r2'])
    expect(shown.charts).toEqual([])
    expect(shown.waypoints).toEqual(['w0']) // absent key: untouched
    expect(res.applied).toEqual(['routes', 'charts'])
  })

  it('omits a type the host does not act on (best effort)', async () => {
    const { client } = await groupRig({
      g1: { name: 'Zones', regions: ['z1'], waypoints: ['w1'] }
    })
    const res = await client.resourceGroup.apply('g1')
    // This host does not display regions, so it reports only waypoints.
    expect(res.applied).toEqual(['waypoints'])
  })

  it('emits resourceGroup.applied for an extension apply and a host-UI apply', async () => {
    const { client, userApply } = await groupRig({
      g1: { name: 'A', routes: ['r1'] },
      g2: { name: 'B', waypoints: [] }
    })
    const events: ResourceGroupAppliedEvent[] = []
    await client.subscribe(['resourceGroup.applied'], (_n, p) =>
      events.push(p as ResourceGroupAppliedEvent)
    )
    await client.resourceGroup.apply('g1')
    userApply('g2') // origin-transparent: the user's own group picker
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual([
      { id: 'g1', applied: ['routes'] },
      { id: 'g2', applied: ['waypoints'] }
    ])
  })

  it('rejects an unknown group with resourceGroups.unknownId', async () => {
    const { client } = await groupRig({})
    const err = await client.resourceGroup.apply('nope').catch((e: RpcError) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).reason).toBe('resourceGroups.unknownId')
  })

  it('rejects a missing id with resourceGroups.badRequest', async () => {
    const { client } = await groupRig({})
    const err = await client.call('resourceGroup.apply', {}).catch((e: RpcError) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).reason).toBe('resourceGroups.badRequest')
  })

  it('exposes resourceGroup.apply through the generic call() too (JS path)', async () => {
    const { client, shown } = await groupRig({ g1: { name: 'A', charts: ['c9'] } })
    const res = await client.call('resourceGroup.apply', { id: 'g1' })
    expect(res).toEqual({ applied: ['charts'] })
    expect(shown.charts).toEqual(['c9'])
  })
})

describe('windows helpers', () => {
  // A tiny in-memory host mirroring the `windows` capability: it records every
  // call so the tests can check what the wrappers put on the wire, and keeps a
  // list of open windows. The host clamps; here it simply echoes pixel sizes.
  const AREA = { width: 1000, height: 800 }
  function windowState(id: string, panel: string, over: Partial<WindowState> = {}): WindowState {
    return {
      windowId: id,
      panel,
      title: panel,
      presentation: 'floating',
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      area: AREA,
      visible: true,
      collapsed: false,
      poppedOut: false,
      modal: false,
      ...over
    }
  }

  async function windowsRig(self?: string) {
    const calls: { method: string; params: unknown }[] = []
    const open = new Map<string, WindowState>()
    let seq = 0
    const record = (method: string, params: unknown) => calls.push({ method, params })
    const target = (p: { windowId?: string }) => {
      const id = p.windowId ?? self
      const w = id ? open.get(id) : undefined
      if (!w) throw new RpcError('No such window', { reason: 'windows.unknownId' })
      return w
    }
    const r = await rig({
      hostInfo: { ...HOST_INFO, capabilities: [...HOST_INFO.capabilities, 'windows'] },
      context: self
        ? { kind: 'window', id: 'viewer', instanceId: null, windowId: self, params: { app: '/x/' } }
        : { kind: 'background', id: 'runtime', instanceId: null },
      methods: {
        'ui.openWindow': (params) => {
          record('ui.openWindow', params)
          const p = params as { panel?: string; title?: string; geometry?: { width?: number; height?: number }; visible?: boolean }
          if (p.panel !== 'viewer') {
            throw new RpcError(`No such panel: ${p.panel}`, { reason: 'UNKNOWN_PANEL' })
          }
          const w = windowState(`w-${++seq}`, p.panel, {
            title: p.title ?? 'viewer',
            visible: p.visible ?? true,
            bounds: { x: 0, y: 0, width: p.geometry?.width ?? 300, height: p.geometry?.height ?? 200 }
          })
          open.set(w.windowId, w)
          return w
        },
        'ui.updateWindow': (params) => {
          record('ui.updateWindow', params)
          const p = params as { windowId?: string; title?: string; visible?: boolean }
          const w = target(p)
          if (p.title !== undefined) w.title = p.title
          if (p.visible !== undefined) w.visible = p.visible
          return w
        },
        'ui.focusWindow': (params) => {
          record('ui.focusWindow', params)
          target(params as { windowId?: string })
          return {}
        },
        'ui.closeWindow': (params) => {
          record('ui.closeWindow', params)
          const w = target(params as { windowId?: string })
          open.delete(w.windowId)
          r.host.publish('window.closed', { windowId: w.windowId, reason: 'extension' })
          return {}
        },
        'ui.listWindows': (params) => {
          record('ui.listWindows', params)
          return { windows: [...open.values()] }
        }
      }
    })
    return { ...r, calls, open }
  }

  it('advertises the windows capability', async () => {
    const { client } = await windowsRig()
    expect(client.hasCapability('windows')).toBe(true)
  })

  it('carries windowId and params in a window context handshake', async () => {
    const { client } = await windowsRig('w-self')
    expect(client.context.kind).toBe('window')
    expect(client.context.windowId).toBe('w-self')
    expect(client.context.params).toEqual({ app: '/x/' })
  })

  it('open sends the params as given and returns the window state', async () => {
    const { client, calls } = await windowsRig()
    const params = {
      panel: 'viewer',
      params: { app: '/signalk-wifish/' },
      title: 'Echo sounder',
      geometry: { anchor: 'bottom-right' as const, offset: { x: 16, y: '5%' as const }, width: 480, height: 240 },
      userClose: 'hide' as const,
      restoreKey: 'sounder'
    }
    const w = await client.windows.open(params)
    expect(calls.at(-1)).toEqual({ method: 'ui.openWindow', params })
    expect(w).toMatchObject({ panel: 'viewer', title: 'Echo sounder', bounds: { width: 480, height: 240 } })
  })

  it('update, focus, close and list address a window by id', async () => {
    const { client, calls } = await windowsRig()
    const w = await client.windows.open({ panel: 'viewer' })
    const hidden = await client.windows.update({ windowId: w.windowId, visible: false })
    expect(hidden.visible).toBe(false)
    await client.windows.focus(w.windowId)
    expect(calls.at(-1)).toEqual({ method: 'ui.focusWindow', params: { windowId: w.windowId } })
    expect((await client.windows.list()).map((x) => x.windowId)).toEqual([w.windowId])
    await client.windows.close(w.windowId)
    expect(calls.at(-1)).toEqual({ method: 'ui.closeWindow', params: { windowId: w.windowId } })
    expect(await client.windows.list()).toEqual([])
  })

  it('a window context leaves windowId out to mean itself', async () => {
    const { client, calls, open } = await windowsRig('w-self')
    open.set('w-self', windowState('w-self', 'viewer'))
    await client.windows.update({ title: 'Renamed' })
    await client.windows.focus()
    await client.windows.close()
    expect(calls.map((c) => c.params)).toEqual([{ title: 'Renamed' }, {}, {}])
    expect(open.has('w-self')).toBe(false)
  })

  it('delivers window.closed to a subscribed context', async () => {
    const { client } = await windowsRig()
    const events: WindowClosedEvent[] = []
    await client.subscribe(['window.*'], (_n, p) => events.push(p as WindowClosedEvent))
    const w = await client.windows.open({ panel: 'viewer' })
    await client.windows.close(w.windowId)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual([{ windowId: w.windowId, reason: 'extension' }])
  })

  it('surfaces host reasons: UNKNOWN_PANEL and windows.unknownId', async () => {
    const { client } = await windowsRig()
    const e1 = await client.windows.open({ panel: 'nope' }).catch((e: RpcError) => e)
    expect((e1 as RpcError).reason).toBe('UNKNOWN_PANEL')
    const e2 = await client.windows.close('w-missing').catch((e: RpcError) => e)
    expect((e2 as RpcError).reason).toBe('windows.unknownId')
  })

  it('exposes the window methods through the generic call() too (JS path)', async () => {
    const { client } = await windowsRig()
    const w = (await client.call('ui.openWindow', { panel: 'viewer' })) as WindowState
    expect(await client.call('ui.listWindows')).toEqual({ windows: [w] })
  })
})

describe('panel state helpers', () => {
  // A tiny in-memory host mirroring the `panels.state` capability: it records
  // every call and keeps the extension's loaded panels.
  async function panelsRig(capable = true) {
    const calls: { method: string; params: unknown }[] = []
    const loaded: PanelState[] = [
      { panel: 'app-panel', visible: true, collapsed: false },
      { panel: 'settings', visible: false, collapsed: false, targetInstance: 'w-1' }
    ]
    const r = await rig({
      hostInfo: {
        ...HOST_INFO,
        capabilities: capable ? [...HOST_INFO.capabilities, 'panels.state'] : HOST_INFO.capabilities
      },
      context: { kind: 'panel', id: 'app-panel', instanceId: null },
      methods: {
        'ui.listPanels': (params) => {
          calls.push({ method: 'ui.listPanels', params })
          if (!capable) {
            throw new RpcError('Panel state not supported', { reason: 'panels.notSupported' })
          }
          return { panels: loaded }
        }
      }
    })
    return { ...r, calls, loaded }
  }

  it('advertises the panels.state capability', async () => {
    const { client } = await panelsRig()
    expect(client.hasCapability('panels.state')).toBe(true)
  })

  it('list calls ui.listPanels and unwraps the panels', async () => {
    const { client, calls, loaded } = await panelsRig()
    expect(await client.panels.list()).toEqual(loaded)
    expect(calls).toEqual([{ method: 'ui.listPanels', params: undefined }])
  })

  it('the generic call returns the raw result', async () => {
    const { client, loaded } = await panelsRig()
    expect(await client.call('ui.listPanels')).toEqual({ panels: loaded })
  })

  it('delivers panel.state to a subscribed context', async () => {
    const { client, host } = await panelsRig()
    const events: PanelStateEvent[] = []
    await client.subscribe(['panel.state'], (_n, p) => events.push(p as PanelStateEvent))
    const hidden: PanelStateEvent = { panel: 'app-panel', visible: false, collapsed: false }
    expect(host.publish('panel.state', hidden)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toEqual([hidden])
  })

  it('does not deliver panel.state without a subscription', async () => {
    const { host } = await panelsRig()
    expect(host.publish('panel.state', { panel: 'app-panel', visible: false, collapsed: false })).toBe(false)
  })

  it('a host without the capability rejects with panels.notSupported', async () => {
    const { client } = await panelsRig(false)
    expect(client.hasCapability('panels.state')).toBe(false)
    await expect(client.panels.list()).rejects.toHaveProperty('reason', 'panels.notSupported')
  })
})
