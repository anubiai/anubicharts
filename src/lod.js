/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Data of the aq engine in columns, with a pyramid of levels for aggregated bars: level k collects 2^k bars (candles like a higher
 * timeframe: open of the first, close of the last, high and low; lines as minimum and maximum in the order in which they occur).
 * It serves two purposes:
 * - minimum and maximum of any interval in O(log n) (automatic scale on every frame, even with 100,000 bars)
 * - drawing when zoomed out: with bars narrower than one pixel, the level at which a group occupies ~1-2 pixels is drawn, so
 *    segments and rectangles stay at ~one per pixel whatever the number of bars in view.
 * The GPU packets (Float32Array) are in index and price coordinates relative to `base` (float32 precision): moving or zooming does
 * not change them. An update of the last bar rebuilds only the branch that contains it.
 */

const grow = (a, n, Ctor) => {
  if (a.length >= n) return a;
  const b = new Ctor(Math.max(n, a.length * 2, 64));
  b.set(a);
  return b;
};
export const NA = Math.fround(3.0e38); // missing value in the GPU packets (the shader recognises it with abs(v) > 1e38)

/** Level of detail: the lowest at which a group occupies at least `need` device pixels (0 = single bars). */
export function lodFor(spacingDev, need = 1) {
  let k = 0;
  while (spacingDev * 2 ** k < need && k < 30) k++;
  return k;
}
/**
 * Candles: a group ≥ 1 pixel. Lines: single points while bars are ≥ 1 pixel, then minimum and maximum (2 points) every 2 pixels.
 */
export const candleLod = (sp) => lodFor(sp, 1);
export const lineLod = (sp) => (sp >= 1 ? 0 : lodFor(sp, 2));

function query(lv0Lo, lv0Hi, levels, a, b) {
  let mn = Infinity, mx = -Infinity, lo = a, hi = b, k = 0;
  while (lo <= hi) {
    const L = k === 0 ? lv0Lo : levels[k].lo, H = k === 0 ? lv0Hi : levels[k].hi;
    if (lo & 1) { if (L[lo] < mn) mn = L[lo]; if (H[lo] > mx) mx = H[lo]; lo++; }
    if (!(hi & 1)) { if (L[hi] < mn) mn = L[hi]; if (H[hi] > mx) mx = H[hi]; hi--; }
    lo >>= 1; hi >>= 1; k++;
    if (k >= levels.length && lo <= hi) break; // cannot happen: the last level has a single element
  }
  return [mn, mx];
}

export class CandleStore {
  constructor() {
    this.n = 0;
    this.time = new Float64Array(0);
    this.o = new Float64Array(0); this.h = new Float64Array(0); this.l = new Float64Array(0); this.c = new Float64Array(0); this.v = new Float64Array(0);
    this.base = 0;
    this.levels = [null]; // levels[k] for k ≥ 1
    this.gpu = []; // gpu[k] = { f, n, dirty }
    this.version = 0;
  }

  /** bars: [{ openTime|time, open, high, low, close, volume }] (time in ms). */
  set(bars) {
    const n = bars.length;
    this.n = 0;
    this.reserve(n);
    for (let i = 0; i < n; i++) this.write(i, bars[i]);
    this.n = n;
    this.base = n ? Math.round(this.c[n - 1]) : 0;
    this.rebuild();
  }

  /** Older bars at the start (history). */
  prepend(bars) {
    const k = bars.length, n = this.n + k;
    const cols = ['time', 'o', 'h', 'l', 'c', 'v'];
    for (const name of cols) {
      const a = new Float64Array(Math.max(n, this[name].length));
      a.set(this[name].subarray(0, this.n), k);
      this[name] = a;
    }
    for (let i = 0; i < k; i++) this.write(i, bars[i]);
    this.n = n;
    this.rebuild();
  }

  /** Last bar: same open = replaced, next = appended. Returns 'update' | 'append' | null. */
  updateLast(bar) {
    const t = bar.openTime ?? bar.time;
    if (this.n && t === this.time[this.n - 1]) {
      this.write(this.n - 1, bar);
      this.refreshTail(this.n - 1);
      return 'update';
    }
    if (this.n && t < this.time[this.n - 1]) return null;
    this.reserve(this.n + 1);
    this.write(this.n, bar);
    this.n++;
    this.refreshTail(this.n - 1);
    return 'append';
  }

  reserve(n) {
    for (const name of ['time', 'o', 'h', 'l', 'c', 'v']) this[name] = grow(this[name], n, Float64Array);
  }
  write(i, b) {
    this.time[i] = b.openTime ?? b.time; this.o[i] = b.open; this.h[i] = b.high; this.l[i] = b.low; this.c[i] = b.close; this.v[i] = b.volume ?? 0;
  }

