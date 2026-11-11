/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Data of the Lightweight Charts-compatible layer (lw.js).
 * TimeIndex: LW's time scale = sorted union of the times of all series; the logical index of a time is its position. A series with
 * new times makes it rebuild (and all series rebuild the indices of their points).
 * SeriesStore: the points of a series in columns (time, logical index, values, point colours), with a pyramid of levels over the
 * POSITIONS of the points (level k collects 2^k consecutive points: minimum, maximum and their positions). It serves the automatic
 * scale (minimum and maximum of the visible points in O(log n)) and zooming out: the level at which a group occupies one or two
 * pixels is drawn. The GPU packets (pack*) are rebuilt only from the first changed group.
 */
import { NA } from './lod.js';

const grow = (a, n, C) => { if (a.length >= n) return a; const b = new C(Math.max(n, a.length * 2, 64)); b.set(a); return b; };

export class TimeIndex {
  constructor() { this.t = new Float64Array(64); this.n = 0; this.map = new Map(); this.version = 0; this.refs = new Map(); }
  indexOf(t) { const i = this.map.get(t); return i === undefined ? -1 : i; }
  /**
   * How many series use each time: as in LW the scale is the union of the data, so a time that no series has any more must be
   * removed (before, it stayed: after a symbol change with the previous one's history loaded, the new candles ended up on logical
   * indices different from their positions and the view that the app requests by index fell where there was no data).
   */
  ref(t) { const c = this.refs.get(t) || 0; this.refs.set(t, c + 1); return c === 0; }
  /** Removes one use of the time; true if no series uses it any more (the key stays at 0 until `prune` removes it). */
  unref(t) { const c = (this.refs.get(t) || 0) - 1; this.refs.set(t, Math.max(0, c)); return c <= 0; }
  /** Removes the times in the list left without series; true if there was at least one. */
  prune(list) { let gone = false; for (const t of list) if (!this.refs.get(t)) { this.refs.delete(t); gone = true; } return gone; }
  /** First position with time ≥ t (n if none). */
  lower(t) { let lo = 0, hi = this.n; while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[m] < t) lo = m + 1; else hi = m; } return lo; }
  /** Rebuilt from the union of the times (sorted lists). */
  rebuild(lists) {
    let total = 0;
    for (const l of lists) total += l.length;
    const all = new Float64Array(total);
    let k = 0;
    for (const l of lists) { all.set(l, k); k += l.length; }
    all.sort();
    let n = 0;
    for (let i = 0; i < total; i++) if (i === 0 || all[i] !== all[i - 1]) all[n++] = all[i];
    this.t = all.length >= 64 ? all : grow(all, 64, Float64Array);
    this.n = n;
    this.map = new Map();
    for (let i = 0; i < n; i++) this.map.set(this.t[i], i);
    this.version++;
  }
  append(t) {
    this.t = grow(this.t, this.n + 1, Float64Array);
    this.t[this.n] = t;
    this.map.set(t, this.n);
    this.n++;
    this.version++;
  }
}

export const KIND_OHLC = 1, KIND_VALUE = 0;

export class SeriesStore {
  constructor(kind) {
    this.kind = kind;
    this.n = 0;
    this.cap = 0;
    this.items = [];
    this.alloc(64);
    this.levels = [null];
    this.gpu = [];
    this.base = 0;
    this.version = 0;
  }
  alloc(n) {
    const F = Float64Array, U = Uint32Array;
    this.t = grow(this.t || new F(0), n, F); this.pi = grow(this.pi || new F(0), n, F);
    if (this.kind === KIND_OHLC) { this.o = grow(this.o || new F(0), n, F); this.h = grow(this.h || new F(0), n, F); this.l = grow(this.l || new F(0), n, F); this.c = grow(this.c || new F(0), n, F); }
    else this.v = grow(this.v || new F(0), n, F);
    this.c1 = grow(this.c1 || new U(0), n, U); this.c2 = grow(this.c2 || new U(0), n, U); this.c3 = grow(this.c3 || new U(0), n, U);
    this.has = grow(this.has || new Uint8Array(0), n, Uint8Array);
    this.cap = this.t.length;
  }
  get lo() { return this.kind === KIND_OHLC ? this.l : this.v; }
  get hi() { return this.kind === KIND_OHLC ? this.h : this.v; }
  /** Point i is empty (LW's whitespace). */
  empty(i) { return this.kind === KIND_OHLC ? !(this.c[i] === this.c[i]) : !(this.v[i] === this.v[i]); }

