import { afterEach, describe, expect, it } from 'vitest'
import { HostConnection } from '../src/host'
import { connectExtension, ExtensionClient } from '../src/extension'
import { messagePort } from '../src/port'
import { RPC_ERRORS, RpcError, SignalKValueEvent } from '../src/protocol'

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
