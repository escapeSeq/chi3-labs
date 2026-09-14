export const MS_PER_KNOT = 0.514444;

export function knotsToMs(knots) {
  return knots * MS_PER_KNOT;
}

export function msToKnots(ms) {
  return ms / MS_PER_KNOT;
}