  /** Logical indices of all points from the time scale. */
  remap(ti) { for (let i = 0; i < this.n; i++) this.pi[i] = ti.map.get(this.t[i]); this.dirty(0); }
  /** First position with logical index ≥ a. */
  lowerPos(a) { let lo = 0, hi = this.n; while (lo < hi) { const m = (lo + hi) >> 1; if (this.pi[m] < a) lo = m + 1; else hi = m; } return lo; }
  /** Positions [pa, pb] of the points with logical index in [a, b] (pb < pa if none). */
  posRange(a, b) { return [this.lowerPos(a), this.upperPos(b) - 1]; }
  /** First position with logical index > b. */
  upperPos(b) { let lo = 0, hi = this.n; while (lo < hi) { const m = (lo + hi) >> 1; if (this.pi[m] <= b) lo = m + 1; else hi = m; } return lo; }
  /** Last non-empty position (−1 if none). */
  lastFilled() { for (let i = this.n - 1; i >= 0; i--) if (!this.empty(i)) return i; return -1; }

  build() {
    this.levels = [null];
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      this.levels.push({ len, lo: new Float64Array(len), hi: new Float64Array(len), loP: new Int32Array(len), hiP: new Int32Array(len) });
      for (let j = 0; j < len; j++) this.merge(k, j);
      k++;
    }
    let b = 0;
    for (let i = this.n - 1; i >= 0; i--) { const v = this.kind === KIND_OHLC ? this.c[i] : this.v[i]; if (Number.isFinite(v)) { b = v; break; } }
    this.base = Math.abs(b) >= 1 ? Math.round(b) : 0;
    this.gpu = [];
    this.version++;
  }
  merge(k, j) {
    const d = this.levels[k], a = 2 * j, b = a + 1;
    let lo = Infinity, hi = -Infinity, loP = -1, hiP = -1;
    if (k === 1) {
      const L = this.lo, H = this.hi;
      for (const i of [a, b]) { if (i >= this.n) continue; if (L[i] < lo) { lo = L[i]; loP = i; } if (H[i] > hi) { hi = H[i]; hiP = i; } }
    } else {
      const s = this.levels[k - 1];
      for (const i of [a, b]) { if (i >= s.len || s.loP[i] < 0) continue; if (s.lo[i] < lo) { lo = s.lo[i]; loP = s.loP[i]; } if (s.hi[i] > hi) { hi = s.hi[i]; hiP = s.hiP[i]; } }
    }
    d.lo[j] = lo; d.hi[j] = hi; d.loP[j] = loP; d.hiP[j] = hiP;
  }
  /** Pyramid updated from position p on (appends and changes at the tail). */
  refresh(p) {
    let len = this.n, k = 1;
    while (len > 1) {
      len = Math.ceil(len / 2);
      let d = this.levels[k];
      if (!d) { d = { len, lo: new Float64Array(64), hi: new Float64Array(64), loP: new Int32Array(64), hiP: new Int32Array(64) }; this.levels[k] = d; }
      if (d.lo.length < len) { d.lo = grow(d.lo, len, Float64Array); d.hi = grow(d.hi, len, Float64Array); d.loP = grow(d.loP, len, Int32Array); d.hiP = grow(d.hiP, len, Int32Array); }
      d.len = len;
      for (let j = p >> k; j < len; j++) this.merge(k, j);
      k++;
    }
    this.levels.length = Math.max(1, k);
    this.dirty(p);
  }
  dirty(p) { for (let k = 0; k < this.gpu.length; k++) { const g = this.gpu[k]; if (g) g.dirtyB = Math.min(g.dirtyB, p >> k); } this.version++; }

  /** Minimum and maximum of positions [a, b] (empty points do not count). */
  range(a, b) {
    a = Math.max(0, a); b = Math.min(this.n - 1, b);
    let mn = Infinity, mx = -Infinity;
    if (b < a) return [mn, mx];
    let lo = a, hi = b, k = 0;
    const L0 = this.lo, H0 = this.hi;
    while (lo <= hi) {
      const L = k === 0 ? L0 : this.levels[k].lo, H = k === 0 ? H0 : this.levels[k].hi;
      if (lo & 1) { if (L[lo] < mn) mn = L[lo]; if (H[lo] > mx) mx = H[lo]; lo++; }
      if (!(hi & 1)) { if (L[hi] < mn) mn = L[hi]; if (H[hi] > mx) mx = H[hi]; hi--; }
      lo >>= 1; hi >>= 1; k++;
      if (k >= this.levels.length) break;
    }
    return [mn, mx];
  }
  count(k) { return k === 0 ? this.n : this.levels[k]?.len ?? (this.n ? 1 : 0); }

  cache(k, slots, words) {
    let g = this.gpu[k];
    const need = slots * words;
    if (!g || g.f.length < need) {
      const old = g;
      const f = new Float32Array(Math.max(need, (old?.f.length || 0) * 2, 64 * words));
      if (old) f.set(old.f);
      g = { k, f, u: new Uint32Array(f.buffer), n: old ? old.n : 0, nb: old ? old.nb : 0, dirtyB: old ? old.dirtyB : 0, from: 0 };
      this.gpu[k] = g;
    }
    return g;
  }

  /**
   * Points of lines and areas: slot 0 NA, then the points (level 0) or the minimum and maximum of each group in position order
   * (level k), then two NA. 3 words per slot. col(i) → packed colour of point i. `steps`: stepped line (only at level 0: each
   * point preceded by one with the previous value, with the point's colour, so the horizontal stroke has the colour of the
   * previous point and the vertical one that of the point).
   */
  packPoints(k, col, steps = false) {
    const st = steps && k === 0;
    const pts = k === 0 ? (st ? Math.max(0, 2 * this.n - 1) : this.n) : 2 * this.count(k);
    const g = this.cache(k, pts + 3, 3), f = g.f, u = g.u, base = this.base;
    const nb = k === 0 ? this.n : this.count(k);
    const fromB = Math.min(g.dirtyB, g.nb);
    const put = (s, i, v, c) => { f[3 * s] = i; f[3 * s + 1] = Number.isFinite(v) ? v - base : NA; u[3 * s + 2] = c; };
    put(0, 0, NaN, 0);
    let firstSlot;
    if (k === 0 && !st) {
      for (let i = fromB; i < this.n; i++) put(i + 1, this.pi[i], this.v[i], col(i));
      firstSlot = fromB;
    } else if (st) {
      // stepped: everything (stepped lines are few)
      let s = 1;
      for (let i = 0; i < this.n; i++) {
        if (i > 0) put(s++, this.pi[i], this.v[i - 1], col(i - 1));
        put(s++, this.pi[i], this.v[i], col(i));
      }
      firstSlot = 0;
    } else {
      const d = this.levels[k], len = d.len;
      for (let j = fromB; j < len; j++) {
        const s = 2 * j + 1;
        if (d.loP[j] < 0) { const i = j << k; put(s, this.pi[Math.min(i, this.n - 1)], NaN, 0); put(s + 1, this.pi[Math.min(i, this.n - 1)], NaN, 0); continue; }
        const a = Math.min(d.loP[j], d.hiP[j]), b = Math.max(d.loP[j], d.hiP[j]);
        put(s, this.pi[a], this.v[a], col(a));
        put(s + 1, this.pi[b], this.v[b], col(b));
      }
      firstSlot = 2 * fromB;
    }
    const last = pts ? f[3 * pts] : 0;
    put(pts + 1, last, NaN, 0); put(pts + 2, last, NaN, 0);
    g.from = fromB >= nb && g.nb === nb && g.n === pts && !st ? Infinity : Math.min(firstSlot, pts);
    g.n = pts;
    g.nb = nb;
    g.dirtyB = Infinity;
    return g;
  }

  /** Histogram: one slot per point (level 0) or per group (the value furthest from the base), with the NA slot at the head. */
  packHist(k, col, baseVal) {
    const len = this.count(k);
    const g = this.cache(k, len + 3, 3), f = g.f, u = g.u, base = this.base;
    const fromB = Math.min(g.dirtyB, g.nb);
    const put = (s, i, v, c) => { f[3 * s] = i; f[3 * s + 1] = Number.isFinite(v) ? v - base : NA; u[3 * s + 2] = c; };
    put(0, 0, NaN, 0);
    if (k === 0) for (let i = fromB; i < len; i++) put(i + 1, this.pi[i], this.v[i], col(i));
    else {
      const d = this.levels[k];
      for (let j = fromB; j < len; j++) {
        if (d.loP[j] < 0) { put(j + 1, this.pi[Math.min(j << k, this.n - 1)], NaN, 0); continue; }
        const p = Math.abs(d.hi[j] - baseVal) >= Math.abs(d.lo[j] - baseVal) ? d.hiP[j] : d.loP[j];
        const a = j << k, b = Math.min(this.n - 1, a + (1 << k) - 1);
        put(j + 1, (this.pi[a] + this.pi[b]) / 2, this.v[p], col(p));
      }
    }
    put(len + 1, 0, NaN, 0); put(len + 2, 0, NaN, 0);
    g.from = fromB >= len && g.nb === len ? Infinity : fromB;
    g.n = len; g.nb = len;
    g.dirtyB = Infinity;
    return g;
  }

  /** Candles (8 words) or OHLC bars (6 words) of level k; cols(i, up) → [body, border, wick] of point i. */
  packOhlc(k, cols, words) {
    const len = this.count(k);
    const g = this.cache(k, len, words), f = g.f, u = g.u, base = this.base;
    const fromB = Math.min(g.dirtyB, g.nb);
    const d = k ? this.levels[k] : null;
    for (let j = fromB; j < len; j++) {
      const a = j << k, b = Math.min(this.n - 1, a + (1 << k) - 1), q = j * words;
      let o, h, l, c, last = b;
      if (k === 0) { o = this.o[a]; h = this.h[a]; l = this.l[a]; c = this.c[a]; }
      else {
        // first and last non-empty points of the group
        let fa = a; while (fa < b && this.empty(fa)) fa++;
        while (last > fa && this.empty(last)) last--;
        o = this.o[fa]; c = this.c[last]; h = d.hi[j]; l = d.lo[j];
      }
      f[q] = k ? (this.pi[a] + this.pi[b]) / 2 : this.pi[a];
      const ok = c === c;
      f[q + 1] = ok ? o - base : NA; f[q + 2] = ok ? h - base : NA; f[q + 3] = ok ? l - base : NA; f[q + 4] = ok ? c - base : NA;
      const cc = cols(last, c >= o);
      if (words === 8) { u[q + 5] = ok ? cc[0] : 0; u[q + 6] = ok ? cc[1] : 0; u[q + 7] = ok ? cc[2] : 0; }
      else u[q + 5] = ok ? cc[0] : 0;
    }
    g.from = fromB >= len && g.nb === len ? Infinity : fromB;
    g.n = len; g.nb = len;
    g.dirtyB = Infinity;
    return g;
  }
}
