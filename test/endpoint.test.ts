import { afterEach, describe, expect, it } from 'vitest'
import { BusEndpoint } from '../src/endpoint'
import { messagePort } from '../src/port'
import { RPC_ERRORS, RpcError } from '../src/protocol'

function pair(opts: { aTimeout?: number; bTimeout?: number } = {}) {
  const channel = new MessageChannel()
  const a = new BusEndpoint({
    port: messagePort(channel.port1),
    callTimeoutMs: opts.aTimeout,
    onError: () => {}
  })
  const b = new BusEndpoint({
    port: messagePort(channel.port2),
    callTimeoutMs: opts.bTimeout,
    onError: () => {}
  })
  return { a, b, channel }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('BusEndpoint RPC', () => {
  it('calls a method and resolves with its result', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('math.add', (params) => {
      const { x, y } = params as { x: number; y: number }
      return x + y
    })
    await expect(a.call('math.add', { x: 2, y: 3 })).resolves.toBe(5)
  })

  it('returns null for handlers that return undefined', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('noop', () => undefined)
    await expect(a.call('noop')).resolves.toBeNull()
  })

  it('rejects with METHOD_NOT_FOUND for unknown methods', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    const err = await a.call('nope').catch((e) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect(err.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND)
  })

  it('propagates RpcError code/reason/data from handlers', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('fail', () => {
      throw new RpcError('not allowed', {
        reason: 'FORBIDDEN',
        data: { detail: 42 }
      })
    })
    const err: RpcError = await a.call('fail').catch((e) => e)
    expect(err.code).toBe(RPC_ERRORS.HOST_ERROR)
    expect(err.reason).toBe('FORBIDDEN')
    expect(err.data?.detail).toBe(42)
  })

  it('wraps plain thrown errors as INTERNAL_ERROR', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('boom', () => {
      throw new Error('kapow')
    })
    const err: RpcError = await a.call('boom').catch((e) => e)
    expect(err.code).toBe(RPC_ERRORS.INTERNAL_ERROR)
    expect(err.message).toBe('kapow')
  })

  it('correlates concurrent calls to the same method by nonce', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('echo.delayed', async (params) => {
      const { value, delay } = params as { value: string; delay: number }
      await new Promise((r) => setTimeout(r, delay))
      return value
    })
    // The slower call is issued first; results must not cross.
    const [first, second] = await Promise.all([
      a.call('echo.delayed', { value: 'slow', delay: 40 }),
      a.call('echo.delayed', { value: 'fast', delay: 5 })
    ])
    expect(first).toBe('slow')
    expect(second).toBe('fast')
  })

  it('times out and cleans the pending table', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    b.registerMethod('hang', () => new Promise(() => {}))
    const err: RpcError = await a
      .call('hang', undefined, { timeoutMs: 30 })
      .catch((e) => e)
    expect(err.code).toBe(RPC_ERRORS.TIMEOUT)
  })

  it('rejects pending calls when closed', async () => {
    const { a, b } = pair()
    cleanups.push(() => b.close())
    b.registerMethod('hang', () => new Promise(() => {}))
    const p = a.call('hang').catch((e) => e)
    a.close()
    const err: RpcError = await p
    expect(err.code).toBe(RPC_ERRORS.CONNECTION_CLOSED)
  })
})

describe('BusEndpoint events', () => {
  it('dispatches notifications to wildcard handlers', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    const seen: Array<[string, unknown]> = []
    b.onEvent(['sk.**'], (name, params) => seen.push([name, params]))
    a.notify('sk.navigation.speedOverGround', { value: 3.1 })
    a.notify('state.changed', { keys: ['path'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual([
      ['sk.navigation.speedOverGround', { value: 3.1 }]
    ])
  })

  it('unsubscribes local handlers', async () => {
    const { a, b } = pair()
    cleanups.push(() => (a.close(), b.close()))
    const seen: string[] = []
    const off = b.onEvent(['ping'], (name) => seen.push(name))
    a.notify('ping')
    await new Promise((r) => setTimeout(r, 20))
    off()
    a.notify('ping')
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['ping'])
  })
})
