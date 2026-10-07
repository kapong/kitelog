/**
 * TensorBoard-style debiased EMA. `weight` in [0, 1): 0 = raw. Steps may be unevenly spaced
 * after downsampling; the EMA runs over the points as given (same as TensorBoard).
 */
export function ema(values: ArrayLike<number>, weight: number): number[] {
  const out = new Array<number>(values.length);
  let last = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = v;
      continue;
    }
    n++;
    last = last * weight + (1 - weight) * v;
    out[i] = weight === 0 ? v : last / (1 - Math.pow(weight, n));
  }
  return out;
}

/** Index of the point in sorted `xs` closest to `x` (-1 if empty). */
export function nearest(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && x - xs[lo - 1] < xs[lo] - x ? lo - 1 : lo;
}
