/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Price scale of a pane (aq engine): field [lo, hi] in the transformed space (price, or the logarithm of the price in logarithmic
 * scale) running from `height` pixels to 0. In automatic mode the field follows the minimum and maximum of the visible bars with
 * margins above and below (TradingView: 10% and 8% in the price pane); dragging the scale or the chart vertically turns automatic
 * mode off, and a double click on the scale turns it back on.
 */
export class PriceScale {
  constructor({ marginTop = 0.1, marginBottom = 0.08, log = false } = {}) {
    this.marginTop = marginTop;
    this.marginBottom = marginBottom;
    this.log = log;
    this.auto = true;
    this.height = 0;
    this.lo = 0;
    this.hi = 1;
  }
  f(p) { return this.log ? Math.log(Math.max(p, 1e-12)) : p; }
  inv(v) { return this.log ? Math.exp(v) : v; }
  /**
   * Pixels over which the field is stretched: as in Lightweight Charts (observed) the field [lo, hi] runs from row 0 to row height
   * − 1, so the lowest price falls on the last visible row (the base of the volume is visible) and not one row below.
   */
  get span() { return Math.max(1, this.height - 1); }
  /**
   * y in CSS pixels from the top of the pane. Rounded to 10^-9: LW's results for prices that fall on a whole row (the field
   * minimum on the last row, round prices) are exact integers, while division in double precision gave 358.99999999999994; at DPR
   * 1.5 and 2.5 the row (· dpr = 538.5) was then rounded the wrong way and the histogram base row was missing.
   */
  toY(p) { return Math.round(((this.hi - this.f(p)) / (this.hi - this.lo)) * this.span * 1e9) / 1e9; }
  fromY(y) { return this.inv(this.hi - (y / this.span) * (this.hi - this.lo)); }

  /**
   * Automatic field from the minimum and maximum visible prices (does nothing if they are not finite), with LW's margins:
   * fractions of the height plus optional pixels (above/below, from autoscaleInfo). The maximum falls on row marginTop·height, the
   * minimum on row height − 1 − marginBottom·height.
   */
  fit(min, max, above = 0, below = 0) {
    if (!(min <= max) || !Number.isFinite(min) || !Number.isFinite(max)) return false;
    let a = this.f(min), b = this.f(max);
    if (b - a < 1e-12 * Math.max(1, Math.abs(a))) {
      const d = Math.abs(a) * 0.005 || 0.5;
      a -= d; b += d;
    }
    const K = this.span, H = Math.max(1, this.height);
    const tm = this.marginTop * H + above, bm = this.marginBottom * H + below;
    const inner = K - tm - bm > 1 ? K - tm - bm : K * Math.max(0.05, 1 - this.marginTop - this.marginBottom);
    const full = ((b - a) * K) / inner;
    this.hi = b + (full * (inner === K - tm - bm ? tm : this.marginTop * K)) / K;
    this.lo = this.hi - full;
    return true;
  }

  /** Vertical shift by dy pixels (positive: the content moves down). */
  pan(dy) {
    const d = (dy / this.span) * (this.hi - this.lo);
    this.hi += d; this.lo += d;
    this.auto = false;
  }

  /** Vertical zoom around the centre (factor > 1 narrows the field: larger prices). */
  zoom(factor, anchorY = this.height / 2) {
    const a = this.hi - (anchorY / this.span) * (this.hi - this.lo);
    const span = (this.hi - this.lo) / factor;
    if (!(span > 1e-12)) return;
    const t = anchorY / this.span;
    this.hi = a + span * t;
    this.lo = this.hi - span;
    this.auto = false;
  }
}

/**
 * Price grid steps, measured on LW (grid 400 px tall with fields from 0.01 to 100,000: minimum spacing 2.5 times the font, and the
 * step is the smallest round one with at least that space): from units upward 1, 2, 2.5, 4, 5 × 10^k; below one only 1, 2, 5 ×
 * 10^k (0.25 and 0.4 never appear: observed with fields from 0.01 to 10 and prices from 0.05 to 600).
 */
const STEPS = [1, 2, 2.5, 4, 5, 10], STEPS_FRAC = [1, 2, 5, 10];
/**
 * Steps below one when the price has a minimum step (`minMove`) that is not a power of ten, measured on LW (measurement bench;
 * fixture test/fixtures/lw-measures-minmove.json): in units of minMove, the first step is 1 and then it is multiplied by 2.5 and
 * by 2 alternately while factors of 5 of 1/minMove remain, then doubled up to 1/minMove (1/minMove = 25: 1, 2.5, 5, 12.5, 25, that
 * is 0.04, 0.1, 0.2, 0.5, 1). For powers of ten (0.1, 0.01...) the steps are the usual 1-2-5. Returns the increasing prices up to
 * 1, or null if 1/minMove is not of the form 2^a·5^b (LW throws "unexpected base" for other values: 0.03, 0.3, 0.4...) or is a
 * power of ten.
 */
