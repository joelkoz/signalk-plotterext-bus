import { afterEach, describe, expect, it } from 'vitest'
import { HostConnection } from '../src/host'
import { connectExtension, ExtensionClient } from '../src/extension'
import { messagePort } from '../src/port'
import {
  RPC_ERRORS,
  RpcError,
  RouteDirtyEvent,
  RoutePoint,
  SignalKValueEvent
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
