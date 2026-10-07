import { afterEach, describe, expect, it } from 'vitest'
import { HostConnection } from '../src/host'
import { connectExtension, ExtensionClient } from '../src/extension'
import { messagePort } from '../src/port'
import { parsePublishParams } from '../src/publish'
import { RPC_ERRORS, RpcError } from '../src/protocol'

const HOST_INFO = {
  host: 'test-host',
  hostVersion: '1.0.0',
  apiVersion: '1',
  capabilities: ['events.publish']
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(RPC_ERRORS.INVALID_PARAMS)
    return (err as RpcError).reason
  }
  return undefined
}

describe('parsePublishParams', () => {
  it('defaults scope to all and passes params through unchanged', () => {
    expect(parsePublishParams({ topic: 'x:a' })).toEqual({
      topic: 'x:a',
      scope: 'all'
    })
    const payload = { n: 1, nested: { ok: true } }
    expect(
      parsePublishParams({ topic: 'x:a', params: payload, scope: 'extension' })
    ).toEqual({ topic: 'x:a', params: payload, scope: 'extension' })
  })

  it('keeps an explicit null params', () => {
    expect(parsePublishParams({ topic: 't', params: null })).toEqual({
      topic: 't',
      params: null,
      scope: 'all'
    })
  })

  it('accepts host event names (no reserved-name policing)', () => {
    expect(parsePublishParams({ topic: 'route.saved' }).topic).toBe(
      'route.saved'
    )
    expect(parsePublishParams({ topic: 'state.changed' }).topic).toBe(
      'state.changed'
    )
    expect(parsePublishParams({ topic: 'busy.signal' }).topic).toBe(
      'busy.signal'
    )
  })

  it.each([
    ['missing params', undefined],
    ['missing topic', {}],
    ['empty topic', { topic: '' }],
    ['non-string topic', { topic: 42 }],
    ['single wildcard', { topic: 'x.*' }],
    ['double wildcard', { topic: 'x.**' }],
    ['bus namespace', { topic: 'bus.handshake' }],
    ['bare bus', { topic: 'bus' }],
    ['unknown scope', { topic: 't', scope: 'everyone' }]
  ])('rejects %s as events.badRequest', (_label, params) => {
    expect(reasonOf(() => parsePublishParams(params))).toBe('events.badRequest')
  })
})

/**
 * A minimal multi-context host: each context is a real HostConnection over a
 * MessageChannel, and `events.publish` routes through parsePublishParams the
 * way a conforming host would.
 */
interface Ctx {
  extension: string
  host: HostConnection
  client: ExtensionClient
}

const live: Ctx[] = []
afterEach(() => {
  while (live.length) {
    const c = live.pop()!
    c.client.close()
    c.host.close()
  }
})

async function attach(extension: string, id: string): Promise<Ctx> {
  const channel = new MessageChannel()
  const ctx = { extension } as Ctx
  ctx.host = new HostConnection({
    port: messagePort(channel.port1),
    hostInfo: HOST_INFO,
    context: { kind: 'panel', id, instanceId: null, targetInstance: null },
    onError: () => {},
    methods: {
      'events.publish': (params) => {
        const { topic, params: payload, scope } = parsePublishParams(params)
        for (const c of live) {
          if (scope === 'all' || c.extension === extension) {
            c.host.publish(topic, payload)
          }
        }
        return {}
      }
    }
  })
  ctx.client = await connectExtension({
    port: messagePort(channel.port2),
    timeoutMs: 2000,
    onError: () => {}
  })
  live.push(ctx)
  return ctx
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('client.publish', () => {
  it('scope all reaches every subscribed context, the publisher included', async () => {
    const a1 = await attach('ext-a', 'panel')
    const a2 = await attach('ext-a', 'runtime')
    const b = await attach('ext-b', 'panel')
    const seen: string[] = []
    for (const [label, c] of [
      ['a1', a1],
      ['a2', a2],
      ['b', b]
    ] as const) {
      await c.client.subscribe(['ext-a.*'], (name, params) =>
        seen.push(`${label}:${name}:${JSON.stringify(params)}`)
      )
    }
    await a1.client.publish('ext-a.refresh', { radius: 20 })
    await settle()
    expect(seen.sort()).toEqual([
      'a1:ext-a.refresh:{"radius":20}',
      'a2:ext-a.refresh:{"radius":20}',
      'b:ext-a.refresh:{"radius":20}'
    ])
  })

  it('scope extension stays within the publishing extension', async () => {
    const a1 = await attach('ext-a', 'panel')
    const a2 = await attach('ext-a', 'runtime')
    const b = await attach('ext-b', 'panel')
    const seen: string[] = []
    await a2.client.subscribe(['ext-a.refresh'], () => seen.push('a2'))
    await b.client.subscribe(['ext-a.refresh'], () => seen.push('b'))
    await a1.client.publish('ext-a.refresh', undefined, 'extension')
    await settle()
    expect(seen).toEqual(['a2'])
  })

  it('does not deliver to contexts that did not subscribe', async () => {
    const a1 = await attach('ext-a', 'panel')
    const a2 = await attach('ext-a', 'runtime')
    const seen: string[] = []
    await a2.client.subscribe(['other.topic'], () => seen.push('a2'))
    await a1.client.publish('ext-a.refresh')
    await settle()
    expect(seen).toEqual([])
  })

  it('accepts colon-joined topics, matched only by their full name', async () => {
    const a1 = await attach('ext-a', 'panel')
    const a2 = await attach('ext-a', 'runtime')
    const seen: string[] = []
    await a2.client.subscribe(['ext-a:*'], () => seen.push('prefix'))
    await a2.client.subscribe(['ext-a:refresh'], () => seen.push('exact'))
    await a1.client.publish('ext-a:refresh')
    await settle()
    expect(seen).toEqual(['exact'])
  })

  it('a published host event name arrives like a host event', async () => {
    const a = await attach('ext-a', 'panel')
    const b = await attach('ext-b', 'panel')
    const seen: unknown[] = []
    await b.client.subscribe(['route.**'], (name, params) =>
      seen.push({ name, params })
    )
    const payload = { routeId: 'r1', rev: 3, saved: true, dirty: false }
    await a.client.publish('route.saved', payload)
    await settle()
    expect(seen).toEqual([{ name: 'route.saved', params: payload }])
  })

  it('surfaces a bad topic as events.badRequest', async () => {
    const a = await attach('ext-a', 'panel')
    const err: RpcError = await a.client.publish('x.*').catch((e) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect(err.reason).toBe('events.badRequest')
  })
})
