/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Time scale of the AnubiCharts drawing engine. The space is bar indices: bar i has its centre at x(i) = width - (right - i) *
 * spacing, where `right` is the index (with its fractional part) that falls on the right edge of the pane area and `spacing` is
 * the number of CSS pixels per bar. Zoom and scroll only change these two numbers: the data on the GPU stays in index and price
 * coordinates and drawing transforms it with two uniforms (nothing to recompute on the CPU when moving the chart).
 */
export class TimeScale {
  constructor({ spacing = 7, rightOffset = 8, minSpacing = 0.01, maxSpacing = 120 } = {}) {
    this.n = 0;
    this.width = 0;
    this.spacing = spacing;
    this.rightOffset = rightOffset;
    this.minSpacing = minSpacing;
    this.maxSpacing = maxSpacing;
    this.right = rightOffset + 0.5 - 1; // with n = 0
    this.pad = 0; // pixels removed on the right: 1 in the compatibility layer, where LW puts the bar at width - 1 - (...)
  }

  /** Centre of bar i in CSS pixels (also for indices outside the data: future space). */
  x(i) { return this.width - this.pad - (this.right - i) * this.spacing; }
  /** Index (with decimals) at coordinate x. */
  index(x) { return this.right - (this.width - this.pad - x) / this.spacing; }
  /** Index of the bar nearest to x (may be outside the data). */
  nearest(x) { return Math.round(this.index(x)); }

  /** Data bars at least partly visible: {first, last} integers (last < first if none). */
  visible() {
    const lo = this.index(0) - 0.5, hi = this.index(this.width) + 0.5;
    return { first: Math.max(0, Math.ceil(lo)), last: Math.min(this.n - 1, Math.floor(hi)) };
  }

  /** Minimum spacing: at least the whole history in half of the area. */
  minFor() { return Math.max(this.minSpacing, this.width > 0 && this.n > 0 ? (this.width * 0.5) / this.n : this.minSpacing); }

  clamp() {
    const s = Math.min(this.maxSpacing, Math.max(this.minFor(), this.spacing));
    this.spacing = s;
    const vis = this.width / s;
    // on the right at most until 2 bars are left on the left edge; on the left until the first bar is left on the right edge
    const hi = this.n - 2 + vis, lo = Math.min(1, hi);
    if (this.right > hi) this.right = hi;
    if (this.right < lo) this.right = lo;
  }

  setWidth(w) {
    // the right edge stays fixed (as on TradingView): what changes is how many bars are visible on the left
    this.width = w;
    this.clamp();
  }

  /** Scroll by dx pixels (positive: the content moves right, looking further back). */
  pan(dx) {
    this.right -= dx / this.spacing;
    this.clamp();
  }

  /** Zoom by a factor (>1 means wider bars) keeping the index under anchorX fixed. */
  zoom(factor, anchorX = this.width) {
    const idx = this.index(anchorX);
    this.spacing = Math.min(this.maxSpacing, Math.max(this.minFor(), this.spacing * factor));
    this.right = idx + (this.width - anchorX) / this.spacing;
    this.clamp();
  }

  /** Last bar in view: new bars move the view (TradingView); further back the view stays still. */
  following() { return this.n === 0 || this.x(this.n - 1) <= this.width + 0.5 * this.spacing; }

  /** New number of bars: `added` at the end, `prepended` at the start (history loaded on the left). */
  setCount(n, { prepended = 0 } = {}) {
    const follow = this.following(), added = n - this.n - prepended;
    if (prepended) this.right += prepended;
    if (added > 0 && follow && this.n > 0) this.right += added;
    if (this.n === 0) this.right = n - 1 + this.rightOffset + 0.5;
    this.n = n;
    this.clamp();
  }

  /** Default view: last bar at rightOffset bars from the edge, given spacing. */
  reset(spacing = 7) {
    this.spacing = spacing;
    this.right = this.n - 1 + this.rightOffset + 0.5;
    this.clamp();
  }

  /** Shows bars [a, b] (indices) in the area. */
  showRange(a, b) {
    const bars = Math.max(1, b - a + 1);
    this.spacing = this.width / bars;
    this.right = b + 0.5;
    this.clamp();
  }
}