  rebuild() {
    this.levels = [null];
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      this.levels.push({ len, o: new Float64Array(len), h: new Float64Array(len), l: new Float64Array(len), c: new Float64Array(len), v: new Float64Array(len), lo: null, hi: null });
      this.levels[k].lo = this.levels[k].l; this.levels[k].hi = this.levels[k].h;
      for (let j = 0; j < len; j++) this.merge(k, j);
      k++;
    }
    this.gpu = [];
    this.version++;
  }

  merge(k, j) {
    const d = this.levels[k], s = k === 1 ? this : this.levels[k - 1], sl = k === 1 ? this.n : s.len;
    const a = 2 * j, b = a + 1;
    if (b < sl) {
      d.o[j] = s.o[a]; d.c[j] = s.c[b];
      d.h[j] = s.h[a] > s.h[b] ? s.h[a] : s.h[b];
      d.l[j] = s.l[a] < s.l[b] ? s.l[a] : s.l[b];
      d.v[j] = s.v[a] > s.v[b] ? s.v[a] : s.v[b];
    } else {
      d.o[j] = s.o[a]; d.c[j] = s.c[a]; d.h[j] = s.h[a]; d.l[j] = s.l[a]; d.v[j] = s.v[a];
    }
  }

  /** Branch of bar i (the last): levels updated, GPU packets marked to be rebuilt from there. */
  refreshTail(i) {
    // one more level when the bars exceed a power of 2
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      let d = this.levels[k];
      if (!d) {
        d = { len, o: new Float64Array(64), h: new Float64Array(64), l: new Float64Array(64), c: new Float64Array(64), v: new Float64Array(64) };
        this.levels[k] = d;
      }
      if (d.o.length < len) for (const name of ['o', 'h', 'l', 'c', 'v']) d[name] = grow(d[name], len, Float64Array);
      d.lo = d.l; d.hi = d.h; d.len = len;
      // with an append the last group of each level may be new (or may have gone from one to two children)
      this.merge(k, i >> k);
      k++;
    }
    this.levels.length = k;
    for (let q = 0; q < this.gpu.length; q++) {
      const g = this.gpu[q];
      if (g) g.dirty = Math.min(g.dirty, i >> q);
    }
    this.version++;
  }

  /** [minimum of the lows, maximum of the highs] of bars [a, b]. */
  range(a, b) {
    a = Math.max(0, a); b = Math.min(this.n - 1, b);
    if (b < a) return [Infinity, -Infinity];
    return query(this.l, this.h, this.levels, a, b);
  }
  /** Maximum volume of bars [a, b]. */
  volMax(a, b) {
    a = Math.max(0, a); b = Math.min(this.n - 1, b);
    if (b < a) return 0;
    const lv = this.levels.map((d) => d && { lo: d.v, hi: d.v });
    return query(this.v, this.v, lv, a, b)[1];
  }

  /** Number of groups of level k. */
  count(k) { return k === 0 ? this.n : this.levels[k]?.len ?? (this.n ? 1 : 0); }

  /**
   * GPU packet of level k: 6 floats per group (centre index, open, high, low, close relative to `base`, volume). `dirty`: first
   * group changed since the last upload (drawing resets it).
   */
  pack(k) {
    const len = this.count(k);
    let g = this.gpu[k];
    if (!g || g.f.length < len * 6) {
      const old = g;
      g = { f: new Float32Array(Math.max(len * 6, (old?.f.length || 0) * 2, 6 * 64)), n: old ? old.n : 0, dirty: old ? old.dirty : 0 };
      if (old) g.f.set(old.f); // the part already computed stays: the GPU receives all of it because the buffer changes size
      this.gpu[k] = g;
    }
    const from = Math.min(g.dirty, g.n, len);
    const src = k === 0 ? this : this.levels[k], B = 1 << k, base = this.base, f = g.f;
    for (let j = from; j < len; j++) {
      const start = j * B, cnt = Math.min(B, this.n - start), q = j * 6;
      f[q] = start + (cnt - 1) / 2;
      f[q + 1] = src.o[j] - base; f[q + 2] = src.h[j] - base; f[q + 3] = src.l[j] - base; f[q + 4] = src.c[j] - base; f[q + 5] = src.v[j];
    }
    g.from = from; // from here on it must be sent to the GPU again
    g.n = len;
    g.dirty = Infinity;
    return g;
  }
}

/** Series of values per bar (plot): NaN = na. */
export class LineStore {
  constructor() {
    this.n = 0;
    this.val = new Float64Array(0);
    this.levels = [null];
    this.gpu = [];
    this.base = 0;
    this.version = 0;
  }

  set(values) {
    const n = values.length;
    this.val = new Float64Array(Math.max(n, 64));
    for (let i = 0; i < n; i++) { const v = values[i]; this.val[i] = v == null ? NaN : v; }
    this.n = n;
    this.base = 0;
    for (let i = n - 1; i >= 0; i--) if (Number.isFinite(this.val[i])) { this.base = Math.round(this.val[i]); break; }
    this.rebuild();
  }

  /** Value of bar i (also a new one, at the end). */
  setAt(i, v) {
    if (i >= this.n) {
      this.val = grow(this.val, i + 1, Float64Array);
      for (let q = this.n; q < i; q++) this.val[q] = NaN;
      this.n = i + 1;
    }
    this.val[i] = v == null ? NaN : v;
    this.refreshTail(i);
  }

