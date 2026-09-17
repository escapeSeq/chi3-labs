/** Seeded RNG: uniform [0,1), gaussian, and weighted choice. */

export function mulberry32(seed) {
  let a = seed | 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function uniform(rng, lo, hi) {
  return lo + (hi - lo) * rng();
}

export function choice(rng, n, probs) {
  let r = rng();
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += probs[i];
    if (r <= acc) return i;
  }
  return n - 1;
}

export function clip(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
