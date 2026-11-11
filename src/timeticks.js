/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Time axis labels. Each bar has a "weight": the most important boundary it crosses relative to the previous bar (year > month >
 * day > 12 hours > ... > second), computed on the clock of the chart's time zone. Labels are chosen from the highest weight to the
 * lowest, keeping only those at least `minDist` pixels from those already chosen: this is the TradingView scheme (year "2026",
 * month "Mar", day "12", hours "14:30").
 */

export const W_YEAR = 100, W_MONTH = 90, W_DAY = 80;
/**
 * Levels below the day: period in ms and weight. The 10-minute level exists because on LW, with 1-minute bars at 8-12 px, labels
 * appear every 10 minutes.
 */
export const SUBDAY = [
  [12 * 3600e3, 72], [6 * 3600e3, 71], [3 * 3600e3, 70], [3600e3, 60],
  [30 * 60e3, 54], [15 * 60e3, 53], [10 * 60e3, 52], [5 * 60e3, 51], [60e3, 40],
  [30e3, 34], [15e3, 33], [10e3, 32], [5e3, 31], [1e3, 20],
];
const DAY = 86400e3;

/**
 * Function from UTC ms to time-zone clock ms (the UTC date of that number is the local time). 'UTC' or empty: identity.
 * The offset is requested from Intl once per quarter hour (clock changes fall on quarters).
 */
export function wallClock(tz) {
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return (ms) => ms;
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch { return (ms) => ms; }
  const cache = new Map();
  return (ms) => {
    const key = Math.floor(ms / 900e3);
    let off = cache.get(key);
    if (off === undefined) {
      const t = key * 900e3;
      const p = {};
      for (const { type, value } of fmt.formatToParts(t)) p[type] = +value;
      off = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - t;
      if (cache.size > 20000) cache.clear();
      cache.set(key, off);
    }
    return ms + off;
  };
}

/** Weight of the boundary between two local clock times (pw: previous bar; null = first bar). */
export function weightOf(w, pw) {
  if (pw == null || !(w > pw)) return pw == null ? W_DAY : 0;
  const d = Math.floor(w / DAY), pd = Math.floor(pw / DAY);
  if (d !== pd) {
    const a = new Date(w), b = new Date(pw);
    if (a.getUTCFullYear() !== b.getUTCFullYear()) return W_YEAR;
    if (a.getUTCMonth() !== b.getUTCMonth()) return W_MONTH;
    return W_DAY;
  }
  for (const [p, wt] of SUBDAY) if (Math.floor(w / p) !== Math.floor(pw / p)) return wt;
  return 0;
}

/** Weights of all bars (Uint8Array), from UTC times in ms. */
export function weights(times, wall, out = null, from = 0) {
  const n = times.length;
  const w = out && out.length >= n ? out : new Uint8Array(n);
  if (out && out !== w) w.set(out.subarray(0, Math.min(out.length, n)));
  let prev = from > 0 ? wall(times[from - 1]) : null;
  for (let i = from; i < n; i++) {
    const cur = wall(times[i]);
    w[i] = weightOf(cur, prev);
    prev = cur;
  }
  return w;
}

/**
 * Indices of the labels to show in [from, to]: weightAt(i) → weight, xOf(i) → pixel. From the highest weight, each at least
 * minDist from the others. Returns [{ i, x, w }] ordered by x.
 */
export function pickTicks(from, to, weightAt, xOf, minDist, maxCount = 200) {
  if (to < from) return [];
  const byW = new Map();
  for (let i = from; i <= to; i++) {
    const w = weightAt(i);
    if (!w) continue;
    let a = byW.get(w);
    if (!a) byW.set(w, (a = []));
    a.push(i);
  }
  const levels = [...byW.keys()].sort((a, b) => b - a);
  const xs = []; // sorted
  const out = [];
  const fits = (x) => {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; }
    return (lo === xs.length || xs[lo] - x >= minDist) && (lo === 0 || x - xs[lo - 1] >= minDist) ? lo : -1;
  };
  for (const w of levels) {
    for (const i of byW.get(w)) {
      const x = xOf(i);
      const at = fits(x);
      if (at < 0) continue;
      xs.splice(at, 0, x);
      out.push({ i, x, w });
      if (out.length >= maxCount) break;
    }
    if (out.length >= maxCount) break;
  }
  return out.sort((a, b) => a.x - b.x);
}

/**
 * Index of bars by weight (for each weight the indices in order): label selection only scans the high weights until the axis is
 * full, without visiting every visible bar on each frame (20,000 bars in view: 2.4 ms → ~0.1 ms).
 */