const LADDERS = new Map();
function minMoveLadder(mm) {
  if (LADDERS.has(mm)) return LADDERS.get(mm);
  let out = null;
  const N = 1 / mm, Nr = Math.round(N);
  if (mm > 0 && mm < 1 && Math.abs(Nr * mm - 1) < 1e-9 && Nr >= 2) {
    let r = Nr, a = 0, b = 0;
    while (r % 2 === 0) { r /= 2; a++; }
    while (r % 5 === 0) { r /= 5; b++; }
    const pow10 = r === 1 && a === b;
    if (r === 1 && !pow10) {
      const u = [1]; let cur = 1, fives = b, turn = true;
      while (cur < Nr - 1e-9) { if (turn && fives > 0) { cur *= 2.5; fives--; } else cur *= 2; turn = !turn; u.push(cur); }
      out = u.map((x) => +(x * mm).toPrecision(12));
    }
  }
  LADDERS.set(mm, out);
  return out;
}

/** "Round" step ≥ raw; with `minMove` (≤ 1) never below it and, if it is not a power of ten, with its steps below one. */
export function niceStep(raw, minMove) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  if (minMove > 0 && minMove <= 1 && Math.abs(Math.round(1 / minMove) * minMove - 1) < 1e-9) { // non-integer 1/minMove (0.8, 0.6): no rule, inconsistent measurements (and values that no market uses)
    if (raw <= minMove * (1 + 1e-9)) return minMove;
    const lad = minMoveLadder(minMove);
    if (lad && raw <= 1) for (const v of lad) if (v >= raw * (1 - 1e-9)) return v;
  }
  const e = Math.floor(Math.log10(raw)), m = 10 ** e;
  for (const s of STEPS) { const v = s * m; if (v >= raw * (1 - 1e-9) && (v >= 1 || STEPS_FRAC.includes(s))) return +v.toPrecision(12); }
  return 10 * m;
}

/** Prices of the grid lines and scale labels, from bottom to top, with at least minPx pixels between two. */
export function priceTicks(scale, minPx = 33, minMove) {
  const h = scale.height;
  if (!(h > 0) || !(scale.hi > scale.lo)) return [];
  const out = [];
  if (!scale.log) {
    const step = niceStep(((scale.hi - scale.lo) / h) * minPx, minMove);
    const first = Math.ceil(scale.lo / step);
    for (let k = first; k * step <= scale.hi && out.length < 500; k++) out.push(+(k * step).toPrecision(12));
    return out;
  }
  // logarithmic: the round step changes going up; the next line is the first multiple of the step at least minPx higher
  const top = scale.fromY(0), bot = scale.fromY(h);
  let t = Math.ceil(bot / niceStep(scale.fromY(h - minPx) - bot)) * niceStep(scale.fromY(h - minPx) - bot);
  while (t <= top && out.length < 500) {
    out.push(+t.toPrecision(12));
    const target = scale.fromY(scale.toY(t) - minPx);
    const step = niceStep(target - t);
    t = Math.ceil(target / step - 1e-9) * step;
  }
  return out;
}

/** Price decimals (from the most precise of the given values, at most `max`). */
export function precisionOf(values, max = 8) {
  let dec = 0;
  const n = values.length, step = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i += step) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const s = Math.abs(v).toFixed(max), dot = s.indexOf('.');
    let end = s.length;
    while (end > dot + 1 && s[end - 1] === '0') end--;
    if (end - dot - 1 > dec) dec = end - dot - 1;
    if (dec >= max) break;
  }
  return dec;
}

const FMT = new Map();
/** Price with `dec` decimals (the browser's decimal separator, without thousands separator, as in Lightweight Charts). */
export function fmtPrice(p, dec, locale = 'en-US') {
  if (!Number.isFinite(p)) return '';
  let f = FMT.get(locale + dec);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });
    FMT.set(locale + dec, f);
  }
  const t = f.format(p);
  return t.charCodeAt(0) === 45 ? '−' + t.slice(1) : t; // true minus sign (U+2212) as in LW: wider than the hyphen (measured from the scale width)
}

/** Compact volume (12.3K, 4.5M). */
export function fmtVolume(v, locale = 'en-US') {
  const a = Math.abs(v);
  if (a >= 1e9) return fmtPrice(v / 1e9, 2, locale) + 'B';
  if (a >= 1e6) return fmtPrice(v / 1e6, 2, locale) + 'M';
  if (a >= 1e3) return fmtPrice(v / 1e3, 2, locale) + 'K';
  return fmtPrice(v, a < 10 && a % 1 ? 2 : 0, locale);
}
