/**
 * eventemitter2-style wildcard matching for dot-separated event names.
 *
 * - `*` matches exactly one segment.
 * - `**` matches zero or more segments (any remainder when trailing).
 */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true
  return match(pattern.split('.'), 0, name.split('.'), 0)
}

function match(p: string[], pi: number, n: string[], ni: number): boolean {
  while (pi < p.length) {
    const seg = p[pi]
    if (seg === '**') {
      if (pi === p.length - 1) return true
      for (let skip = ni; skip <= n.length; skip++) {
        if (match(p, pi + 1, n, skip)) return true
      }
      return false
    }
    if (ni >= n.length) return false
    if (seg !== '*' && seg !== n[ni]) return false
    pi++
    ni++
  }
  return ni === n.length
}

export function matchesAny(patterns: Iterable<string>, name: string): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(pattern, name)) return true
  }
  return false
}