export class TickIndex {
  constructor() { this.lists = new Map(); this.levels = []; }
  build(w, n) {
    const counts = new Map();
    for (let i = 0; i < n; i++) if (w[i]) counts.set(w[i], (counts.get(w[i]) || 0) + 1);
    this.lists = new Map();
    for (const [k, c] of counts) this.lists.set(k, { a: new Int32Array(Math.max(16, c)), n: 0 });
    for (let i = 0; i < n; i++) if (w[i]) { const l = this.lists.get(w[i]); l.a[l.n++] = i; }
    this.levels = [...this.lists.keys()].sort((a, b) => b - a);
  }
  /** Bar i (new, at the end) with weight w. */
  push(i, w) {
    if (!w) return;
    let l = this.lists.get(w);
    if (!l) { l = { a: new Int32Array(16), n: 0 }; this.lists.set(w, l); this.levels = [...this.lists.keys()].sort((a, b) => b - a); }
    if (l.n && l.a[l.n - 1] >= i) return;
    if (l.n === l.a.length) { const b = new Int32Array(l.a.length * 2); b.set(l.a); l.a = b; }
    l.a[l.n++] = i;
  }
  /** Like pickTicks, on the data bars in [from, to]; `extra` = additional candidates [{ i, w }] (future bars). */
  pick(from, to, xOf, minDist, extra = [], maxCount = 200, fillW = 0, keep = null) {
    const xs = [], out = [];
    const tryAdd = (i, w) => {
      const x = xOf(i);
      let lo = 0, hi = xs.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; }
      if ((lo < xs.length && xs[lo] - x < minDist - 1e-6) || (lo > 0 && x - xs[lo - 1] < minDist - 1e-6)) return;
      xs.splice(lo, 0, x);
      out.push({ i, x, w });
    };
    const levels = [...new Set([...this.levels, ...extra.map((e) => e.w)])].filter((w) => !keep || keep(w)).sort((a, b) => b - a);
    const span = Math.abs(xOf(to) - xOf(from)) + minDist, cap = Math.min(maxCount, Math.floor(span / minDist) + 1);
    for (const w of levels) {
      const l = this.lists.get(w);
      if (l) {
        let lo = 0, hi = l.n;
        while (lo < hi) { const m = (lo + hi) >> 1; if (l.a[m] < from) lo = m + 1; else hi = m; }
        // step: one bar every `skip` if the level is much denser than the space (the labels of this level would fall one every
        // minDist pixels anyway)
        let end = lo;
        { let a = lo, b = l.n; while (a < b) { const m = (a + b) >> 1; if (l.a[m] <= to) a = m + 1; else b = m; } end = a; }
        // anchored to the ordinal number in the level list (not to the window): while scrolling the chosen labels do not change
        const sp = Math.abs(xOf(from + 1) - xOf(from)) || 1e-9;
        const avg = l.n > 1 ? (l.a[l.n - 1] - l.a[0]) / (l.n - 1) : 1;
        const skip = Math.max(1, Math.ceil((minDist - 1e-6) / (avg * sp)));
        let k = lo + ((skip - (lo % skip)) % skip);
        for (; k < end && out.length < cap; k += skip) tryAdd(l.a[k], w);
      }
      for (const e of extra) if (e.w === w && out.length < cap) tryAdd(e.i, w);
      if (out.length >= cap) break;
    }
    // filling (measured on LW): where space is left, labels are added on bars without a boundary, from left to right, each time at
    // the first bar that is at least minDist from the labels already placed (with 1-minute bars at 40 px: 11:20 11:22 11:25
    // 11:27...)
    if (out.length < cap) {
      // candidates anchored at index 0 (multiples of the step in bars), not at the left edge: they do not change while scrolling
      const stepF = Math.max(1, minDist / Math.max(1e-9, Math.abs(xOf(from + 1) - xOf(from))));
      for (let m = Math.max(0, Math.floor(from / stepF)); out.length < cap; m++) {
        const i = Math.ceil(m * stepF - 1e-9);
        if (i > to) break;
        if (i < from) continue;
        const x = xOf(i);
        if (x < 0.5 * minDist) continue; // no filling near the left edge (measured on LW)
        let lo = 0, hi = xs.length;
        while (lo < hi) { const mm = (lo + hi) >> 1; if (xs[mm] < x) lo = mm + 1; else hi = mm; }
        if ((lo < xs.length && xs[lo] - x < minDist - 1e-6) || (lo > 0 && x - xs[lo - 1] < minDist - 1e-6)) continue;
        xs.splice(lo, 0, x); out.push({ i, x, w: fillW });
      }
    }
    return out.sort((a, b) => a.x - b.x);
  }
}

const pad = (v) => (v < 10 ? '0' : '') + v;
const MONTHS = new Map(), DAYS = new Map();
function monthNames(locale) {
  let m = MONTHS.get(locale);
  if (!m) {
    const f = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    m = Array.from({ length: 12 }, (_, k) => f.format(Date.UTC(2026, k, 15)).replace('.', ''));
    MONTHS.set(locale, m);
  }
  return m;
}

/** Label text for a local time `w` (clock ms) and its weight. */
export function tickLabel(w, weight, locale = 'en-US') {
  const d = new Date(w);
  if (weight >= W_YEAR) return String(d.getUTCFullYear());
  if (weight >= W_MONTH) return monthNames(locale)[d.getUTCMonth()];
  if (weight >= W_DAY) return String(d.getUTCDate());
  const hm = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
  return weight >= 40 ? hm : hm + ':' + pad(d.getUTCSeconds());
}

/**
 * Full date and time for the crosshair label ("Thu 12 Mar '26 14:30"); `intraday`: with the time, `seconds`: with seconds.
 */
export function crossLabel(w, { locale = 'en-US', intraday = true, seconds = false } = {}) {
  const d = new Date(w);
  let days = DAYS.get(locale);
  if (!days) {
    const f = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
    days = Array.from({ length: 7 }, (_, k) => f.format(Date.UTC(2026, 10, 1 + k)).replace('.', '')); // 1/11/2026 is a Sunday
    DAYS.set(locale, days);
  }
  const wd = days[d.getUTCDay()];
  const s = `${wd} ${d.getUTCDate()} ${monthNames(locale)[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  if (!intraday) return s;
  return `${s}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? ':' + pad(d.getUTCSeconds()) : ''}`;
}
