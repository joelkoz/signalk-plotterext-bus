/**
 * Lon/lat bounding boxes, as every box in the Plotter Extensions API is written:
 * `[west, south, east, north]` in decimal degrees (the GeoJSON / RFC 7946 §5
 * order), with longitudes in `[-180, 180]`. A box that crosses the antimeridian
 * has `west` greater than `east` (RFC 7946 §5.2): `[175, -21, -175, -13]` is ten
 * degrees wide around 180°. See the spec, "Bounding boxes".
 *
 * Map engines work in the *unwrapped* form instead — `west < east`, with
 * longitudes running past ±180 once the view scrolls into another copy of the
 * world. {@link normalizeBounds} converts either form to the API's.
 */
export type LonLatBounds = [number, number, number, number]

/** `lon` wrapped into `[-180, 180]`; a longitude already in range is kept. */
function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) {
    return lon
  }
  return ((((lon + 180) % 360) + 360) % 360) - 180
}

/**
 * Degrees of longitude a box in the API's form spans, 0–360: `east - west`, or
 * the way round the antimeridian when `west > east`. A box from `-180` to `180`
 * spans 360.
 */
export function boundsLonSpan(bounds: LonLatBounds): number {
  const [west, , east] = bounds
  return east >= west ? east - west : east - west + 360
}

/** Whether a box in the API's form takes in longitude `lon`. */
export function boundsContainsLon(bounds: LonLatBounds, lon: number): boolean {
  const [west, , east] = bounds
  const l = wrapLon(lon)
  return west <= east ? l >= west && l <= east : l >= west || l <= east
}

/**
 * A box in the API's form, from either that form or the unwrapped form map
 * engines use (`east` past 180 or `west` past -180, with `west < east`).
 * Longitudes are wrapped into `[-180, 180]`, so a box straddling 180° comes out
 * with `west > east`; a box 360 or more degrees wide becomes
 * `[-180, south, 180, north]`. Undefined when it is not a box: not four finite
 * numbers, a latitude outside `[-90, 90]`, or `south` greater than `north`.
 */
export function normalizeBounds(bounds: unknown): LonLatBounds | undefined {
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return undefined
  }
  const [west, south, east, north] = bounds as LonLatBounds
  if (south < -90 || north > 90 || south > north) {
    return undefined
  }
  const w = wrapLon(west)
  const e = wrapLon(east)
  const span = west <= east ? east - west : boundsLonSpan([w, south, e, north])
  if (span >= 360) {
    return [-180, south, 180, north]
  }
  return [w, south, e, north]
}