  rebuild() {
    this.levels = [null];
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      const d = { len, lo: new Float64Array(len), hi: new Float64Array(len), loI: new Int32Array(len), hiI: new Int32Array(len) };
      this.levels.push(d);
      for (let j = 0; j < len; j++) this.merge(k, j);
      k++;
    }
    this.gpu = [];
    this.version++;
  }

  merge(k, j) {
    const d = this.levels[k], a = 2 * j, b = a + 1;
    let lo = Infinity, hi = -Infinity, loI = -1, hiI = -1;
    if (k === 1) {
      for (const i of [a, b]) {
        if (i >= this.n) continue;
        const v = this.val[i];
        if (v < lo) { lo = v; loI = i; }
        if (v > hi) { hi = v; hiI = i; }
      }
    } else {
      const s = this.levels[k - 1];
      for (const i of [a, b]) {
        if (i >= s.len || s.loI[i] < 0) continue;
        if (s.lo[i] < lo) { lo = s.lo[i]; loI = s.loI[i]; }
        if (s.hi[i] > hi) { hi = s.hi[i]; hiI = s.hiI[i]; }
      }
    }
    d.lo[j] = lo; d.hi[j] = hi; d.loI[j] = loI; d.hiI[j] = hiI;
  }

  refreshTail(i) {
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      let d = this.levels[k];
      if (!d) { d = { len, lo: new Float64Array(64), hi: new Float64Array(64), loI: new Int32Array(64), hiI: new Int32Array(64) }; this.levels[k] = d; }
      if (d.lo.length < len) {
        d.lo = grow(d.lo, len, Float64Array); d.hi = grow(d.hi, len, Float64Array);
        d.loI = grow(d.loI, len, Int32Array); d.hiI = grow(d.hiI, len, Int32Array);
      }
      d.len = len;
      this.merge(k, i >> k);
      k++;
    }
    this.levels.length = k;
    for (let q = 0; q < this.gpu.length; q++) {
      const g = this.gpu[q];
      if (g) g.dirty = Math.min(g.dirty, q === 0 ? i : 2 * (i >> q));
    }
    this.version++;
  }

  range(a, b) {
    a = Math.max(0, a); b = Math.min(this.n - 1, b);
    if (b < a) return [Infinity, -Infinity];
    return query(this.val, this.val, this.levels, a, b);
  }

  count(k) { return k === 0 ? this.n : 2 * (this.levels[k]?.len ?? (this.n ? 1 : 0)); }

  /**
   * GPU points of level k: 2 floats per point (index, value relative to base; NA = missing). Point p sits in slot p + 1: slot 0 is
   * NA and there are two NA slots at the end, because every segment also reads the point before and the two after (joins). `n` is
   * in points, `from` (where to resend to the GPU) in slots. At level k ≥ 1 two points per group: minimum and maximum in the order
   * of their indices.
   */
  pack(k) {
    const pts = this.count(k), need = (pts + 3) * 2;
    let g = this.gpu[k];
    if (!g || g.f.length < need) {
      const old = g;
      g = { f: new Float32Array(Math.max(need, (old?.f.length || 0) * 2, 256)), n: old ? old.n : 0, dirty: old ? old.dirty : 0 };
      if (old) g.f.set(old.f);
      this.gpu[k] = g;
    }
    const from = Math.min(g.dirty, g.n, pts), base = this.base;
    const f = g.f.subarray(2); // point p → slot p + 1
    g.f[0] = 0; g.f[1] = NA;
    if (k === 0) {
      for (let i = from; i < pts; i++) {
        const v = this.val[i];
        f[2 * i] = i; f[2 * i + 1] = Number.isFinite(v) ? v - base : NA;
      }
    } else {
      const d = this.levels[k];
      for (let p = from - (from & 1); p < pts; p += 2) {
        const j = p >> 1, q = 2 * p;
        if (d.loI[j] < 0) { f[q] = j << k; f[q + 1] = NA; f[q + 2] = j << k; f[q + 3] = NA; continue; }
        const lowFirst = d.loI[j] <= d.hiI[j];
        const i1 = lowFirst ? d.loI[j] : d.hiI[j], i2 = lowFirst ? d.hiI[j] : d.loI[j];
        f[q] = i1; f[q + 1] = (lowFirst ? d.lo[j] : d.hi[j]) - base;
        f[q + 2] = i2; f[q + 3] = (lowFirst ? d.hi[j] : d.lo[j]) - base;
      }
    }
    for (let p = pts; p < pts + 2; p++) { f[2 * p] = pts ? f[2 * (pts - 1)] : 0; f[2 * p + 1] = NA; }
    // nothing changed: nothing to resend to the GPU (a bufferSubData on a buffer in use can stall the CPU)
    g.from = from >= pts && g.n === pts ? Infinity : Math.max(0, from - (from & 1));
    g.n = pts;
    g.dirty = Infinity;
    return g;
  }
}
