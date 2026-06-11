import { describe, expect, it } from 'vitest'
import { matchesAny, matchesPattern } from '../src/wildcard'

describe('matchesPattern', () => {
  const cases: Array<[string, string, boolean]> = [
    // exact
    ['map.view', 'map.view', true],
    ['map.view', 'map.views', false],
    ['map.view', 'map', false],
    // single-segment wildcard
    ['map.*', 'map.view', true],
    ['map.*', 'map.view.zoom', false],
    ['map.*', 'map', false],
    ['*.view', 'map.view', true],
    ['sk.*.value', 'sk.navigation.value', true],
    ['sk.*.value', 'sk.navigation.position.value', false],
    // multi-segment wildcard
    ['sk.**', 'sk.navigation.speedOverGround', true],
    ['sk.**', 'sk.a.b.c.d', true],
    ['sk.**', 'sk', true],
    ['sk.**', 'state.changed', false],
    ['**', 'anything.at.all', true],
    ['sk.navigation.**', 'sk.navigation.position', true],
    ['sk.navigation.**', 'sk.electrical.batteries', false],
    // mid-pattern **
    ['sk.**.state', 'sk.electrical.switches.demo.state', true],
    ['sk.**.state', 'sk.state', true],
    ['sk.**.state', 'sk.electrical.value', false]
  ]

  for (const [pattern, name, expected] of cases) {
    it(`'${pattern}' vs '${name}' -> ${expected}`, () => {
      expect(matchesPattern(pattern, name)).toBe(expected)
    })
  }
})

describe('matchesAny', () => {
  it('returns true when any pattern matches', () => {
    expect(matchesAny(['a.b', 'sk.**'], 'sk.navigation')).toBe(true)
  })
  it('returns false when none match', () => {
    expect(matchesAny(['a.b', 'c.*'], 'sk.navigation')).toBe(false)
  })
  it('handles empty pattern lists', () => {
    expect(matchesAny([], 'sk.navigation')).toBe(false)
  })
})
