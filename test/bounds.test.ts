import { describe, expect, it } from 'vitest'
import {
  boundsContainsLon,
  boundsLonSpan,
  normalizeBounds
} from '../src/index'

describe('normalizeBounds', () => {
  it('keeps a box already in the API form', () => {
    expect(normalizeBounds([-80.5, 25.5, -80, 26])).toEqual([
      -80.5, 25.5, -80, 26
    ])
    // crossing the antimeridian, RFC 7946 style
    expect(normalizeBounds([175, -21, -175, -13])).toEqual([
      175, -21, -175, -13
    ])
    expect(normalizeBounds([-180, -10, 180, 10])).toEqual([-180, -10, 180, 10])
  })

  it('wraps an unwrapped box straddling 180 into west > east', () => {
    expect(normalizeBounds([175, -21, 185, -13])).toEqual([
      175, -21, -175, -13
    ])
    expect(normalizeBounds([-185, -21, -175, -13])).toEqual([
      175, -21, -175, -13
    ])
  })

  it('brings a box from another world copy back into range', () => {
    // a view of the Americas reported a whole world east
    expect(normalizeBounds([219.25, -64, 399.25, 44])).toEqual([
      -140.75, -64, 39.25, 44
    ])
    expect(normalizeBounds([-442, 24, -441, 25])).toEqual([-82, 24, -81, 25])
  })

  it('reports a box covering every longitude as -180 to 180', () => {
    expect(normalizeBounds([-300, -80, 300, 80])).toEqual([-180, -80, 180, 80])
    expect(normalizeBounds([10, 0, 370, 1])).toEqual([-180, 0, 180, 1])
  })

  it('rejects what is not a box', () => {
    expect(normalizeBounds(undefined)).toBeUndefined()
    expect(normalizeBounds([1, 2, 3])).toBeUndefined()
    expect(normalizeBounds([1, 2, 3, 'x'])).toBeUndefined()
    expect(normalizeBounds([1, 2, 3, Number.NaN])).toBeUndefined()
    expect(normalizeBounds([0, 10, 1, 5])).toBeUndefined() // south > north
    expect(normalizeBounds([0, -95, 1, 5])).toBeUndefined()
  })
})

describe('boundsLonSpan / boundsContainsLon', () => {
  it('measures and tests a box the short way round the antimeridian', () => {
    const fiji: [number, number, number, number] = [175, -21, -175, -13]
    expect(boundsLonSpan(fiji)).toBe(10)
    expect(boundsContainsLon(fiji, 179)).toBe(true)
    expect(boundsContainsLon(fiji, -178)).toBe(true)
    expect(boundsContainsLon(fiji, 181)).toBe(true) // unwrapped longitude
    expect(boundsContainsLon(fiji, 0)).toBe(false)
  })

  it('handles an ordinary box and the whole world', () => {
    const keys: [number, number, number, number] = [-82, 24, -80, 26]
    expect(boundsLonSpan(keys)).toBe(2)
    expect(boundsContainsLon(keys, -81)).toBe(true)
    expect(boundsContainsLon(keys, -79)).toBe(false)
    expect(boundsLonSpan([-180, -80, 180, 80])).toBe(360)
    expect(boundsContainsLon([-180, -80, 180, 80], 123)).toBe(true)
  })
})
