import { describe, expect, it } from 'vitest'
import { unwrap, wrap, isRequest, isNotification, isResponse } from '../src/codec'
import { BUS_ID } from '../src/protocol'

describe('codec', () => {
  it('round-trips a request', () => {
    const msg = { jsonrpc: '2.0' as const, id: 'x-1', method: 'state.get' }
    const env = wrap(msg)
    expect(env.bus).toBe(BUS_ID)
    expect(unwrap(env)).toEqual(msg)
  })

  it('ignores non-envelope traffic', () => {
    expect(unwrap(null)).toBeNull()
    expect(unwrap('hello')).toBeNull()
    expect(unwrap({ source: 'react-devtools' })).toBeNull()
    expect(unwrap({ bus: 'other/1', msg: { jsonrpc: '2.0', method: 'x' } })).toBeNull()
  })

  it('rejects malformed JSON-RPC inside a valid envelope', () => {
    expect(unwrap({ bus: BUS_ID, msg: { method: 'x' } })).toBeNull()
    expect(unwrap({ bus: BUS_ID, msg: { jsonrpc: '2.0' } })).toBeNull()
    expect(
      unwrap({ bus: BUS_ID, msg: { jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } } })
    ).toBeNull()
    expect(
      unwrap({ bus: BUS_ID, msg: { jsonrpc: '2.0', id: 1, error: { code: 'NaN', message: 'x' } } })
    ).toBeNull()
  })

  it('classifies message kinds', () => {
    const req = { jsonrpc: '2.0' as const, id: 1, method: 'm' }
    const note = { jsonrpc: '2.0' as const, method: 'm' }
    const res = { jsonrpc: '2.0' as const, id: 1, result: null }
    const err = {
      jsonrpc: '2.0' as const,
      id: null,
      error: { code: -32600, message: 'bad' }
    }
    expect(isRequest(req)).toBe(true)
    expect(isNotification(req)).toBe(false)
    expect(isNotification(note)).toBe(true)
    expect(isResponse(res)).toBe(true)
    expect(isResponse(err)).toBe(true)
    expect(isRequest(res as never)).toBe(false)
  })
})
