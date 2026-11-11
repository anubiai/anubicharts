/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Lightweight Charts v5-compatible layer on top of the AnubiQuant drawing engine. It exposes the same interface (createChart,
 * addSeries, timeScale, priceScale, panes, primitives, markers, price lines, crosshair) so the host application's chart, drawings,
 * tools and profiles run unchanged: the `?engine=aq` switch (chart-lib.js in the application) loads this file in place of the
 * library.
 * Drawing: one transparent WebGL canvas for all panes (grid, series, price lines: glx.js), for each pane a 2D canvas below
 * (drawBackground and "bottom" primitives) and one above ("normal"/"top" primitives, markers), 2D strips for the scales and one
 * canvas for the crosshair. A 2D canvas is cleared only if the previous frame drew something on it.
 * Logical indices: the time scale is the union of the times of all series (TimeIndex), as in LW; the centre of bar i is at x =
 * width − (right − i) · spacing, with `right` the index at the right edge (TimeScale of aq).
 */
import { TimeScale } from './timescale.js';
import { PriceScale, priceTicks, fmtPrice, fmtVolume } from './pricescale.js';
import { weightOf, TickIndex, tickLabel, crossLabel, W_DAY, SUBDAY } from './timeticks.js';
import { packRgba, rgba } from './gl.js';
import { dashFor } from './glx.js';
import { GlpRenderer } from './glprim.js';
import { candleWidth, candleParts, candleRects, histColumns, histGap, barParts, barRects, pointMarker } from './bars.js';
import { TimeIndex, SeriesStore, KIND_OHLC, KIND_VALUE } from './lw-data.js';
import { candleLod, lodFor } from './lod.js';
import { createLogo, placeLogo } from './logo.js';

export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 };
export const LineType = { Simple: 0, WithSteps: 1, Curved: 2 };
export const CrosshairMode = { Normal: 0, Magnet: 1, Hidden: 2, MagnetOHLC: 3 };
export const PriceScaleMode = { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 };
export const ColorType = { Solid: 'solid', VerticalGradient: 'gradient' };
export const LastPriceAnimationMode = { Disabled: 0, Continuous: 1, OnDataUpdate: 2 };
export const PriceLineSource = { LastBar: 0, LastVisible: 1 };
export const TickMarkType = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 };
export const MismatchDirection = { NearestLeft: -1, None: 0, NearestRight: 1 };
export const TrackingModeExitMode = { OnTouchEnd: 0, OnNextTap: 1 };

const COMMON = {
  lastValueVisible: true, title: '', visible: true, priceLineVisible: true, priceLineSource: 0, priceLineWidth: 1, priceLineColor: '',
  priceLineStyle: 2, baseLineVisible: true, baseLineColor: '#B2B5BE', baseLineWidth: 1, baseLineStyle: 0,
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, priceScaleId: 'right', lastPriceAnimation: 0,
};
// wickColor and borderColor given by the user apply to up and down bars if there are no per-side colours (as in LW)
const sideColors = (o) => {
  if (!o) return o;
  const r = { ...o };
  for (const k of ['wick', 'border']) if (o[k + 'Color'] != null && o[k + 'UpColor'] == null && o[k + 'DownColor'] == null) { r[k + 'UpColor'] = o[k + 'Color']; r[k + 'DownColor'] = o[k + 'Color']; }
  return r;
};
const def = (type, kind, o) => ({ type, kind, defaults: { ...COMMON, ...o } });
export const CandlestickSeries = def('Candlestick', KIND_OHLC, { upColor: '#26a69a', downColor: '#ef5350', wickVisible: true, borderVisible: true, borderColor: '#378658', borderUpColor: '#26a69a', borderDownColor: '#ef5350', wickColor: '#737375', wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
export const BarSeries = def('Bar', KIND_OHLC, { upColor: '#26a69a', downColor: '#ef5350', openVisible: true, thinBars: true });
export const LineSeries = def('Line', KIND_VALUE, { color: '#2196f3', lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: true, pointMarkersVisible: false, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: '', crosshairMarkerBackgroundColor: '', crosshairMarkerBorderWidth: 2 });
export const AreaSeries = def('Area', KIND_VALUE, { topColor: 'rgba(46, 220, 135, 0.4)', bottomColor: 'rgba(40, 221, 100, 0)', invertFilledArea: false, lineColor: '#33D778', lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: true, pointMarkersVisible: false, crosshairMarkerVisible: true, crosshairMarkerRadius: 4 });
export const BaselineSeries = def('Baseline', KIND_VALUE, { baseValue: { type: 'price', price: 0 }, topFillColor1: 'rgba(38, 166, 154, 0.28)', topFillColor2: 'rgba(38, 166, 154, 0.05)', topLineColor: 'rgba(38, 166, 154, 1)', bottomFillColor1: 'rgba(239, 83, 80, 0.05)', bottomFillColor2: 'rgba(239, 83, 80, 0.28)', bottomLineColor: 'rgba(239, 83, 80, 1)', lineWidth: 3, lineStyle: 0, lineType: 0, lineVisible: true, pointMarkersVisible: false, crosshairMarkerVisible: true, crosshairMarkerRadius: 4 });
export const HistogramSeries = def('Histogram', KIND_VALUE, { color: '#26a69a', base: 0 });

const CHART_DEFAULTS = () => ({
  width: 0, height: 0, autoSize: false,
  layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#191919', fontSize: 12, fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif", panes: { separatorColor: '#E0E3EB', separatorHoverColor: 'rgba(178, 181, 189, 0.2)', enableResize: true }, attributionLogo: true },
  grid: { vertLines: { color: '#D6DCDE', style: 0, visible: true }, horzLines: { color: '#D6DCDE', style: 0, visible: true } },
  crosshair: { mode: 1, vertLine: { color: '#9598A1', width: 1, style: 3, visible: true, labelVisible: true, labelBackgroundColor: '#131722' }, horzLine: { color: '#9598A1', width: 1, style: 3, visible: true, labelVisible: true, labelBackgroundColor: '#131722' } },
  rightPriceScale: { visible: true, autoScale: true, mode: 0, invertScale: false, alignLabels: true, borderVisible: true, borderColor: '#2B2B43', textColor: '', entireTextOnly: false, ticksVisible: false, scaleMargins: { top: 0.2, bottom: 0.1 }, minimumWidth: 0 },
  leftPriceScale: { visible: false, autoScale: true, mode: 0, invertScale: false, alignLabels: true, borderVisible: true, borderColor: '#2B2B43', textColor: '', entireTextOnly: false, ticksVisible: false, scaleMargins: { top: 0.2, bottom: 0.1 }, minimumWidth: 0 },
  overlayPriceScales: { scaleMargins: { top: 0.2, bottom: 0.1 }, mode: 0, invertScale: false, autoScale: true },
  timeScale: { rightOffset: 0, barSpacing: 6, minBarSpacing: 0.5, maxBarSpacing: 0, fixLeftEdge: false, fixRightEdge: false, lockVisibleTimeRangeOnResize: false, rightBarStaysOnScroll: false, borderVisible: true, borderColor: '#2B2B43', visible: true, timeVisible: false, secondsVisible: true, shiftVisibleRangeOnNewBar: true, allowShiftVisibleRangeOnWhitespaceReplacement: false, ticksVisible: false, uniformDistribution: false, minimumHeight: 0, allowBoldLabels: true, tickMarkFormatter: undefined },
  localization: { locale: (typeof navigator !== 'undefined' && navigator.language) || 'en-US', priceFormatter: undefined, tickmarksPriceFormatter: undefined, timeFormatter: undefined, dateFormat: "dd MMM 'yy" },
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
  handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true },
  kineticScroll: { mouse: false, touch: true },
  trackingMode: { exitMode: 1 },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Function);
function merge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (isObj(v) && isObj(dst[k])) merge(dst[k], v); else dst[k] = isObj(v) ? merge({}, v) : v;
  }
  return dst;
}
const timeOf = (t) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t + 'T00:00:00Z') / 1000 : t && t.year ? Date.UTC(t.year, t.month - 1, t.day) / 1000 : NaN);
/**
 * Height of the time scale as a function of the font. Measured on LW 5 (timeScale().height() with fonts from 6 to 30 px, 25
 * values: 18, 20, 22, 24, 26, 28, 28, 30... always even): 6 fixed px plus 11/6 of the font, rounded up and then to even (28 px
 * with a 12 px font, 30 with 13). With a fixed 28 the aq price scale fell 2 px lower with a 13 px font.
 */
/** y of the centre of the date text (measured on LW's pixels): 6 px plus 3/4 of the font. */
const timeTextY = (fs) => 6 + 0.75 * fs;
export const timeAxisHeight = (fs) => { const h = Math.ceil(6 + (11 * fs) / 6); return h + (h % 2); };
/**
 * Sizes of the crosshair labels measured on LW (test/fixtures/lw-measures-crosshair.json: 75 measurements at DPR 1, font 6-30,
 * three text lengths; 52 at DPR 2 and 3). Computed in device pixels (`fsd` = font · dpr, `unit` odd for DPR 1 and 3, even for 2).
 * Price: width = text (rounded up, in CSS px) · dpr + ceil(0.83 · fsd + 6 · dpr − 0.3); height = the integer with the parity of
 * `unit` nearest to 1.75 · fsd + 0.7. Date: width = text (rounded, CSS px) · dpr + floor(1.5 · fsd) (at DPR 2-3 it is off by 1
 * pixel in about one case in four, not solved), height = ceil(1.5 · font + 6) · dpr. They return CSS px (fractional at DPR 2-3).
 */
export const crossPriceLabel = (textW, fs, dpr = 1) => {
  const fsd = fs * dpr, par = Math.max(1, Math.floor(dpr)) % 2;
  const w = Math.ceil(textW) * dpr + Math.ceil(0.83 * fsd + 6 * dpr - 0.3 - 1e-9), h = 2 * Math.round((1.75 * fsd + 0.7 - par) / 2) + par;
  return { w: w / dpr, h: h / dpr };
};
export const crossTimeLabel = (textW, fs, dpr = 1) => ({ w: (Math.round(textW) * dpr + Math.floor(1.5 * fs * dpr)) / dpr, h: Math.ceil(1.5 * fs + 6) });
/**
 * Minimum distance in pixels between two time labels: measured with fonts from 9 to 28 px (65, 80, 100, 120, 160), 20 plus 5 times
 * the font.
 */
export const timeTickMinDist = (fs) => 20 + 5 * fs;
/**
 * Width of the price scale from the pixel width of the widest label and from the font. Measured on LW (priceScale().width() with a
 * fixed label, fonts from 6 to 30 px and four lengths: 100 measurements in test/fixtures/lw-measures-axis.json): the text plus 11
 * fixed px plus 5/6 of the font, rounded up and then to even.
 */
/** Equivalent text width of a price scale without labels (measured: 54, 56, 60 px with fonts 10, 12, 16). */
const EMPTY_LABEL_W = 34;
export const priceAxisWidth = (textW, fs) => { const r = Math.ceil(textW + 11 + (5 * fs) / 6); return r + (r % 2); };

// ---------------------------------------------------------------------------------------------------------------------
class Series {
  constructor(chart, def, opts, pane) {
    this.chart = chart;
    this.def = def;
    this.type = def.type;
    this.opts = merge(merge({}, def.defaults), sideColors(opts) || {});
    this.store = new SeriesStore(def.kind);
    this.pane = pane;
    this.prims = [];
    this.lines = [];
    this.markers = null;
    this.order = 0;
    this.api = new SeriesApi(this);
  }
  get scaleId() { return this.opts.priceScaleId ?? 'right'; }
  scale() { return this.pane.scale(this.scaleId, this.chart); }
  /** Point colours (0 = series colour) read from the data element. */
  readItem(st, i, d) {
    st.t[i] = timeOf(d.time);
    st.has[i] = 0;
    const col = (slot, c) => { if (c != null) { st[slot][i] = packRgba(c); st.has[i] |= slot === 'c1' ? 1 : slot === 'c2' ? 2 : 4; } };
    if (st.kind === KIND_OHLC) {
      const ok = d.close != null && d.open != null;
      st.o[i] = ok ? +d.open : NaN; st.h[i] = ok ? +(d.high ?? Math.max(d.open, d.close)) : NaN; st.l[i] = ok ? +(d.low ?? Math.min(d.open, d.close)) : NaN; st.c[i] = ok ? +d.close : NaN;
      col('c1', d.color); col('c2', d.borderColor); col('c3', d.wickColor);
    } else {
      st.v[i] = d.value != null ? +d.value : NaN;
      col('c1', this.type === 'Area' || this.type === 'Baseline' ? d.lineColor ?? d.color : d.color);
    }
  }
  setData(data) {
    const st = this.store, n = data.length, ti = this.chart.ti, freed = [];
    for (let i = 0; i < st.n; i++) if (ti.unref(st.t[i])) freed.push(st.t[i]);
    st.n = 0; st.alloc(n); st.items = data.slice();
    for (let i = 0; i < n; i++) this.readItem(st, i, data[i]);
    st.n = n;
    for (let i = 0; i < n; i++) ti.ref(st.t[i]);
    // times that no series uses any more: the time scale is rebuilt (as in LW)
    this.chart.indexSeries(this, true, freed.length > 0 && ti.prune(freed));
    st.build();
    this.chart.dataChanged(this);
  }
  update(d, historical = false) {
    const st = this.store, t = timeOf(d.time);
    if (st.n && t === st.t[st.n - 1]) { this.readItem(st, st.n - 1, d); st.items[st.n - 1] = d; st.refresh(st.n - 1); }
    else if (!st.n || t > st.t[st.n - 1]) {
      st.alloc(st.n + 1);
      this.readItem(st, st.n, d);
      st.items.push(d);
      st.n++;
      this.chart.ti.ref(t);
      this.chart.indexSeries(this, false);
      st.refresh(st.n - 1);
    } else {
      // update of an older point (historicalUpdate)
      let lo = 0, hi = st.n;
      while (lo < hi) { const m = (lo + hi) >> 1; if (st.t[m] < t) lo = m + 1; else hi = m; }
      if (lo < st.n && st.t[lo] === t) { this.readItem(st, lo, d); st.items[lo] = d; st.refresh(lo); }
      else if (!historical) throw new Error('Cannot update oldest data');
    }
    this.chart.dataChanged(this, true);
  }
  /** Packed colour of point i (slot c1) or of the series. */
  colorFn() {
    const st = this.store, o = this.opts;
    const dflt = packRgba(this.type === 'Area' || this.type === 'Baseline' ? o.lineColor || o.topLineColor || '#2196f3' : o.color || '#2196f3');
    return (i) => (st.has[i] & 1 ? st.c1[i] : dflt);
  }
  ohlcColors() {
    const st = this.store, o = this.opts;
    const up = packRgba(o.upColor), dn = packRgba(o.downColor);
    const bu = packRgba(o.borderUpColor || o.borderColor || o.upColor), bd = packRgba(o.borderDownColor || o.borderColor || o.downColor);
    const wu = packRgba(o.wickUpColor || o.wickColor || o.upColor), wd = packRgba(o.wickDownColor || o.wickColor || o.downColor);
    const out = [0, 0, 0];
    return (i, isUp) => {
      const h = st.has[i];
      out[0] = h & 1 ? st.c1[i] : isUp ? up : dn;
      out[1] = h & 2 ? st.c2[i] : h & 1 && this.type === 'Candlestick' ? st.c1[i] : isUp ? bu : bd;
      out[2] = h & 4 ? st.c3[i] : h & 1 && this.type === 'Candlestick' ? st.c1[i] : isUp ? wu : wd;
      return out;
    };
  }
  /** "Close" value of position i (for crosshair, price line, percentage). */
  valueAt(i) { const st = this.store; return st.kind === KIND_OHLC ? st.c[i] : st.v[i]; }
  formatter() {
    const pf = this.opts.priceFormat || {};
    if (pf.type === 'custom' && pf.formatter) return (p) => pf.formatter(p);
    if (pf.type === 'volume') return (p) => fmtVolume(p, this.chart.locale);
    const prec = pf.precision ?? (pf.minMove ? Math.max(0, Math.round(-Math.log10(pf.minMove))) : 2);
    if (pf.type === 'percent') return (p) => fmtPrice(p, prec, this.chart.locale) + '%';
    return (p) => fmtPrice(p, prec, this.chart.locale);
  }
}

class SeriesApi {
  constructor(s) { this._s = s; }
  setData(d) { this._s.setData(d); }
  update(d, h) { this._s.update(d, h); }
  data() { return this._s.store.items; }
  dataByIndex(index, dir = 0) {
    const st = this._s.store;
    let p = st.lowerPos(index);
    if (p < st.n && st.pi[p] === index) return st.items[p];
    if (dir < 0) { p--; return p >= 0 ? st.items[p] : null; }
    if (dir > 0) return p < st.n ? st.items[p] : null;
    return null;
  }
  barsInLogicalRange(r) {
    const st = this._s.store;
    if (!r || !st.n) return null;
    const [pa, pb] = st.posRange(Math.ceil(r.from), Math.floor(r.to));
    return { barsBefore: pa, barsAfter: st.n - 1 - pb, from: st.items[pa]?.time, to: st.items[pb]?.time };
  }
  applyOptions(o) {
    const s = this._s, oldId = s.scaleId;
    merge(s.opts, sideColors(o));
    if (o.priceFormat) for (const sc of s.pane.scales.values()) sc.tk = null;
    if (s.scaleId !== oldId) s.pane.scale(s.scaleId, s.chart);
    s.store.dirty(0);
    s.chart.invalidate();
  }
  options() { return this._s.opts; }
  priceScale() { return this._s.chart.scaleApi(this._s.pane, this._s.scaleId); }
  priceToCoordinate(p) { const s = this._s, sc = s.scale(); if (!sc.ready || p == null) return null; let y = sc.ps.toY(p); if (sc.opts.invertScale) y = sc.ps.span - y; return Number.isFinite(y) ? y : null; }
  coordinateToPrice(y) { const sc = this._s.scale(); return sc.ready ? sc.ps.fromY(sc.opts.invertScale ? sc.ps.span - y : y) : null; }
  priceFormatter() { const f = this._s.formatter(); return { format: f }; }
  seriesType() { return this._s.type; }
  createPriceLine(o) { const l = new PriceLine(this._s, o); this._s.lines.push(l); this._s.chart.invalidate(); return l; }
  removePriceLine(l) { const a = this._s.lines, i = a.indexOf(l); if (i >= 0) a.splice(i, 1); this._s.chart.invalidate(); }
  priceLines() { return this._s.lines.slice(); }
  attachPrimitive(p) { this._s.chart.attachPrim(p, this._s.pane, this._s); }
  detachPrimitive(p) { this._s.chart.detachPrim(p); }
  getPane() { return this._s.pane.api; }
  moveToPane(i) { this._s.chart.moveSeries(this._s, i); }
  setSeriesOrder(n) { this._s.order = n; this._s.pane.series.sort((a, b) => a.order - b.order); this._s.chart.invalidate(); }
  seriesOrder() { return this._s.pane.series.indexOf(this._s); }
  lastValueData(globalLast) {
    const s = this._s, st = s.store;
    const p = globalLast ? st.lastFilled() : s.lastVisiblePos();
    if (p < 0) return { noData: true };
    const price = s.valueAt(p);
    return { noData: false, price, color: s.lastColor(p) };
  }
  subscribeDataChanged(fn) { (this._s.dataSubs ||= new Set()).add(fn); }
  unsubscribeDataChanged(fn) { this._s.dataSubs?.delete(fn); }
}
/** Last non-empty position at or before the right edge of the view: the value of the label on the price scale (LW shows the last VISIBLE value there, and the global last one only on the price line). */
Series.prototype.lastVisiblePos = function () {
  const st = this.store;
  // like LW: from the logical range (the last bar at or after the right edge value), not from the pixel of the edge, which with bars
  // narrower than a pixel falls bars later
  let p = Math.min(st.lastFilled(), st.upperPos(Math.ceil(this.chart.visibleIdx().to - 1e-9)) - 1);
  while (p >= 0 && st.empty(p)) p--;
  return p;
};
Series.prototype.lastColor = function (p) {
  const st = this.store, o = this.opts;
  if (st.kind === KIND_OHLC) return this.ohlcColors()(p, st.c[p] >= st.o[p])[0];
  if (this.type === 'Baseline') { const b = o.baseValue?.price ?? 0; return packRgba(st.v[p] >= b ? o.topLineColor : o.bottomLineColor); }
  return this.colorFn()(p);
};

class PriceLine {
  constructor(series, o) {
    this.s = series;
    this.o = merge({ price: 0, color: '', lineWidth: 1, lineStyle: 2, lineVisible: true, axisLabelVisible: true, title: '', axisLabelColor: '', axisLabelTextColor: '' }, o || {});
  }
  applyOptions(o) { merge(this.o, o); this.s.chart.invalidate(); }
  options() { return this.o; }
}

// ---------------------------------------------------------------------------------------------------------------------
class Pane {
  constructor(chart, index) {
    this.chart = chart;
    this.series = [];
    this.prims = []; // pane primitives
    this.scales = new Map();
    this.stretch = 1;
    this.y = 0; this.h = 0;
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:absolute;left:0;right:0;pointer-events:none';
    this.api = new PaneApi(this);
    this.layers = { bottom: chart.mkCanvas(1), top: chart.mkCanvas(3) };
    this.drawn = { bottom: false, top: false };
  }
  get index() { return this.chart.panes.indexOf(this); }
  scale(id, chart) {
    let s = this.scales.get(id);
    if (!s) {
      const visibleId = id === 'right' || id === 'left';
      const base = visibleId ? chart.o[id === 'right' ? 'rightPriceScale' : 'leftPriceScale'] : chart.o.overlayPriceScales;
      s = { id, opts: merge({}, base), ps: new PriceScale(), ready: false, api: null, overlay: !visibleId, width: 0 };
      if (!visibleId) s.opts.visible = false;
      this.scales.set(id, s);
    }
    return s;
  }
  destroy() { this.el.remove(); this.layers.bottom.c.remove(); this.layers.top.c.remove(); }
}

class PaneApi {
  constructor(p) { this._p = p; }
  getHeight() { return this._p.h; }
  setHeight(h) { const c = this._p.chart; const total = c.panes.reduce((a, p) => a + p.h, 0) || 1; this._p.stretch = Math.max(0.01, h / total) * c.panes.reduce((a, p) => a + p.stretch, 0); c.layoutPanes(); c.invalidate(); }
  getStretchFactor() { return this._p.stretch; }
  setStretchFactor(f) { this._p.stretch = Math.max(0.0001, +f || 1); this._p.chart.layoutPanes(); this._p.chart.invalidate(); }
  moveTo(i) { this._p.chart.movePane(this._p, i); }
  paneIndex() { return this._p.index; }
  getSeries() { return this._p.series.map((s) => s.api); }
  getHTMLElement() { return this._p.el; }
  attachPrimitive(p) { this._p.chart.attachPrim(p, this._p, null); }
  detachPrimitive(p) { this._p.chart.detachPrim(p); }
  priceScale(id) { return this._p.chart.scaleApi(this._p, id); }
}

// ---------------------------------------------------------------------------------------------------------------------
export function createChart(container, options) {
  const el = typeof container === 'string' ? document.getElementById(container) : container;
  return new Chart(el, options).api;
}

class Chart {
  constructor(container, options) {
    this.container = container;
    this.o = merge(CHART_DEFAULTS(), options || {});
    this.root = document.createElement('div');
    this.root.className = 'tv-lightweight-charts';
    // z-index:0 closes the inner layers (crosshair canvas at z 5, which takes the events) in a stacking context: without it they
    // covered the elements that the application puts in the container as siblings (legend z 3, selection bar z 4, tables...) and
    // clicks and taps there reached the chart
    this.root.style.cssText = 'position:relative;z-index:0;overflow:hidden;width:100%;height:100%;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none';
    container.appendChild(this.root);
    this.rows = document.createElement('div');
    this.rows.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0';
    this.root.appendChild(this.rows);
    this.glc = document.createElement('canvas');
    this.glc.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2';
    this.root.appendChild(this.glc);
    this.logo = createLogo();
    this.root.appendChild(this.logo);
    this.R = new GlpRenderer(this.glc, { alpha: true });
    this.R.onRestore = () => this.invalidate();
    this.axes = { right: this.mkCanvas(4), left: this.mkCanvas(4), time: this.mkCanvas(4) };
    this.cross = this.mkCanvas(5);
    this.cross.c.style.pointerEvents = 'auto';
    this.ti = new TimeIndex();
    this.tix = new TickIndex();
    this.tixVer = -1;
    this.wts = new Uint8Array(0);
    this.ts = new TimeScale({ spacing: this.o.timeScale.barSpacing, rightOffset: this.o.timeScale.rightOffset, minSpacing: this.o.timeScale.minBarSpacing || 0.01, maxSpacing: this.o.timeScale.maxBarSpacing || 1e4 });
    this.ts.pad = 1; // measured on LW: x(i) = width − 1 − (rightOffset + base − i + 0.5) · spacing
    this.base = -1; // last logical index with data
    this.panes = [];
    this.vis = []; // visible panes (layoutPanes)
    this.allSeries = [];
    this.prims = new Map(); // primitive → { pane, series }
    this.subs = { cross: new Set(), click: new Set(), dbl: new Set(), range: new Set(), trange: new Set(), size: new Set() };
    this.crossAt = null; // { x, y, pane, logical, src }
    this.dirty = true;
    this.raf = 0;
    this.lastRange = null;
    this.api = new ChartApi(this);
    this.addPane();
    this.applyLayoutStyle();
    this.ro = new ResizeObserver(() => { if (this.o.autoSize) this.resize(); });
    this.ro.observe(this.root);
    this.bind();
    if (!this.o.autoSize && this.o.width && this.o.height) this.resize(this.o.width, this.o.height);
    else this.resize();
  }

  get locale() { return this.o.localization.locale || 'en-US'; }
  mkCanvas(z) {
    const c = document.createElement('canvas');
    c.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;z-index:${z}`;
    this.root.appendChild(c);
    return { c, x: c.getContext('2d'), w: 0, h: 0 };
  }
  sizeCanvas(L, x, y, w, h) {
    const dpr = this.dpr;
    L.c.style.left = x + 'px'; L.c.style.top = y + 'px'; L.c.style.width = w + 'px'; L.c.style.height = h + 'px';
    const dw = Math.max(1, Math.round(w * dpr)), dh = Math.max(1, Math.round(h * dpr));
    if (L.c.width !== dw) L.c.width = dw;
    if (L.c.height !== dh) L.c.height = dh;
    L.w = w; L.h = h; L.dw = dw; L.dh = dh;
  }
  applyLayoutStyle() {
    const bg = this.o.layout.background || {};
    this.root.style.background = bg.type === 'gradient' ? `linear-gradient(${bg.topColor}, ${bg.bottomColor})` : bg.color || '#FFFFFF';
    this.root.style.color = this.o.layout.textColor;
  }

  // ---------------- series, panes, primitives ----------------
  addPane() {
    const p = new Pane(this, this.panes.length);
    this.panes.push(p);
    this.rebuildRows();
    this.layoutPanes();
    return p;
  }
  rebuildRows() {
    this.rows.textContent = '';
    this.seps = [];
    this.panes.forEach((p, i) => {
      if (i > 0) {
        const s = document.createElement('div');
        s.style.cssText = 'position:absolute;left:0;right:0;pointer-events:none';
        this.rows.appendChild(s);
        this.seps.push(s);
      }
      this.rows.appendChild(p.el);
    });
  }
  removePane(i) {
    const p = this.panes[i];
    if (!p || this.panes.length < 2) return;
    for (const s of p.series.slice()) this.removeSeries(s);
    this.panes.splice(this.panes.indexOf(p), 1);
    p.destroy();
    this.rebuildRows();
    this.layoutPanes();
    this.invalidate();
  }
  movePane(p, i) {
    const a = this.panes;
    a.splice(a.indexOf(p), 1);
    a.splice(Math.max(0, Math.min(a.length, i)), 0, p);
    this.rebuildRows(); this.layoutPanes(); this.invalidate();
  }
  paneAt(i) { while (this.panes.length <= i) this.addPane(); return this.panes[i]; }
  addSeries(def, opts, paneIndex = 0) {
    const pane = this.paneAt(paneIndex | 0);
    const s = new Series(this, def, opts, pane);
    s.order = pane.series.length;
    pane.series.push(s);
    pane.scale(s.scaleId, this);
    this.allSeries.push(s);
    this.invalidate();
    return s;
  }
  removeSeries(s) {
    for (const [p, info] of [...this.prims]) if (info.series === s) this.detachPrim(p);
    s.pane.series.splice(s.pane.series.indexOf(s), 1);
    this.allSeries.splice(this.allSeries.indexOf(s), 1);
    this.R.forget(s.store);
    // its times that no other series uses leave the time scale (as in LW)
    const st = s.store, freed = [];
    for (let i = 0; i < st.n; i++) if (this.ti.unref(st.t[i])) freed.push(st.t[i]);
    if (freed.length && this.ti.prune(freed)) this.rebuildTime();
    // LW removes panes left empty (except the first)
    const p = s.pane;
    if (!p.series.length && !p.prims.length && this.panes.indexOf(p) > 0 && !p.keep) {
      this.panes.splice(this.panes.indexOf(p), 1);
      p.destroy();
      this.rebuildRows();
      this.layoutPanes();
    }
    this.invalidate();
  }
  moveSeries(s, i) {
    const from = s.pane;
    from.series.splice(from.series.indexOf(s), 1);
    const to = this.paneAt(i);
    s.pane = to;
    to.series.push(s);
    to.scale(s.scaleId, this);
    for (const [, info] of this.prims) if (info.series === s) info.pane = to;
    if (!from.series.length && !from.prims.length && this.panes.indexOf(from) > 0) { this.panes.splice(this.panes.indexOf(from), 1); from.destroy(); this.rebuildRows(); }
    this.layoutPanes();
    this.invalidate();
  }
  attachPrim(p, pane, series) {
    if (this.prims.has(p)) this.detachPrim(p);
    this.prims.set(p, { pane, series });
    if (!series) pane.prims.push(p);
    else series.prims.push(p);
    p.attached?.({ chart: this.api, series: series?.api, requestUpdate: () => this.invalidate(), horzScaleBehavior: HORZ });
    this.invalidate();
  }
  detachPrim(p) {
    const info = this.prims.get(p);
    if (!info) return;
    this.prims.delete(p);
    const list = info.series ? info.series.prims : info.pane.prims;
    const i = list.indexOf(p);
    if (i >= 0) list.splice(i, 1);
    try { p.detached?.(); } catch { /* */ }
    this.R.forget(p); // WebGL buffer of the primitive's drawings (drawAq)
    this.invalidate();
  }

  /** Logical indices of the series points (rebuilds the time scale if there are new times). */
  indexSeries(s, full, gone = false) {
    const st = s.store, ti = this.ti;
    const oldBase = this.base, oldRight = this.ts.right;
    if (!full) {
      const t = st.t[st.n - 1];
      let i = ti.indexOf(t);
      let added = false;
      if (i < 0) {
        if (ti.n && t < ti.t[ti.n - 1]) { this.rebuildTime(); return; }
        ti.append(t); i = ti.n - 1; added = true;
      }
      st.pi[st.n - 1] = i;
      this.updateBase(oldBase, oldRight, added);
      return;
    }
    let missing = false;
    for (let i = 0; i < st.n; i++) { const k = ti.map.get(st.t[i]); if (k === undefined) { missing = true; break; } st.pi[i] = k; }
    if (missing || gone) this.rebuildTime();
    else this.updateBase(oldBase, oldRight, false);
  }
  rebuildTime() {
    const oldBase = this.base, oldRight = this.ts.right, oldFirst = this.ti.n ? this.ti.t[0] : null, oldN = this.ti.n;
    this.ti.rebuild(this.allSeries.map((s) => s.store.t.subarray(0, s.store.n)));
    for (const s of this.allSeries) s.store.remap(this.ti);
    const prepended = oldFirst != null && this.ti.t[0] < oldFirst ? this.ti.lower(oldFirst) : 0;
    if (oldBase < 0) { this.base = -1; this.updateBase(-1, oldRight, true); return; }
    // old indices mapped to the new ones (history added on the left): the view stays on the same bars
    this.updateBase(oldBase + prepended, oldRight + prepended, this.ti.n > oldN + prepended, prepended > 0);
  }
  lastBarIndex() { let b = -1; for (const s of this.allSeries) { const p = s.store.lastFilled(); if (p >= 0 && s.store.pi[p] > b) b = s.store.pi[p]; } return b; }
  /**
   * New index of the last bar with data, with the rule observed on LW: by default the distance from the right edge (rightOffset)
   * stays the same, so the view follows; but if the data grow on the right and the view must not follow them (last bar beyond the
   * right edge by more than one bar, or the new points fall on times that already existed, like the application's empty future
   * bars or plots shifted forward) the view stays still. `added`: new times added to the scale.
   */
  updateBase(oldBase, oldRight, added, prepended = false) {
    const nb = this.lastBarIndex();
    if (oldBase < 0 || nb < 0) {
      this.base = nb; this.ts.n = Math.max(0, nb + 1);
      if (nb >= 0 && oldBase < 0) this.ts.right = nb + this.o.timeScale.rightOffset + 0.5;
      this.ts.clamp();
      return;
    }
    const offset = oldRight - oldBase;
    let right = nb + offset;
    if (nb > oldBase && !prepended) {
      const vis = oldBase < oldRight + 0.5; // measured on LW: the view follows while rightOffset > -1 (any spacing; no limit on the left, even with the bar gone past the left edge)
      const tso = this.o.timeScale;
      const shift = vis && (added || tso.allowShiftVisibleRangeOnWhitespaceReplacement) && tso.shiftVisibleRangeOnNewBar !== false;
      if (!shift) right = oldRight;
    }
    this.ts.right = right;
    this.base = nb;
    this.ts.n = nb + 1;
    this.ts.clamp();
  }
  dataChanged(s, update = false) {
    if (s.dataSubs) for (const f of s.dataSubs) try { f(update ? 'update' : 'full'); } catch { /* */ }
    this.invalidate();
  }

  // ---------------- sizes ----------------
  resize(w, h) {
    const r = this.container.getBoundingClientRect();
    // measured on LW: chart width and height whole and even (with an odd height LW leaves the last row empty; without it, aq's panes
    // were 1 px taller and the price scale fell lower)
    const even = (x) => Math.max(1, (x = Math.floor(x)) - (x % 2));
    this.W = even(w ?? (this.o.autoSize ? this.root.clientWidth || r.width : this.o.width || r.width));
    this.H = even(h ?? (this.o.autoSize ? this.root.clientHeight || r.height : this.o.height || r.height));
    if (w != null) { this.root.style.width = this.W + 'px'; this.root.style.height = this.H + 'px'; }
    this.dpr = window.devicePixelRatio || 1;
    this.layout();
    for (const f of this.subs.size) try { f(this.W, this.H); } catch { /* */ }
  }
  axisWidth(side) {
    const o = side === 'right' ? this.o.rightPriceScale : this.o.leftPriceScale;
    if (!o.visible) return 0;
    if (!this.panes.some((p) => p.series.some((s) => s.scaleId === side))) return side === 'right' ? Math.max(o.minimumWidth || 0, this.axisW?.[side] || 0) : 0;
    return Math.max(o.minimumWidth || 0, this.axisW?.[side] || 56);
  }
  layout() {
    this.axisW ||= { right: 56, left: 56 };
    this.lw = this.axisWidth('left');
    this.rw = this.axisWidth('right');
    this.timeH = this.o.timeScale.visible ? Math.max(timeAxisHeight(this.o.layout.fontSize || 12), this.o.timeScale.minimumHeight || 0) : 0;
    this.areaW = Math.max(1, this.W - this.lw - this.rw);
    this.areaH = Math.max(1, this.H - this.timeH);
    this.ts.setWidth(this.areaW);
    this.layoutPanes();
  }
  layoutPanes() {
    if (!this.W) return;
    const n = this.panes.length, full = Math.max(1, this.H - this.timeH), total = full - (n - 1);
    const sum = this.panes.reduce((a, p) => a + p.stretch, 0) || 1;
    // Pane whose div is hidden by the application (maximised pane of the host chart: display none on the other divs, like the rows
    // of LW's table): its share of the height and its separator are counted as in LW, but it takes no space. Visible panes stack one
    // below the other, the date scale right after and the rest of the height stays empty at the bottom (the host makes the chart
    // taller on purpose, those pixels end up out of view). Before, hidden panes stayed as squashed strips above the dates and pushed
    // the date scale beyond the bottom of the container
    let y = 0, acc = 0, first = true;
    this.vis = [];
    this.panes.forEach((p, i) => {
      const h = Math.max(1, i === n - 1 ? full - acc : Math.round((total * p.stretch) / sum));
      acc += h + 1;
      p.hidden = p.el.style.display === 'none';
      p.h = h;
      for (const s of p.scales.values()) s.ps.height = p.h;
      p.layers.bottom.c.style.display = p.layers.top.c.style.display = p.hidden ? 'none' : '';
      if (p.hidden) return;
      if (!first) y += 1; // separator above the pane
      first = false;
      p.y = y;
      this.vis.push(p);
      p.el.style.top = y + 'px'; p.el.style.height = p.h + 'px';
      if (i > 0) { const s = this.seps[i - 1]; s.style.top = y - 1 + 'px'; s.style.height = '1px'; }
      this.sizeCanvas(p.layers.bottom, this.lw, y, this.areaW, p.h);
      this.sizeCanvas(p.layers.top, this.lw, y, this.areaW, p.h);
      p.drawn.bottom = p.drawn.top = true; // size changed: needs redrawing
      y += h;
    });
    this.areaH = Math.max(1, Math.min(full, y));
    const p0 = this.vis[0];
    if (p0) placeLogo(this.logo, this.o.layout.attributionLogo !== false, this.lw, p0.y, p0.h);
    // hidden ones sit below the panes area (behind the date scale): no crosshair, click or drawing on them
    for (const p of this.panes) if (p.hidden) p.y = this.areaH + this.timeH;
    this.glc.style.left = this.lw + 'px';
    this.glc.style.width = this.areaW + 'px'; this.glc.style.height = this.areaH + 'px';
    this.glW = Math.max(1, Math.round(this.areaW * this.dpr)); this.glH = Math.max(1, Math.round(this.areaH * this.dpr));
    this.sizeCanvas(this.axes.right, this.lw + this.areaW, 0, Math.max(1, this.rw), this.areaH);
    this.axes.right.c.style.display = this.rw ? '' : 'none';
    this.sizeCanvas(this.axes.left, 0, 0, Math.max(1, this.lw), this.areaH);
    this.axes.left.c.style.display = this.lw ? '' : 'none';
    this.sizeCanvas(this.axes.time, 0, this.areaH, this.W, Math.max(1, this.timeH));
    this.axes.time.c.style.display = this.timeH ? '' : 'none';
    this.sizeCanvas(this.cross, 0, 0, this.W, this.H);
    this.invalidate();
  }

  // ---------------- view ----------------
  invalidate() {
    this.dirty = true;
    // while drawing (primitives that request an update from updateAllViews or draw) no extra frame
    if (this.inFrame) return;
    if (!this.raf && !this.removed) this.raf = requestAnimationFrame(() => this.frame());
  }
  visibleIdx() {
    const a = this.ts.index(0), b = this.ts.index(this.areaW);
    // from/to as getVisibleLogicalRange of LW (observed values): right edge = base index + rightOffset, left = right − width/spacing
    // + 1, without the pixel that LW removes on the right in coordinates. Computed from pixels (with that pixel) they were shifted
    // by 1/spacing: the application rereads the range and sets it again, and at every round the view slipped by 1 px relative to LW
    const to = this.ts.right - 0.5;
    return { first: Math.ceil(a - 0.5), last: Math.floor(b + 0.5), from: to - this.areaW / this.ts.spacing + 1, to };
  }
  scaleApi(pane, id) {
    const s = pane.scale(id, this);
    return (s.api ||= new PriceScaleApi(this, pane, s));
  }

  /** Automatic field of a scale from the visible series and primitives. */
  autoscale(pane, sc, v) {
    let mn = Infinity, mx = -Infinity, mAbove = 0, mBelow = 0, first = null;
    for (const s of pane.series) {
      if (s.scaleId !== sc.id || !s.opts.visible || !s.store.n) continue;
      const st = s.store;
      const [pa, pb] = st.posRange(v.first, v.last);
      if (first == null && pb >= pa) { for (let p = pa; p <= pb; p++) { const x = s.valueAt(p); if (x === x) { first = x; break; } } }
      let info;
      // behaviour observed on LW: a series' primitives are part of its base field, so an autoscaleInfoProvider that returns null
      // (the application with the scale fitted to the candles only) also removes their drawings. Before they were always added:
      // after the double click on the scale, the scripts' shapes and boxes entered and left the field while scrolling, and the chart
      // moved vertically
      const baseImpl = () => {
        let a = Infinity, b = -Infinity, margins = null;
        if (pb >= pa) {
          [a, b] = st.range(pa, pb);
          if (s.type === 'Histogram') { const base = s.opts.base ?? 0; a = Math.min(a, base); b = Math.max(b, base); }
        }
        for (const p of s.prims) {
          if (!p.autoscaleInfo) continue;
          let pi;
          try { pi = p.autoscaleInfo(v.first, v.last); } catch { pi = null; }
          const r = pi?.priceRange;
          if (r && Number.isFinite(r.minValue) && Number.isFinite(r.maxValue)) { a = Math.min(a, r.minValue); b = Math.max(b, r.maxValue); }
          if (pi?.margins) margins = pi.margins;
        }
        if (!(a <= b)) return margins ? { priceRange: null, margins } : null;
        return margins ? { priceRange: { minValue: a, maxValue: b }, margins } : { priceRange: { minValue: a, maxValue: b } };
      };
      if (typeof s.opts.autoscaleInfoProvider === 'function') { try { info = s.opts.autoscaleInfoProvider(baseImpl); } catch { info = null; } }
      else info = baseImpl();
      if (info) {
        const r = info.priceRange;
        if (r && Number.isFinite(r.minValue) && Number.isFinite(r.maxValue)) { if (r.minValue < mn) mn = r.minValue; if (r.maxValue > mx) mx = r.maxValue; }
        if (info.margins) { mAbove = Math.max(mAbove, info.margins.above || 0); mBelow = Math.max(mBelow, info.margins.below || 0); }
      }
    }
    sc.first = first;
    if (!(mn <= mx)) return false;
    const ps = sc.ps;
    ps.marginTop = sc.opts.scaleMargins?.top ?? 0.2;
    ps.marginBottom = sc.opts.scaleMargins?.bottom ?? 0.1;
    ps.log = sc.opts.mode === 1;
    if (ps.log && mn <= 0) { mn = Math.max(mn, mx * 1e-6, 1e-12); }
    return ps.fit(mn, mx, mAbove, mBelow);
  }

  // ---------------- drawing ----------------
  frame() {
    this.raf = 0;
    if (this.removed || !this.dirty) return;
    this.dirty = false;
    this.inFrame = true;
    try { this.frameBody(); } finally { this.inFrame = false; this.dirty = false; }
    if (this.kinetic) this.invalidate();
  }
  frameBody() {
    const t0 = performance.now();
    if (this.kinetic) this.stepKinetic();
    let v = this.visibleIdx();
    // price scales: automatic from the visible series, then strip width from the labels
    for (const p of this.panes) {
      for (const sc of p.scales.values()) {
        sc.ps.height = p.h;
        sc.ps.log = sc.opts.mode === 1;
        if (sc.opts.autoScale !== false) { if (this.autoscale(p, sc, v)) sc.ready = true; }
        else if (!sc.ready) { if (this.autoscale(p, sc, v)) sc.ready = true; }
        else if (sc.first == null) this.autoscaleFirst(p, sc, v);
      }
    }
    const need = { right: this.measureAxis('right'), left: this.measureAxis('left') };
    if (need.right !== this.axisW.right || need.left !== this.axisW.left) {
      this.axisW = need;
      const before = [this.lw, this.rw];
      this.layout();
      // a range requested before the width of the price scale is known (on opening the data arrive together with the range request)
      // is applied again on the real width, as LW, which already computes it on that: before, with the scale widened from 56 to 80
      // px, ~157 bars remained instead of 159
      if (this.pendRange && (before[0] !== this.lw || before[1] !== this.rw)) { this.api.timeScale().setVisibleLogicalRange(this.pendRange); v = this.visibleIdx(); }
      if (before[0] !== this.lw || before[1] !== this.rw) { this.dirty = false; for (const p of this.panes) for (const sc of p.scales.values()) if (sc.opts.autoScale !== false) this.autoscale(p, sc, v); }
    }
    this.pendRange = null;
    this.ticks = this.timeTicks();
    for (const p of this.panes) p.items = this.collectPrims(p);
    this.drawGl(v);
    for (const p of this.panes) if (!p.hidden) this.drawPrims(p, v);
    this.drawAxes(v);
    this.drawCross();
    this.emitRange();
    this.lastFrameMs = performance.now() - t0;
  }
  autoscaleFirst(p, sc, v) {
    for (const s of p.series) {
      if (s.scaleId !== sc.id || !s.store.n) continue;
      const [pa, pb] = s.store.posRange(v.first, v.last);
      for (let q = pa; q <= pb; q++) { const x = s.valueAt(q); if (x === x) { sc.first = x; return; } }
    }
  }
  /** Price formatting of a scale (LW's localization, then the format of the first series). */
  scaleFormat(p, sc) {
    const L = this.o.localization;
    const mode = sc.opts.mode;
    if (mode === 2 || mode === 3) {
      const f0 = sc.first;
      return (x) => { if (!f0) return ''; const r = mode === 2 ? ((x - f0) / Math.abs(f0)) * 100 : (x / f0) * 100; return fmtPrice(r, 2, this.locale) + (mode === 2 ? '%' : ''); };
    }
    if (L.priceFormatter) return (x) => L.priceFormatter(x);
    const s = p.series.find((q) => q.scaleId === sc.id);
    return s ? s.formatter() : (x) => fmtPrice(x, 2, this.locale);
  }
  /** Prices of the lines and their texts, once per scale field (cached on the scale). */
  tickInfo(p, sc) {
    const ps = sc.ps, key = `${ps.lo}|${ps.hi}|${ps.height}|${sc.opts.mode}|${sc.first}|${sc.opts.invertScale}|${p.series.find((q) => q.scaleId === sc.id)?.opts.priceFormat?.minMove}`;
    if (sc.tk?.key === key) return sc.tk;
    const ticks = this.tickPrices(p, sc), f = this.scaleFormat(p, sc), L = this.o.localization;
    const labels = L.tickmarksPriceFormatter && !(sc.opts.mode === 2 || sc.opts.mode === 3) ? L.tickmarksPriceFormatter(ticks) : ticks.map(f);
    sc.tk = { key, ticks, labels, f };
    return sc.tk;
  }
  /** Width of a text in the scales' font (measurements are kept: measureText is costly). */
  textW(c, t) {
    let m = this.tw;
    if (!m || m.font !== this.font()) m = this.tw = { font: this.font(), map: new Map() };
    let w = m.map.get(t);
    if (w === undefined) { c.font = m.font; w = c.measureText(t).width; if (m.map.size > 5000) m.map.clear(); m.map.set(t, w); }
    return w;
  }
  tickPrices(p, sc) {
    if (!sc.ready) return [];
    const mode = sc.opts.mode, min = Math.ceil(this.o.layout.fontSize * 2.5);
    if ((mode === 2 || mode === 3) && sc.first) {
      // round steps in the percentage scale
      const f0 = sc.first, tr = (x) => (mode === 2 ? ((x - f0) / Math.abs(f0)) * 100 : (x / f0) * 100), inv = (r) => (mode === 2 ? f0 + (r / 100) * Math.abs(f0) : (r / 100) * f0);
      const fake = new PriceScale({ marginTop: 0, marginBottom: 0 });
      fake.height = sc.ps.height;
      const a = tr(sc.ps.fromY(sc.ps.height)), b = tr(sc.ps.fromY(0));
      fake.lo = Math.min(a, b); fake.hi = Math.max(a, b);
      return priceTicks(fake, min).map(inv);
    }
    const pf = p.series.find((q) => q.scaleId === sc.id)?.opts.priceFormat, mm = pf && pf.type !== 'volume' && pf.type !== 'percent' ? pf.minMove : undefined;
    return priceTicks(sc.ps, min, mm);
  }
  measureAxis(side) {
    const o = side === 'right' ? this.o.rightPriceScale : this.o.leftPriceScale;
    if (!o.visible) return 0;
    // width of the price scale: the widest text among ALL the grid labels, the last value and the price lines with a label, then
    // `priceAxisWidth`; the same width for all panes. Measured on LW with 180 random charts (fields from 10^-3 to 10^5, precisions
    // 0-8, fonts 10-16, negative values): 0 differences. Prices at the ends of the field do not count (tried: with those, 13 charts
    // out of 120 were wrong). Without labels (empty chart) LW gives 54, 56, 60 with fonts 10, 12, 16: like a 34 px text.
    const c = this.axes.time.x, fs = this.o.layout.fontSize;
    let w = 0;
    for (const p of this.panes) {
      const sc = p.scales.get(side);
      if (!sc?.ready || !p.series.some((q) => q.scaleId === side)) continue;
      const { labels, f } = this.tickInfo(p, sc);
      for (const lb of labels) w = Math.max(w, this.textW(c, lb));
      for (const s of p.series) {
        if (s.scaleId !== side || !s.store.n) continue;
        const last = s.lastVisiblePos();
        if (last >= 0 && s.opts.lastValueVisible) w = Math.max(w, this.textW(c, f(s.valueAt(last))));
        for (const l of s.lines) if (l.o.axisLabelVisible && Number.isFinite(l.o.price)) w = Math.max(w, this.textW(c, f(l.o.price)));
      }
    }
    return Math.max(o.minimumWidth || 0, priceAxisWidth(w || EMPTY_LABEL_W, fs));
  }
  /** x of the text in the scale: after border, tick and inner spacing as LW. */
  axisTextX(side, w) { const pad = 1 + 5 + (this.o.layout.fontSize / 12) * 5; return side === 'right' ? pad : w - pad; }
  font() { return `${this.o.layout.fontSize}px ${this.o.layout.fontFamily}`; }

  timeTicks() {
    const ti = this.ti, ts = this.ts;
    if (!ti.n) return [];
    if (this.tixVer !== ti.version) {
      // boundary weights from the times (UTC seconds: LW knows no time zones, the application shifts the times)
      if (this.wts.length < ti.n) this.wts = new Uint8Array(Math.max(ti.n * 2, 64));
      for (let i = 0; i < ti.n; i++) this.wts[i] = weightOf(ti.t[i] * 1000, i ? ti.t[i - 1] * 1000 : null);
      this.tix.build(this.wts, ti.n);
      this.tixVer = ti.version;
      const steps = [];
      for (let i = Math.max(1, ti.n - 200); i < ti.n; i++) steps.push(ti.t[i] - ti.t[i - 1]);
      steps.sort((a, b) => a - b);
      this.step = steps[steps.length >> 1] || 60;
    }
    const lo = Math.max(0, Math.ceil(ts.index(0))), hi = Math.floor(ts.index(this.areaW));
    const n = ti.n, last = ti.t[n - 1], step = this.step;
    const timeAt = (i) => (i < n ? ti.t[i] : last + (i - n + 1) * step) * 1000;
    const extra = [];
    for (let i = Math.max(n, lo); i <= Math.min(hi, n + 3000); i++) { const w = weightOf(timeAt(i), timeAt(i - 1)); if (w) extra.push({ i, w }); }
    const tso = this.o.timeScale;
    // finest level that fits (measured on LW): among the periods below the day not shorter than a bar, the shortest with at least
    // the minimum distance between two labels (1-minute bars at 10 px: 10 minutes; at 7 px: 15; at 5 px: 30); the labels are the
    // boundaries of that level and of the larger ones, then the filling
    const minDist = timeTickMinDist(this.o.layout.fontSize);
    let period = 0; // chosen period in ms (0: no level below the day)
    if (step < 86400) for (let q = SUBDAY.length - 1; q >= 0; q--) if (SUBDAY[q][0] / 1000 >= step && (SUBDAY[q][0] / 1000 / step) * ts.spacing >= minDist) { period = SUBDAY[q][0]; break; }
    // labels: the boundaries of the chosen period (not the multiples of other levels that are not multiples of it: with 10 minutes
    // no :15 and :45) and the larger boundaries; the day boundaries and up are always there
    const keep = (w) => w >= W_DAY || (period > 0 && SUBDAY.some(([p, wt]) => wt === w && p % period === 0));
    let ticks = this.tix.pick(lo, Math.min(hi, n - 1), (i) => ts.x(i), minDist, extra, 200, step >= 86400 ? W_DAY : step >= 60 ? 40 : 20, step < 86400 ? keep : null);
    if (!tso.timeVisible) ticks = ticks.filter((k) => k.w >= W_DAY);
    for (const k of ticks) {
      const t = timeAt(k.i);
      if (tso.tickMarkFormatter) {
        const type = k.w >= 100 ? 0 : k.w >= 90 ? 1 : k.w >= W_DAY ? 2 : k.w >= 40 ? 3 : 4;
        const r = tso.tickMarkFormatter(t / 1000, type, this.locale);
        if (r != null) { k.label = r; continue; }
      }
      k.label = tickLabel(t, !tso.secondsVisible && k.w < 40 ? 40 : k.w, this.locale);
    }
    return ticks;
  }

  uniforms(p, sc, base) {
    const dpr = this.dpr, ts = this.ts, ps = sc.ps;
    const rightI = Math.floor(ts.right);
    const y = Math.round(p.y * dpr), h = Math.round((p.y + p.h) * dpr) - y;
    // device y = (hi − v) · (height − 1) / field · pixel ratio (as toY, row 0 ... height − 1)
    let hi = ps.log ? ps.hi : ps.hi - base, k = (ps.span * (h / p.h)) / (ps.hi - ps.lo);
    if (sc.opts.invertScale) { hi = ps.log ? ps.lo : ps.lo - base; k = -k; }
    return { rightI, rightF: ts.right - rightI, sp: ts.spacing * (this.glW / this.areaW), areaW: this.glW - ts.pad * (this.glW / this.areaW), paneY: y, paneH: h, hi, k, log: ps.log, base, rect: { x: 0, y, w: this.glW, h } };
  }
  /** y in CSS pixels (from the top of the pane) of a price in scale sc, honouring invertScale. */
  yOf(sc, price) { const y = sc.ps.toY(price); return sc.opts.invertScale ? sc.ps.span - y : y; }

  drawGl(v) {
    const R = this.R;
    if (R.lost) return;
    const dpr = this.dpr, o = this.o;
    R.begin(this.glW, this.glH, null);
    this.histSlot = 0;
    const rects = (this._rects ||= new Float32Array(5 * 8192)), ru = (this._rectsU ||= new Uint32Array(rects.buffer));
    let n = 0;
    const rect = (x0, y0, x1, y1, col) => { if (n >= 8192) return; const q = n * 5; rects[q] = x0; rects[q + 1] = y0; rects[q + 2] = x1; rects[q + 3] = y1; ru[q + 4] = col; n++; };
    const lw = Math.max(1, Math.floor(dpr));
    const hline = (y, x0, x1, col, width, style) => {
      const w = Math.max(1, Math.floor(width * dpr + 1e-9)), yy = Math.round(y) - Math.floor(w / 2); // thickness floor(thickness · dpr) like the other lines (at DPR 1.5 one row, not two)
      const [on, off] = dashFor(style, w);
      if (!on) { rect(x0, yy, x1, yy + w, col); return; }
      for (let x = x0; x < x1; x += on + off) rect(x, yy, Math.min(x1, x + on), yy + w, col);
    };
    const vline = (x, y0, y1, col, style) => {
      const [on, off] = dashFor(style, lw);
      if (!on) { rect(x, y0, x + lw, y1, col); return; }
      for (let y = y0; y < y1; y += on + off) rect(x, y, x + lw, Math.min(y1, y + on), col);
    };
    // grid
    const gv = o.grid.vertLines, gh = o.grid.horzLines;
    if (gv.visible !== false) { const c = packRgba(gv.color); for (const k of this.ticks) vline(Math.round(k.x * dpr), 0, this.glH, c, gv.style || 0); }
    if (gh.visible !== false) {
      const c = packRgba(gh.color);
      for (const p of this.vis) {
        const sc = p.scales.get('right')?.ready && p.series.some((s) => s.scaleId === 'right') ? p.scales.get('right') : p.scales.get('left');
        if (!sc?.ready) continue;
        const y0 = Math.round(p.y * dpr), y1 = Math.round((p.y + p.h) * dpr);
        for (const price of this.tickInfo(p, sc).ticks) { const y = y0 + Math.round(this.yOf(sc, price) * dpr); if (y >= y0 && y < y1) hline(y, 0, this.glW, c, 1 / dpr * lw, gh.style || 0); }
      }
    }
    // pane separators
    const sepc = packRgba(o.layout.panes?.separatorColor || '#E0E3EB');
    for (let i = 1; i < this.vis.length; i++) { const y = Math.round((this.vis[i].y - 1) * dpr); rect(0, y, this.glW, y + lw, sepc); }
    R.rects(rects, n);

    // series
    const spDev = this.ts.spacing * (this.glW / this.areaW);
    const lines = []; // price lines above the series
    for (const p of this.vis) {
      this.primsGl(p, v, true); // WebGL drawings of primitives below the series (script backgrounds, fills, boxes)
      for (const s of p.series) {
        if (!s.opts.visible || !s.store.n) continue;
        const sc = p.scale(s.scaleId, this);
        if (!sc.ready) continue;
        const st = s.store, U = this.uniforms(p, sc, st.base);
        R.clipTo(U.rect);
        const [pa, pb] = st.posRange(v.first - 1, v.last + 1);
        if (pb < pa - 1) continue;
        const vis = Math.max(1, pb - pa + 1), visIdx = Math.max(1, v.last - v.first + 1);
        const ptsPerBar = vis / visIdx, spPt = spDev / Math.max(ptsPerBar, 1e-9); // pixels per point
        try { this.drawSeries(R, s, U, pa, pb, spPt, dpr); } catch (e) { if (!this.warned) { this.warned = true; console.warn('[aq] serie', s.type, e); } }
        // last price line and price lines
        const last = st.lastFilled();
        if (last >= 0 && s.opts.priceLineVisible && s.opts.lastValueVisible !== undefined) {
          const val = s.valueAt(last), y = U.paneY + this.yOf(sc, val) * dpr;
          if (s.opts.priceLineVisible) lines.push([y, U.paneY, U.paneY + U.paneH, s.opts.priceLineColor ? packRgba(s.opts.priceLineColor) : s.lastColor(last), s.opts.priceLineWidth || 1, s.opts.priceLineStyle ?? 2]);
        }
        for (const l of s.lines) {
          const lo = l.o;
          if (!lo.lineVisible || !Number.isFinite(lo.price)) continue;
          const y = U.paneY + this.yOf(sc, lo.price) * dpr;
          lines.push([y, U.paneY, U.paneY + U.paneH, packRgba(lo.color || s.opts.color || s.opts.upColor || '#2196f3'), lo.lineWidth || 1, lo.lineStyle ?? 0]);
        }
      }
      this.primsGl(p, v, false); // above the series (script shapes and lines)
    }
    R.clipTo(null);
    n = 0;
    for (const [y, top, bot, col, w, style] of lines) if (y >= top && y <= bot) hline(Math.round(y), 0, this.glW, col, w, style);
    R.rects(rects, n, 1);
    R.end();
  }

  drawSeries(R, s, U, pa, pb, spPt, dpr) {
    const st = s.store, o = s.opts, t = s.type;
    if (t === 'Candlestick') { this.drawCandles(R, s, U, pa, pb); return; }
    if (t === 'Bar') { this.drawBarsOhlc(R, s, U, pa, pb); return; }
    if (t === 'Histogram') { this.drawHistogram(R, s, U, pa, pb); return; }
    // stepped lines, areas, baselines only if the line is visible: point markers alone (plot.style_circles) use the real points (the
    // stepped packet has the corners in between and shares the cache with the normal one)
    const markers = !!o.pointMarkersVisible, steps = o.lineType === 1 && !(markers && o.lineVisible === false);
    const k = steps || spPt >= 1 ? 0 : lodFor(spPt, 2);
    const g = st.packPoints(k, this.lineColorFn(s), steps);
    let from, count;
    if (steps) { from = Math.max(0, 2 * pa - 2); count = Math.min(g.n - 1, 2 * pb + 2) - from; }
    else if (k === 0) { from = Math.max(0, pa - 1); count = Math.min(st.n - 1, pb + 1) - from; }
    else { const len = st.count(k); const j0 = Math.max(0, (pa >> k) - 1), j1 = Math.min(len - 1, (pb >> k) + 1); from = 2 * j0; count = 2 * (j1 - j0) + 1; }
    if (t === 'Area' || t === 'Baseline') {
      if (t === 'Area') {
        const bottom = U.paneY + U.paneH;
        R.fill(st, g, from, count, U, { kind: 0, baseY: o.invertFilledArea ? U.paneY : bottom, g0: U.paneY, g1: bottom, c0: o.topColor, c1: o.bottomColor });
      } else {
        const sc = s.scale(), bv = o.baseValue?.price ?? 0;
        const by = U.paneY + this.yOf(sc, bv) * dpr;
        R.fill(st, g, from, count, U, { kind: 1, baseY: by, g0: U.paneY, g1: U.paneY + U.paneH, c0: o.topFillColor1, c1: o.topFillColor2, c2: o.bottomFillColor1, c3: o.bottomFillColor2 });
      }
    }
    if (o.lineVisible !== false && (o.lineWidth ?? 1) > 0) {
      const style = o.lineStyle || 0;
      R.line2(st, g, from, count, U, { width: (o.lineWidth || 1) * dpr, style, origin: style && k === 0 ? this.dashOrigin(st) : -Infinity });
    }
    // point markers as LW: radius pointMarkersRadius or thickness / 2 + 2, point colour, on all visible points (with the pyramid the
    // two ends of each group); not on visible stepped lines
    if (markers && !steps) { const pm = pointMarker(dpr, o.lineWidth || 1, o.pointMarkersRadius); R.points(st, g, from, count + 1, U, { radius: pm.radius, xCorr: pm.xCorr }); }
  }
  /**
   * Logical index of the first point that LW would draw of a line (where the canvas starts the dash pattern): the point with a
   * value before the first with index ≥ floor(left edge) (observed scrolling dashed lines in LW). Left edge = `from` of
   * getVisibleLogicalRange.
   */
  dashOrigin(st) {
    const first = Math.floor(this.visibleIdx().from);
    let p = st.lowerPos(first);
    while (p < st.n && st.empty(p)) p++;
    if (p >= st.n) return Infinity;
    let q = p - 1;
    while (q >= 0 && st.empty(q)) q--;
    return st.pi[q >= 0 ? q : p];
  }
  /** Collects the visible OHLC bars (or the pyramid's groups) in device-pixel columns, with positions in double precision. */
  gatherOhlc(s, U, pa, pb) {
    const st = s.store, sc = s.scale(), p = s.pane, ts = this.ts;
    pa = Math.max(0, pa); pb = Math.min(st.n - 1, pb);
    if (pb < pa || !sc.ready) return null;
    const hpr = this.glW / this.areaW, vpr = U.paneH / p.h;
    let k = 0;
    while (((pb - pa + 1) >> k) > this.glW * 2 && k < 30) k++;
    const cols = s.ohlcColors();
    const cap = (k ? (pb >> k) - (pa >> k) + 1 : pb - pa + 1) + 1;
    let B = this.cbars;
    if (!B || B.x.length < cap) B = this.cbars = { n: 0, x: new Int32Array(cap * 2), o: new Float64Array(cap * 2), h: new Float64Array(cap * 2), l: new Float64Array(cap * 2), c: new Float64Array(cap * 2), body: new Uint32Array(cap * 2), border: new Uint32Array(cap * 2), wick: new Uint32Array(cap * 2) };
    let m = 0;
    const add = (logical, vo, vh, vl, vc, at) => {
      const cc = cols(at, vc >= vo);
      B.x[m] = Math.round(ts.x(logical) * hpr);
      B.o[m] = this.yOf(sc, vo) * vpr; B.h[m] = this.yOf(sc, vh) * vpr; B.l[m] = this.yOf(sc, vl) * vpr; B.c[m] = this.yOf(sc, vc) * vpr;
      B.body[m] = cc[0]; B.border[m] = cc[1]; B.wick[m] = cc[2]; m++;
    };
    if (k === 0) {
      for (let i = pa; i <= pb; i++) if (st.c[i] === st.c[i]) add(st.pi[i], st.o[i], st.h[i], st.l[i], st.c[i], i);
    } else {
      const d = st.levels[k];
      for (let j = pa >> k; j <= (pb >> k) && j < d.len; j++) {
        const a = j << k, b = Math.min(st.n - 1, a + 2 ** k - 1);
        let first = a, last = b;
        while (first < b && st.empty(first)) first++;
        while (last > first && st.empty(last)) last--;
        if (st.empty(last)) continue;
        add((st.pi[a] + st.pi[b]) / 2, st.o[first], d.hi[j], d.lo[j], st.c[last], last);
      }
    }
    B.n = m;
    return { B, m, hpr, spacing: ts.spacing * 2 ** k };
  }
  /**
   * Rectangles in a reused list (Float32Array in groups of 5 with a Uint32 view); `per` = at most this many rectangles per bar.
   */
  rectList(m, per) {
    let f = this.crect;
    if (!f || f.length < m * per * 5) { f = this.crect = new Float32Array(Math.max(m * per * 5, 40 * 512) * 2); this.crectU = new Uint32Array(f.buffer); }
    return f;
  }
  /**
   * Candles (geometry in bars.js, written from measurements of LW's pixels). With more than two candles per pixel the pyramid's
   * groups are drawn (like a higher timeframe).
   */
  drawCandles(R, s, U, pa, pb) {
    const g = this.gatherOhlc(s, U, pa, pb);
    if (!g) return;
    const width = candleWidth(g.spacing, g.hpr), o = s.opts;
    const f = this.rectList(g.m, 8);
    const n = candleRects(g.B, { width, ...candleParts(width, g.hpr, g.spacing) }, { wick: o.wickVisible !== false, border: !!o.borderVisible }, f, this.crectU, U.paneY);
    R.rects(f, n, 2 + (this.histSlot++ % 30));
  }
  /**
   * OHLC bars (geometry in bars.js, measured on LW): stem from high to low, open tick on the left and close tick on the right.
   */
  drawBarsOhlc(R, s, U, pa, pb) {
    const g = this.gatherOhlc(s, U, pa, pb);
    if (!g) return;
    const o = s.opts, part = barParts(g.spacing, g.hpr, o.thinBars !== false);
    const f = this.rectList(g.m, 3);
    const n = barRects(g.B, { stem: part.stem, left: o.openVisible === false ? 0 : part.left, right: part.right }, f, this.crectU, U.paneY);
    R.rects(f, n, 2 + (this.histSlot++ % 30));
  }

  /**
   * Histogram (columns in bars.js, written from LW measurements). With more than two bars per pixel the pyramid is used (the value
   * furthest from the base in each group).
   */
  drawHistogram(R, s, U, pa, pb) {
    const st = s.store, o = s.opts, sc = s.scale(), p = s.pane, ts = this.ts;
    pa = Math.max(0, pa); pb = Math.min(st.n - 1, pb);
    if (pb < pa || !sc.ready) return;
    const hpr = this.glW / this.areaW, vpr = U.paneH / p.h;
    let k = 0;
    while (((pb - pa + 1) >> k) > this.glW * 2 && k < 30) k++;
    const pitch = ts.spacing * 2 ** k * hpr;
    const gap = histGap(pitch, hpr);
    const col = s.colorFn(), base = o.base ?? 0;
    const cap = (k ? (pb >> k) - (pa >> k) + 1 : pb - pa + 1) + 1;
    let H = this.hbuf;
    if (!H || H.cx.length < cap) H = this.hbuf = { cx: new Float64Array(cap * 2), adj: new Float64Array(cap * 2), v: new Float64Array(cap * 2), col: new Uint32Array(cap * 2), l: new Int32Array(cap * 2), r: new Int32Array(cap * 2) };
    let m = 0;
    const add = (logical, order, v, c) => { H.cx[m] = ts.x(logical) * hpr; H.adj[m] = order; H.v[m] = v; H.col[m] = c; m++; };
    if (k === 0) {
      for (let i = pa; i <= pb; i++) { const v = st.v[i]; if (v === v) add(st.pi[i], st.pi[i], v, col(i)); }
    } else {
      const d = st.levels[k];
      for (let j = pa >> k; j <= (pb >> k) && j < d.len; j++) {
        if (d.loP[j] < 0) continue;
        const q = Math.abs(d.hi[j] - base) >= Math.abs(d.lo[j] - base) ? d.hiP[j] : d.loP[j];
        const a = j << k, b = Math.min(st.n - 1, a + 2 ** k - 1);
        add((st.pi[a] + st.pi[b]) / 2, j, st.v[q], col(q));
      }
    }
    histColumns(m, H.cx, H.adj, pitch, gap, H.l, H.r);
    // rows: from the value's row down to the base line, which the column always covers (one device pixel thick)
    const thick = Math.max(1, Math.floor(vpr));
    const baseTop = Math.round(this.yOf(sc, base) * vpr) - Math.floor(thick / 2), baseEnd = baseTop + thick;
    let f = this.hrect;
    if (!f || f.length < m * 5) { f = this.hrect = new Float32Array(Math.max(m * 5, 5 * 1024) * 2); this.hrectU = new Uint32Array(f.buffer); }
    const u = this.hrectU;
    let n = 0;
    for (let j = 0; j < m; j++) {
      const y = Math.round(this.yOf(sc, H.v[j]) * vpr);
      if (!Number.isFinite(y)) continue;
      const above = y <= baseTop, q = n * 5;
      f[q] = H.l[j]; f[q + 1] = U.paneY + (above ? y : baseTop); f[q + 2] = H.r[j] + 1; f[q + 3] = U.paneY + (above ? baseEnd : y - Math.floor(thick / 2) + thick); u[q + 4] = H.col[j]; n++;
    }
    R.rects(f, n, 2 + (this.histSlot++ % 30));
  }
  lineColorFn(s) {
    if (s.type !== 'Baseline') return s.colorFn();
    const st = s.store, o = s.opts, b = o.baseValue?.price ?? 0, up = packRgba(o.topLineColor), dn = packRgba(o.bottomLineColor);
    return (i) => (st.has[i] & 1 ? st.c1[i] : st.v[i] >= b ? up : dn);
  }

  /** Views of the pane's primitives for this frame (once: the WebGL pass and the canvases use them). */
  collectPrims(p) {
    const items = [];
    const collect = (prim, series) => {
      try { prim.updateAllViews?.(); } catch { /* */ }
      let views = [];
      try { views = prim.paneViews?.() || []; } catch { views = []; }
      for (const vw of views) {
        let r = null;
        try { r = vw.renderer?.(); } catch { r = null; }
        if (r) items.push({ z: vw.zOrder?.() || 'normal', r, series, prim });
      }
    };
    for (const prim of p.prims) collect(prim, null);
    for (const s of p.series) { if (!s.opts.visible) continue; for (const prim of s.prims) collect(prim, s); }
    return items;
  }

  /**
   * Native interface for the primitives' WebGL drawings (ScriptLayer of drawings.js in the host application): a renderer with
   * `drawAq(scope)` draws here, on the chart's WebGL canvas, below the pane's series (zOrder 'bottom') or above (the others), and
   * then with `draw(target)` on the 2D canvas only what remains (text). scope: R (GlpRenderer), U(base) uniform of the series'
   * scale with that reference price, x/y in CSS px, top (pane y in device pixels), hpr/vpr, dpr, first/last visible bars, spacing,
   * pane width/height in CSS px, slot() for single-frame buffers.
   */
  primsGl(p, v, bottom) {
    if (!p.items || globalThis.__aqNoPrimGl) return; // __aqNoPrimGl: tests, everything on the canvas as before
    const R = this.R;
    for (const it of p.items) {
      if (!it.r.drawAq || (it.z === 'bottom') !== bottom || !it.series) continue;
      const s = it.series, sc = s.scale();
      if (!sc.ready) continue;
      const U0 = this.uniforms(p, sc, 0);
      const scope = {
        R, dpr: this.dpr, hpr: this.glW / this.areaW, vpr: U0.paneH / p.h, top: U0.paneY,
        U: (base) => (base ? this.uniforms(p, sc, base) : U0),
        x: (i) => this.ts.x(i), y: (price) => this.yOf(sc, price),
        first: v.first, last: v.last, spacing: this.ts.spacing, width: this.areaW, height: p.h,
        slot: () => 2 + (this.histSlot++ % 30),
      };
      R.clipTo(U0.rect);
      try { it.r.drawAq(scope); } catch (e) { it.r.aq = false; this.primErr(e); }
    }
    R.clipTo(null);
  }

  /** Pane primitives on its two 2D canvases (below and above the series); markers above. */
  drawPrims(p, v) {
    const items = p.items || this.collectPrims(p);
    const markerSeries = p.series.filter((s) => s.markers?.list.length && s.opts.visible);
    for (const which of ['bottom', 'top']) {
      const L = p.layers[which];
      const list = which === 'bottom' ? items : items.filter((it) => it.z !== 'bottom');
      const hasMarkers = which === 'top' && markerSeries.length;
      if (!list.length && !hasMarkers && !p.drawn[which]) continue;
      const c = L.x;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, L.dw, L.dh);
      let drew = false;
      const spy = spyOn(c, () => { drew = true; });
      const target = this.target(c, L);
      if (which === 'bottom') {
        for (const it of items) if (it.r.drawBackground) { try { it.r.drawBackground(target); } catch (e) { this.primErr(e); } }
        for (const it of items) if (it.z === 'bottom') { try { it.r.draw(target); } catch (e) { this.primErr(e); } }
      } else {
        for (const z of ['normal', 'top']) for (const it of list) if (it.z === z) { try { it.r.draw(target); } catch (e) { this.primErr(e); } }
        for (const s of markerSeries) { drew = true; this.drawMarkers(c, s, p, v); }
      }
      spy();
      p.drawn[which] = drew;
    }
  }
  primErr(e) { if (!this.primWarned) { this.primWarned = true; console.warn('[aq] primitiva', e); } }
  target(c, L) {
    const dpr = this.dpr;
    const bitmap = { context: c, bitmapSize: { width: L.dw, height: L.dh }, mediaSize: { width: L.w, height: L.h }, horizontalPixelRatio: L.dw / L.w, verticalPixelRatio: L.dh / L.h };
    const media = { context: c, mediaSize: { width: L.w, height: L.h } };
    return {
      context: c,
      mediaSize: media.mediaSize, bitmapSize: bitmap.bitmapSize, horizontalPixelRatio: bitmap.horizontalPixelRatio, verticalPixelRatio: bitmap.verticalPixelRatio,
      useBitmapCoordinateSpace(f) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); try { return f(bitmap); } finally { c.restore(); } },
      useMediaCoordinateSpace(f) { c.save(); c.setTransform(dpr, 0, 0, dpr, 0, 0); try { return f(media); } finally { c.restore(); } },
    };
  }

  drawMarkers(c, s, p, v) {
    const dpr = this.dpr, sc = s.scale(), st = s.store, fs = this.o.layout.fontSize;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.font = `${fs}px ${this.o.layout.fontFamily}`;
    c.textAlign = 'center';
    const size = Math.min(Math.max(this.ts.spacing, 12), 30);
    const stack = new Map(); // index → [above, below]
    for (const m of s.markers.list) {
      const i = this.ti.indexOf(timeOf(m.time));
      if (i < v.first - 1 || i > v.last + 1 || i < 0) continue;
      const x = this.ts.x(i);
      const q = st.lowerPos(i), has = q < st.n && st.pi[q] === i;
      const hiP = has ? (st.kind === KIND_OHLC ? st.h[q] : st.v[q]) : m.price, loP = has ? (st.kind === KIND_OHLC ? st.l[q] : st.v[q]) : m.price;
      const sz = Math.round(size * (m.size ?? 1)) | 1;
      const pos = m.position || 'aboveBar';
      let y;
      const used = stack.get(i) || [0, 0];
      stack.set(i, used);
      if (pos === 'aboveBar') { y = this.yOf(sc, hiP) - 4 - used[0] - sz / 2; used[0] += sz + 4 + (m.text ? fs + 2 : 0); }
      else if (pos === 'belowBar') { y = this.yOf(sc, loP) + 4 + used[1] + sz / 2; used[1] += sz + 4 + (m.text ? fs + 2 : 0); }
      else if (pos === 'inBar') y = this.yOf(sc, has ? s.valueAt(q) : m.price);
      else if (pos === 'atPriceTop') y = this.yOf(sc, m.price) - sz / 2;
      else if (pos === 'atPriceBottom') y = this.yOf(sc, m.price) + sz / 2;
      else y = this.yOf(sc, m.price);
      if (!Number.isFinite(y)) continue;
      c.fillStyle = m.color || '#2196F3';
      const r = sz / 2;
      c.beginPath();
      if (m.shape === 'circle') c.arc(x, y, r * 0.8, 0, Math.PI * 2);
      else if (m.shape === 'square') c.rect(x - r * 0.7, y - r * 0.7, r * 1.4, r * 1.4);
      else if (m.shape === 'arrowUp') { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x + r * 0.35, y); c.lineTo(x + r * 0.35, y + r); c.lineTo(x - r * 0.35, y + r); c.lineTo(x - r * 0.35, y); c.lineTo(x - r, y); c.closePath(); }
      else if (m.shape === 'arrowDown') { c.moveTo(x, y + r); c.lineTo(x + r, y); c.lineTo(x + r * 0.35, y); c.lineTo(x + r * 0.35, y - r); c.lineTo(x - r * 0.35, y - r); c.lineTo(x - r * 0.35, y); c.lineTo(x - r, y); c.closePath(); }
      c.fill();
      if (m.text) {
        c.textBaseline = pos === 'belowBar' || pos === 'atPriceBottom' ? 'top' : 'bottom';
        c.fillText(m.text, x, pos === 'belowBar' || pos === 'atPriceBottom' ? y + r + 2 : y - r - 2);
      }
    }
  }

  drawAxes(v) {
    const dpr = this.dpr, o = this.o, fs = o.layout.fontSize, font = this.font();
    for (const side of ['right', 'left']) {
      const A = this.axes[side], w = side === 'right' ? this.rw : this.lw;
      if (!w) continue;
      const c = A.x, so = side === 'right' ? o.rightPriceScale : o.leftPriceScale;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, this.areaH);
      c.font = font;
      c.textBaseline = 'middle';
      if (so.borderVisible !== false) { c.fillStyle = so.borderColor; c.fillRect(side === 'right' ? 0 : w - 1, 0, 1, this.areaH); }
      const tx = this.axisTextX(side, w);
      // grid labels (measured on LW's pixels): x = round(tick 5 + 5/12 of the font) from the chart side, without the border (value
      // labels instead border + tick + spacing, not rounded: tx)
      const gx = side === 'right' ? Math.round(5 + (fs * 5) / 12) : Math.round(w - 5 - (fs * 5) / 12);
      c.textAlign = side === 'right' ? 'left' : 'right';
      for (const p of this.vis) {
        const sc = p.scales.get(side);
        if (p !== this.vis[0] && p.series.length) { c.fillStyle = o.layout.panes?.separatorColor || so.borderColor; c.fillRect(0, p.y - 1, w, 1); }
        if (!sc?.ready || !p.series.some((s) => s.scaleId === side)) continue;
        const { ticks, labels, f } = this.tickInfo(p, sc);
        // labels of the last values and of the price lines: they cover the neighbouring grid labels
        const tags = [];
        for (const s of p.series) {
          if (s.scaleId !== side || !s.opts.visible) continue;
          const last = s.lastVisiblePos();
          if (last >= 0 && s.opts.lastValueVisible) { const val = s.valueAt(last), col = s.lastColor(last); tags.push({ y: this.yOf(sc, val), text: f(val), bg: hexOf(col), fg: contrast(col), title: s.opts.title }); }
          for (const l of s.lines) if (l.o.axisLabelVisible && Number.isFinite(l.o.price)) { const col = packRgba(l.o.axisLabelColor || l.o.color || '#2196f3'); tags.push({ y: this.yOf(sc, l.o.price), text: f(l.o.price), bg: l.o.axisLabelColor || l.o.color || hexOf(col), fg: l.o.axisLabelTextColor || contrast(col), title: l.o.title }); }
          for (const prim of s.prims) {
            let views = [];
            try { prim.updateAllViews?.(); views = prim.priceAxisViews?.() || []; } catch { views = []; }
            for (const pv of views) { try { if (pv.visible?.() === false) continue; const y = pv.coordinate(); if (Number.isFinite(y)) tags.push({ y, text: pv.text(), bg: pv.backColor(), fg: pv.textColor() }); } catch { /* */ } }
          }
        }
        c.fillStyle = so.textColor || o.layout.textColor;
        const lh = fs + 8;
        ticks.forEach((t, k) => {
          const y = this.yOf(sc, t);
          if (y < 6 || y > p.h - 6) return;
          if (tags.some((g) => Math.abs(g.y - y) < lh)) return;
          c.fillText(labels[k], gx, p.y + y);
        });
        for (const g of tags) {
          if (!(g.y >= -lh && g.y <= p.h + lh)) continue;
          const y = Math.round(p.y + Math.min(p.h - lh / 2, Math.max(lh / 2, g.y)));
          c.fillStyle = g.bg;
          c.fillRect(side === 'right' ? 1 : 0, y - lh / 2, w - 1, lh);
          c.fillStyle = g.fg;
          c.fillText(g.text, tx, y + 0.5);
        }
      }
    }
    const T = this.axes.time;
    if (this.timeH) {
      const c = T.x, tso = o.timeScale;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, this.W, this.timeH);
      if (tso.borderVisible !== false) { c.fillStyle = tso.borderColor; c.fillRect(0, 0, this.W, 1); }
      c.font = font;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = o.layout.textColor;
      const maxW = this.ticks.length ? Math.max(...this.ticks.map((k) => k.w)) : 0;
      for (const k of this.ticks) {
        const x = this.lw + k.x, hw = this.textW(c, k.label) / 2;
        if (k.x - hw < 2 || k.x + hw > this.areaW - 2) continue;
        c.font = tso.allowBoldLabels !== false && k.w === maxW && k.w >= W_DAY && this.ticks.some((q) => q.w < maxW) ? `bold ${font}` : font;
        c.fillText(k.label, x, timeTextY(fs));
      }
      // primitive labels on the time axis
      c.font = font;
      for (const s of this.allSeries) for (const prim of s.prims) {
        let views = [];
        try { views = prim.timeAxisViews?.() || []; } catch { views = []; }
        for (const tv of views) {
          try {
            if (tv.visible?.() === false) continue;
            const x = this.lw + tv.coordinate(), text = tv.text(), w = c.measureText(text).width + 12;
            if (!Number.isFinite(x)) continue;
            c.fillStyle = tv.backColor(); c.fillRect(x - w / 2, 1, w, this.timeH - 2);
            c.fillStyle = tv.textColor(); c.fillText(text, x, this.timeH / 2 + 1);
          } catch { /* */ }
        }
      }
    }
  }

  drawCross() {
    const L = this.cross, c = L.x, dpr = this.dpr, ch = this.o.crosshair, a = this.crossAt;
    const show = a && ch.mode !== 2 && this.ti.n;
    if (!show && !this.crossShown) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    this.crossShown = false;
    if (!show) return;
    this.crossShown = true;
    // mouse crosshair: the bar is the one under the pointer even if the view changed (animated zoom, new bars)
    if (a.mouse) a.logical = this.ts.nearest(a.x);
    // crosshair lines on the device-pixel grid (measured on LW): width floor(dpr · thickness), start = round(coordinate · dpr) −
    // floor(width / 2)
    const xd = Math.round((this.lw + this.ts.x(a.logical)) * dpr), px = (w) => Math.max(1, Math.floor(dpr * (w || 1)));
    const vw = px(ch.vertLine.width), hw = px(ch.horzLine.width);
    const x = (xd - Math.floor(vw / 2) + vw / 2) / dpr;
    const dash = (st, w) => { const [on, off] = dashFor(st, w); c.setLineDash(on ? [on, off] : []); };
    const vl = ch.vertLine, hl = ch.horzLine;
    if (vl.visible !== false) { c.strokeStyle = vl.color; c.lineWidth = vw / dpr; dash(vl.style ?? 3, vl.width || 1); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.areaH); c.stroke(); }
    const p = a.pane;
    if (p && hl.visible !== false && a.y != null) {
      const yd = Math.round((p.y + a.y) * dpr), y = (yd - Math.floor(hw / 2) + hw / 2) / dpr;
      c.strokeStyle = hl.color; c.lineWidth = hw / dpr; dash(hl.style ?? 3, hl.width || 1);
      c.beginPath(); c.moveTo(this.lw, y); c.lineTo(this.lw + this.areaW, y); c.stroke();
    }
    c.setLineDash([]);
    c.font = this.font();
    c.textBaseline = 'middle';
    const fs = this.o.layout.fontSize;
    // price label (LW measurements): attached to the chart, centred on the row of the horizontal line
    if (p && hl.labelVisible !== false && a.y != null) {
      for (const side of ['right', 'left']) {
        const w = side === 'right' ? this.rw : this.lw, sc = p.scales.get(side);
        if (!w || !sc?.ready || !p.series.some((s) => s.scaleId === side)) continue;
        const price = sc.ps.fromY(sc.opts.invertScale ? sc.ps.span - a.y : a.y), text = this.scaleFormat(p, sc)(price);
        const z = crossPriceLabel(c.measureText(text).width, fs, dpr), row = Math.round((p.y + a.y) * dpr);
        const x0 = side === 'right' ? this.lw + this.areaW : this.lw - z.w, y0 = (row - Math.floor((z.h * dpr) / 2)) / dpr;
        c.fillStyle = hl.labelBackgroundColor; c.fillRect(x0, y0, z.w, z.h);
        c.fillStyle = contrast(packRgba(hl.labelBackgroundColor)); c.textAlign = side === 'right' ? 'left' : 'right';
        // text (measured on LW's pixels with fonts from 8 to 30): like the scale labels minus one pixel, a little below the centre
        c.fillText(text, side === 'right' ? x0 + this.axisTextX('right', z.w) - 1 : x0 + z.w - this.axisTextX('right', z.w) + 1, y0 + z.h / 2 + 0.5 + 0.06 * fs);
      }
    }
    // date and time (LW measurements): below the charts area, centred on the column of the vertical line
    if (vl.labelVisible !== false && this.timeH) {
      const i = a.logical, n = this.ti.n;
      const t = i < n && i >= 0 ? this.ti.t[i] : this.ti.t[n - 1] + (i - n + 1) * (this.step || 60);
      const L2 = this.o.localization;
      const text = L2.timeFormatter ? L2.timeFormatter(t) : crossLabel(t * 1000, { locale: this.locale, intraday: this.o.timeScale.timeVisible && (this.step || 60) < 86400, seconds: this.o.timeScale.secondsVisible && (this.step || 60) < 60 });
      const tw = c.measureText(text).width, z = crossTimeLabel(tw, fs, dpr);
      // position (measured on LW): centred on the line's column with the unrounded width (text + margin: 1.44 · font + 0.5 at DPR 1,
      // 1.5 · font beyond), rounded down; inside the charts area; 40 out of 44 equal, the others off by 1 pixel
      const lx = Math.min(Math.max(this.lw, Math.floor(xd + 0.5 - (dpr * (tw + (dpr < 1.5 ? 1.44 * fs + 0.5 : 1.5 * fs))) / 2) / dpr), this.lw + this.areaW - z.w);
      c.fillStyle = vl.labelBackgroundColor; c.fillRect(lx, this.areaH, z.w, z.h);
      c.fillStyle = contrast(packRgba(vl.labelBackgroundColor)); c.textAlign = 'center';
      c.fillText(text, lx + z.w / 2 - 0.5, this.areaH + z.h / 2 + 2.5); // text: half a pixel left of the centre, 2.5 px below (measured)
    }
    // crosshair markers on the lines
    if (p) for (const s of p.series) {
      if (!(s.type === 'Line' || s.type === 'Area' || s.type === 'Baseline') || s.opts.crosshairMarkerVisible === false || !s.opts.visible) continue;
      const st = s.store, q = st.lowerPos(a.logical);
      if (q >= st.n || st.pi[q] !== a.logical) continue;
      const val = st.v[q], sc = s.scale();
      if (!(val === val) || !sc.ready) continue;
      const y = p.y + this.yOf(sc, val), r = s.opts.crosshairMarkerRadius ?? 4, col = hexOf(this.lineColorFn(s)(q));
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = s.opts.crosshairMarkerBackgroundColor || col; c.fill();
      c.lineWidth = s.opts.crosshairMarkerBorderWidth ?? 2; c.strokeStyle = s.opts.crosshairMarkerBorderColor || this.root.style.background || '#fff'; c.stroke();
    }
  }

  emitRange() {
    const r = this.api.timeScale().getVisibleLogicalRange();
    const key = r ? `${r.from.toFixed(4)}|${r.to.toFixed(4)}` : '';
    if (key === this.lastRange) return;
    this.lastRange = key;
    for (const f of this.subs.range) try { f(r); } catch (e) { console.warn(e); }
    if (this.subs.trange.size) { const tr = this.api.timeScale().getVisibleRange(); for (const f of this.subs.trange) try { f(tr); } catch (e) { console.warn(e); } }
  }

  // ---------------- interaction ----------------
  pos(e) { const r = this.root.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  region(x, y) {
    if (y >= this.areaH) return { kind: 'time' };
    let pane = this.vis.find((p) => y >= p.y && y < p.y + p.h) || null;
    if (!pane) { for (let i = 1; i < this.panes.length; i++) if (!this.panes[i].hidden && Math.abs(y - (this.panes[i].y - 0.5)) <= 3) return { kind: 'sep', index: i }; pane = this.vis[this.vis.length - 1] || this.panes[this.panes.length - 1]; }
    if (x < this.lw) return { kind: 'price', side: 'left', pane };
    if (x >= this.lw + this.areaW) return { kind: 'price', side: 'right', pane };
    for (let i = 1; i < this.panes.length; i++) if (!this.panes[i].hidden && this.panes[i] !== this.vis[0] && Math.abs(y - (this.panes[i].y - 0.5)) <= 3 && this.o.layout.panes?.enableResize !== false) return { kind: 'sep', index: i };
    return { kind: 'pane', pane };
  }
  bind() {
    const el = this.root;
    this.pointers = new Map();
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e));
    // released outside the chart: the pointer must not stay registered (it would look like a second finger)
    this.offUp = (e) => { if (!el.contains(e.target)) this.pointers.delete(e.pointerId); };
    window.addEventListener('pointerup', this.offUp, true);
    window.addEventListener('pointercancel', this.offUp, true);
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.drag) this.setCross(null, e); });
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // long press with a finger: no browser menu (the crosshair uses it)
    el.addEventListener('contextmenu', (e) => { if (this.tracking || this.drag?.touch) e.preventDefault(); });
    el.addEventListener('dblclick', (e) => {
      const { x, y } = this.pos(e), r = this.region(x, y);
      const hs = this.o.handleScale.axisDoubleClickReset;
      const reset = typeof hs === 'object' ? hs : { time: !!hs, price: !!hs };
      if (r.kind === 'price' && reset.price) { const sc = r.pane.scales.get(r.side); if (sc) { sc.opts.autoScale = true; this.invalidate(); } }
      else if (r.kind === 'time' && reset.time) { this.ts.spacing = this.o.timeScale.barSpacing; this.api.timeScale().scrollToRealTime(); }
      else if (r.kind === 'pane') this.fire('dbl', e, x, y, r.pane);
    });
  }
  fire(kind, e, x, y, pane) {
    const set = kind === 'dbl' ? this.subs.dbl : this.subs.click;
    if (!set.size) return;
    const param = this.crossParam(x - this.lw, pane ? y - pane.y : null, pane, e);
    for (const f of set) try { f(param); } catch (er) { console.warn(er); }
  }
  crossParam(x, y, pane, e) {
    if (x == null) return { time: undefined, logical: undefined, point: undefined, paneIndex: undefined, seriesData: new Map(), hoveredSeries: undefined, hoveredObjectId: undefined, sourceEvent: undefined };
    const logical = this.ts.nearest(x);
    const time = logical >= 0 && logical < this.ti.n ? this.ti.t[logical] : undefined;
    const seriesData = new Map();
    for (const s of this.allSeries) { const it = s.api.dataByIndex(logical); if (it && (s.store.kind === KIND_OHLC ? it.close != null : it.value != null)) seriesData.set(s.api, it); }
    return {
      time, logical, point: y == null ? undefined : { x, y }, paneIndex: pane ? this.panes.indexOf(pane) : undefined, seriesData, hoveredSeries: undefined, hoveredObjectId: undefined,
      sourceEvent: e ? { clientX: e.clientX, clientY: e.clientY, pageX: e.pageX, pageY: e.pageY, screenX: e.screenX, screenY: e.screenY, localX: x, localY: y, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey } : undefined,
    };
  }
  /** Crosshair at (x, y) of the panes area (null = hidden) and notification of subscribers. */
  setCross(at, e) {
    if (!at) { if (this.crossAt) { this.crossAt = null; this.invalidateCross(); } this.emitCross(null, e); return; }
    let { x, y, pane } = at;
    const logical = this.ts.nearest(x);
    if (pane && this.o.crosshair.mode === 1) {
      // magnet: on the value of the pane's first series at that index
      const s = pane.series.find((q) => q.opts.visible && q.store.n);
      if (s) { const q = s.store.lowerPos(logical); if (q < s.store.n && s.store.pi[q] === logical) { const val = s.valueAt(q), sc = s.scale(); if (val === val && sc.ready) y = this.yOf(sc, val); } }
    }
    this.crossAt = { x, y, pane, logical, mouse: true };
    this.invalidateCross();
    this.emitCross(this.crossAt, e);
  }
  emitCross(a, e) {
    if (!this.subs.cross.size) return;
    const param = a ? this.crossParam(a.x, a.pane ? a.y : null, a.pane, e) : this.crossParam(null);
    for (const f of this.subs.cross) try { f(param); } catch (er) { console.warn(er); }
  }
  invalidateCross() { this.crossDirty = true; if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.dirty) { this.dirty = true; this.frame(); } else this.drawCross(); }); }

  onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.pos(e);
    this.kinetic = null;
    // only fingers count for the pinch: a pointer left behind (released outside the chart, mouse) is not a second finger
    if (e.pointerType !== 'touch') this.pointers.clear();
    this.pointers.set(e.pointerId, { ...p, touch: e.pointerType === 'touch' });
    if (this.pointers.size === 2 && [...this.pointers.values()].every((q) => q.touch) && this.o.handleScale.pinch !== false) { clearTimeout(this.longTap); this.startPinch(); return; }
    const r = this.region(p.x, p.y);
    this.drag = { kind: r.kind, side: r.side, pane: r.pane, index: r.index, x: p.x, y: p.y, lastX: p.x, lastY: p.y, moved: false, track: [{ x: p.x, t: performance.now() }], touch: e.pointerType !== 'mouse', id: e.pointerId, e };
    // touch: LW's tracking mode. Already active: the finger moves the crosshair from where it was (even starting elsewhere);
    // otherwise, 240 ms of a still finger turn it on with the crosshair under the finger
    if (this.drag.touch && r.kind === 'pane') {
      clearTimeout(this.longTap);
      if (this.tracking && this.crossAt) {
        this.drag.kind = 'track';
        this.drag.wasTracking = true;
        this.drag.init = { x: this.crossAt.x, y: this.crossAt.y ?? (p.y - r.pane.y), pane: this.crossAt.pane || r.pane };
      } else {
        this.longTap = setTimeout(() => {
          const d = this.drag;
          if (!d || d.id !== e.pointerId || d.moved || this.pinch) return;
          this.kinetic = null;
          this.tracking = true;
          d.kind = 'track';
          d.init = { x: d.x - this.lw, y: d.y - r.pane.y, pane: r.pane };
          this.setCross({ ...d.init }, d.e);
        }, 240);
      }
    }
    if (r.kind === 'price') { const sc = r.pane.scales.get(r.side); if (sc?.ready) { this.drag.lo = sc.ps.lo; this.drag.hi = sc.ps.hi; this.drag.sc = sc; this.drag.pane = r.pane; } }
    if (r.kind === 'time') this.drag.spacing = this.ts.spacing;
    if (r.kind === 'sep') this.drag.st = [this.panes[r.index - 1].stretch, this.panes[r.index].stretch, this.panes[r.index - 1].h, this.panes[r.index].h];
  }
  onMove(e) {
    const p = this.pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { ...p, touch: e.pointerType === 'touch' });
    if (this.pinch) { this.movePinch(); return; }
    const d = this.drag;
    if (!d) {
      const r = this.region(p.x, p.y);
      this.root.style.cursor = r.kind === 'price' || r.kind === 'sep' ? 'ns-resize' : r.kind === 'time' ? 'ew-resize' : '';
      if (r.kind === 'pane') this.setCross({ x: p.x - this.lw, y: p.y - r.pane.y, pane: r.pane }, e);
      else if (r.kind === 'time') this.setCross({ x: p.x - this.lw, y: null, pane: null }, e);
      else this.setCross(null, e);
      return;
    }
    const dx = p.x - d.lastX, dy = p.y - d.lastY;
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < (d.touch ? 5 : 3)) return;
    if (!d.moved) clearTimeout(this.longTap); // the finger moves before the long press: it is a scroll
    if (d.kind === 'track') {
      // the crosshair follows the finger's displacement from the starting point (as LW: initial position + displacement)
      d.moved = true;
      const pane = d.init.pane, x = Math.max(0, Math.min(this.areaW - 1, d.init.x + (p.x - d.x))), y = Math.max(0, Math.min(pane.h - 1, d.init.y + (p.y - d.y)));
      this.setCross({ x, y, pane }, e);
      return;
    }
    if (!d.moved) { d.moved = true; if (d.id != null) try { this.root.setPointerCapture(d.id); } catch { /* */ } }
    d.lastX = p.x; d.lastY = p.y;
    const hs = this.o.handleScroll, hsc = this.o.handleScale;
    if (d.kind === 'pane') {
      const can = d.touch ? hs.horzTouchDrag !== false : hs.pressedMouseMove !== false;
      if (!can) return;
      this.ts.pan(dx);
      for (const sc of d.pane.scales.values()) if (sc.ready && sc.opts.autoScale === false && (d.touch ? hs.vertTouchDrag !== false : true) && dy) { const k = (sc.ps.hi - sc.ps.lo) / sc.ps.height, m = dy * k * (sc.opts.invertScale ? -1 : 1); sc.ps.hi += m; sc.ps.lo += m; }
      const now = performance.now();
      d.track.push({ x: p.x, t: now });
      while (d.track.length > 2 && now - d.track[0].t > 100) d.track.shift();
      if (!d.touch) this.setCross({ x: p.x - this.lw, y: p.y - d.pane.y, pane: d.pane }, e);
    } else if (d.kind === 'price' && d.sc) {
      const ok = typeof hsc.axisPressedMouseMove === 'object' ? hsc.axisPressedMouseMove.price !== false : hsc.axisPressedMouseMove !== false;
      if (!ok) return;
      // as Lightweight Charts: the coefficient is a ratio of distances from the bottom of the pane (with a 20% height margin), not
      // an exponential of the dragged pixels (which with a 600 px height was ~2.8 times more sensitive)
      const h = d.pane.h, k = 0.2 * (h - 1), y0 = d.y - d.pane.y, y1 = p.y - d.pane.y;
      const coeff = Math.max(0.1, (h - y0 + k) / (Math.max(0, h - y1) + k));
      const sc = d.sc, mid = (d.hi + d.lo) / 2, span = (d.hi - d.lo) * coeff;
      sc.ps.hi = mid + span / 2; sc.ps.lo = mid - span / 2; sc.opts.autoScale = false;
    } else if (d.kind === 'time') {
      const ok = typeof hsc.axisPressedMouseMove === 'object' ? hsc.axisPressedMouseMove.time !== false : hsc.axisPressedMouseMove !== false;
      if (!ok) return;
      {
        // as Lightweight Charts: initial spacing × (current distance from the right edge / initial one)
        const W = this.areaW, now = Math.min(W, Math.max(0, W - (p.x - this.lw))), start = Math.min(W, Math.max(0, W - (d.x - this.lw)));
        if (now > 0 && start > 0) this.ts.zoom((d.spacing * now / start) / this.ts.spacing, W);
      }
    } else if (d.kind === 'sep') {
      const [s0, s1, h0, h1] = d.st, moved = Math.max(-h0 + 30, Math.min(h1 - 30, p.y - d.y)), tot = s0 + s1;
      this.panes[d.index - 1].stretch = (tot * (h0 + moved)) / (h0 + h1);
      this.panes[d.index].stretch = (tot * (h1 - moved)) / (h0 + h1);
      this.layoutPanes();
    }
    this.invalidate();
  }
  onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
    const d = this.drag;
    this.drag = null;
    clearTimeout(this.longTap);
    if (!d) return;
    if (d.kind === 'track') {
      // exit: at the next tap without movement (LW default, OnNextTap) or immediately on lifting the finger (OnTouchEnd)
      const onEnd = this.o.trackingMode?.exitMode === 0;
      if (onEnd || (d.wasTracking && !d.moved)) { this.tracking = false; this.setCross(null, e); }
      return;
    }
    if (!d.moved) {
      if (d.kind === 'pane') this.fire('click', e, d.x, d.y, d.pane);
      if (d.touch && this.tracking) { this.tracking = false; this.setCross(null, e); }
      return;
    }
    const ks = this.o.kineticScroll;
    if (d.kind === 'pane' && d.track.length >= 2 && (d.touch ? ks.touch : ks.mouse)) {
      const a = d.track[0], b = d.track[d.track.length - 1], dt = b.t - a.t, vel = dt > 0 ? (b.x - a.x) / dt : 0;
      if (Math.abs(vel) > 0.3 && performance.now() - b.t < 60) { this.kinetic = { v: vel, t: performance.now() }; this.invalidate(); }
    }
    if (d.touch && !this.tracking) this.setCross(null, e);
  }
  stepKinetic() {
    const k = this.kinetic, now = performance.now(), dt = Math.min(50, now - k.t);
    k.t = now;
    this.ts.pan(k.v * dt);
    k.v *= Math.exp(-dt / 325);
    if (Math.abs(k.v) < 0.02) this.kinetic = null;
  }
  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.drag = null;
    this.pinch = { d: Math.max(20, Math.abs(a.x - b.x)), mid: (a.x + b.x) / 2 - this.lw, spacing: this.ts.spacing, right: this.ts.right };
    this.setCross(null);
  }
  movePinch() {
    const [a, b] = [...this.pointers.values()], P = this.pinch, ts = this.ts;
    const d = Math.max(20, Math.abs(a.x - b.x)), mid = (a.x + b.x) / 2 - this.lw;
    const idx = P.right - (ts.width - P.mid) / P.spacing;
    ts.spacing = Math.min(ts.maxSpacing, Math.max(ts.minFor(), (P.spacing * d) / P.d));
    ts.right = idx + (ts.width - mid) / ts.spacing;
    ts.clamp();
    this.invalidate();
  }
  onWheel(e) {
    const hs = this.o.handleScroll, hsc = this.o.handleScale;
    if (!hs.mouseWheel && !hsc.mouseWheel) return;
    e.preventDefault();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    const { x } = this.pos(e);
    this.kinetic = null;
    if (Math.abs(dx) > Math.abs(dy) && hs.mouseWheel) this.ts.pan(-dx);
    else if (hsc.mouseWheel) this.ts.zoom(Math.exp(-dy * 0.0025), Math.min(Math.max(0, x - this.lw), this.areaW));
    this.invalidate();
  }

  takeScreenshot(addTop = false, cross = false) {
    this.dirty = true;
    this.frame();
    const dpr = this.dpr, out = document.createElement('canvas');
    out.width = Math.round(this.W * dpr); out.height = Math.round(this.H * dpr);
    const c = out.getContext('2d');
    const bg = this.o.layout.background || {};
    if (bg.type === 'gradient') { const g = c.createLinearGradient(0, 0, 0, out.height); g.addColorStop(0, bg.topColor); g.addColorStop(1, bg.bottomColor); c.fillStyle = g; } else c.fillStyle = bg.color || '#fff';
    c.fillRect(0, 0, out.width, out.height);
    const put = (cv, x, y) => { if (cv.style.display !== 'none') c.drawImage(cv, Math.round(x * dpr), Math.round(y * dpr)); };
    for (const p of this.panes) put(p.layers.bottom.c, this.lw, p.y);
    put(this.glc, this.lw, 0);
    for (const p of this.panes) put(p.layers.top.c, this.lw, p.y);
    if (this.rw) put(this.axes.right.c, this.lw + this.areaW, 0);
    if (this.lw) put(this.axes.left.c, 0, 0);
    if (this.timeH) put(this.axes.time.c, 0, this.areaH);
    if (cross) put(this.cross.c, 0, 0);
    return out;
  }

  remove() {
    this.removed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.longTap);
    window.removeEventListener('pointerup', this.offUp, true);
    window.removeEventListener('pointercancel', this.offUp, true);
    this.ro.disconnect();
    for (const p of [...this.prims.keys()]) this.detachPrim(p);
    try { this.R.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* */ }
    this.root.remove();
  }
}
const HORZ = { key: (t) => t, cacheKey: (t) => t, convertHorzItemToInternal: (t) => timeOf(t), formatHorzItem: (t) => String(t) };

/**
 * 2D canvas methods spied on to know whether a drawing coloured anything (if not, the canvas stays empty and is not cleared).
 */
function spyOn(c, hit) {
  const names = ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'putImageData'];
  for (const n of names) { const f = CanvasRenderingContext2D.prototype[n]; c[n] = function (...a) { hit(); return f.apply(this, a); }; }
  return () => { for (const n of names) delete c[n]; };
}
const hexOf = (u) => `rgba(${u & 255},${(u >>> 8) & 255},${(u >>> 16) & 255},${((u >>> 24) / 255).toFixed(3)})`;
const contrast = (u) => { const r = u & 255, g = (u >>> 8) & 255, b = (u >>> 16) & 255; return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#FFFFFF'; };
// ---------------------------------------------------------------------------------------------------------------------
class PriceScaleApi {
  constructor(chart, pane, sc) { this._c = chart; this._p = pane; this._s = sc; }
  applyOptions(o) {
    merge(this._s.opts, o);
    this._s.tk = null;
    if ((this._s.id === 'right' || this._s.id === 'left') && this._p === this._c.panes[0]) {
      // the options of the scales of pane 0 apply to all panes, as in LW; those of another pane only to itself (otherwise the host
      // resetting inversion and mode in indicator panes would also bring the price scale back to normal and invert (Alt+I) would be lost
      merge(this._c.o[this._s.id === 'right' ? 'rightPriceScale' : 'leftPriceScale'], o);
      for (const p of this._c.panes) { const s = p.scales.get(this._s.id); if (s && s !== this._s) merge(s.opts, o); }
      if ('visible' in o || 'minimumWidth' in o) this._c.layout();
    }
    this._c.invalidate();
  }
  options() { return this._s.opts; }
  width() { return this._s.id === 'right' ? this._c.rw : this._s.id === 'left' ? this._c.lw : 0; }
  setVisibleRange(r) { const ps = this._s.ps; ps.lo = ps.f(r.from); ps.hi = ps.f(r.to); this._s.opts.autoScale = false; this._s.ready = true; this._c.invalidate(); }
  getVisibleRange() { const ps = this._s.ps; return this._s.ready ? { from: ps.inv(ps.lo), to: ps.inv(ps.hi) } : null; }
  setAutoScale(on) { this._s.opts.autoScale = !!on; this._c.invalidate(); }
}

class TimeScaleApi {
  constructor(c) { this._c = c; }
  get _ts() { return this._c.ts; }
  scrollPosition() { const c = this._c; return c.ts.right - c.base - 0.5; }
  scrollToPosition(pos) { const c = this._c; c.ts.right = c.base + pos + 0.5; c.ts.clamp(); c.invalidate(); }
  scrollToRealTime() { this.scrollToPosition(this._c.o.timeScale.rightOffset); }
  getVisibleLogicalRange() { const c = this._c; if (!c.ti.n && c.base < 0) return null; const v = c.visibleIdx(); return { from: v.from, to: v.to }; }
  setVisibleLogicalRange(r) {
    const c = this._c, ts = c.ts;
    if (!r || !(r.to >= r.from)) return;
    ts.spacing = Math.min(ts.maxSpacing, Math.max(c.o.timeScale.minBarSpacing || 0.01, ts.width / (r.to - r.from + 1)));
    // as LW's setVisibleLogicalRange (observed): rightOffset = to − base index (with the spacing limited the rest goes to the left)
    ts.right = r.to + 0.5;
    c.pendRange = { from: r.from, to: r.to };
    c.invalidate();
  }
  getVisibleRange() {
    const c = this._c, v = c.visibleIdx(), n = c.ti.n;
    if (!n) return null;
    const a = Math.max(0, Math.min(n - 1, v.first)), b = Math.max(0, Math.min(n - 1, v.last));
    return { from: c.ti.t[a], to: c.ti.t[b] };
  }
  setVisibleRange(r) {
    const c = this._c, a = c.ti.lower(timeOf(r.from)), b = Math.max(a, c.ti.lower(timeOf(r.to) + 1e-9) - 1);
    this.setVisibleLogicalRange({ from: a, to: b });
  }
  fitContent() { const c = this._c; if (c.base >= 0) this.setVisibleLogicalRange({ from: 0, to: c.base + (c.o.timeScale.rightOffset || 0) }); }
  logicalToCoordinate(l) { return l == null ? null : this._c.ts.x(l); }
  coordinateToLogical(x) { return this._c.ti.n || this._c.base >= 0 ? this._c.ts.nearest(x) : null; }
  timeToCoordinate(t) { const i = this._c.ti.indexOf(timeOf(t)); return i < 0 ? null : this._c.ts.x(i); }
  coordinateToTime(x) { const c = this._c, i = c.ts.nearest(x); return i >= 0 && i < c.ti.n ? c.ti.t[i] : null; }
  timeToIndex(t, findNearest) { const c = this._c, tt = timeOf(t), i = c.ti.indexOf(tt); if (i >= 0) return i; return findNearest ? Math.min(c.ti.n - 1, c.ti.lower(tt)) : null; }
  width() { return this._c.areaW; }
  height() { return this._c.timeH; }
  subscribeVisibleLogicalRangeChange(f) { this._c.subs.range.add(f); }
  unsubscribeVisibleLogicalRangeChange(f) { this._c.subs.range.delete(f); }
  subscribeVisibleTimeRangeChange(f) { this._c.subs.trange.add(f); }
  unsubscribeVisibleTimeRangeChange(f) { this._c.subs.trange.delete(f); }
  subscribeSizeChange(f) { this._c.subs.size.add(f); }
  unsubscribeSizeChange(f) { this._c.subs.size.delete(f); }
  applyOptions(o) {
    const c = this._c;
    merge(c.o.timeScale, o);
    if ('barSpacing' in o) { const r = c.ts.right; c.ts.spacing = o.barSpacing; c.ts.right = r; }
    if ('rightOffset' in o) c.ts.right = c.base + o.rightOffset + 0.5;
    if ('minBarSpacing' in o) c.ts.minSpacing = o.minBarSpacing || 0.01;
    if ('maxBarSpacing' in o) c.ts.maxSpacing = o.maxBarSpacing || 1e4;
    if ('visible' in o || 'minimumHeight' in o) c.layout();
    c.ts.clamp();
    c.invalidate();
  }
  options() { const c = this._c; return { ...c.o.timeScale, barSpacing: c.ts.spacing, rightOffset: c.ts.right - c.base - 0.5 }; }
}

class ChartApi {
  constructor(c) { this._c = c; this._ts = new TimeScaleApi(c); }
  addSeries(def, opts, paneIndex) { return this._c.addSeries(def, opts, paneIndex).api; }
  removeSeries(api) { if (api?._s) this._c.removeSeries(api._s); }
  addCustomSeries() { throw new Error('Serie personalizzate non supportate dal motore aq'); }
  timeScale() { return this._ts; }
  priceScale(id, paneIndex = 0) { const p = this._c.panes[paneIndex] || this._c.panes[0]; return this._c.scaleApi(p, id); }
  panes() { return this._c.panes.map((p) => p.api); }
  addPane(keep) { const p = this._c.addPane(); p.keep = !!keep; this._c.invalidate(); return p.api; }
  removePane(i) { this._c.removePane(i); }
  swapPanes(a, b) { const P = this._c.panes; [P[a], P[b]] = [P[b], P[a]]; this._c.rebuildRows(); this._c.layoutPanes(); this._c.invalidate(); }
  paneSize(i = 0) { const p = this._c.panes[i]; return p ? { width: this._c.areaW, height: p.h } : { width: 0, height: 0 }; }
  subscribeCrosshairMove(f) { this._c.subs.cross.add(f); }
  unsubscribeCrosshairMove(f) { this._c.subs.cross.delete(f); }
  subscribeClick(f) { this._c.subs.click.add(f); }
  unsubscribeClick(f) { this._c.subs.click.delete(f); }
  subscribeDblClick(f) { this._c.subs.dbl.add(f); }
  unsubscribeDblClick(f) { this._c.subs.dbl.delete(f); }
  setCrosshairPosition(price, time, series) {
    const c = this._c, s = series?._s, i = c.ti.indexOf(timeOf(time));
    if (i < 0) return;
    const pane = s ? s.pane : c.panes[0], sc = s ? s.scale() : null;
    c.crossAt = { x: c.ts.x(i), y: sc?.ready ? c.yOf(sc, price) : null, pane, logical: i };
    c.invalidateCross();
  }
  clearCrosshairPosition() { this._c.crossAt = null; this._c.invalidateCross(); }
  applyOptions(o) {
    const c = this._c;
    merge(c.o, o);
    for (const p of c.panes) for (const sc of p.scales.values()) sc.tk = null; // formats or fonts changed
    if (o.layout) c.applyLayoutStyle();
    if (o.timeScale) this._ts.applyOptions(o.timeScale);
    if (o.rightPriceScale) for (const p of c.panes) { const s = p.scales.get('right'); if (s) merge(s.opts, o.rightPriceScale); }
    if (o.leftPriceScale) for (const p of c.panes) { const s = p.scales.get('left'); if (s) merge(s.opts, o.leftPriceScale); }
    if ('width' in o || 'height' in o) { if (!c.o.autoSize) c.resize(c.o.width || undefined, c.o.height || undefined); }
    if ('autoSize' in o && o.autoSize) { c.root.style.width = '100%'; c.root.style.height = '100%'; c.resize(); }
    c.layout();
    c.invalidate();
  }
  options() { return this._c.o; }
  resize(w, h) { this._c.o.width = w; this._c.o.height = h; this._c.resize(w, h); this._c.dirty = true; this._c.frame(); }
  remove() { this._c.remove(); }
  takeScreenshot(top, cross) { return this._c.takeScreenshot(top, cross); }
  chartElement() { return this._c.root; }
  autoSizeActive() { return !!this._c.o.autoSize; }
  horzBehaviour() { return HORZ; }
  /** aq engine (tests and measurements). */
  get __aq() { return this._c; }
}

// ---------------------------------------------------------------------------------------------------------------------
/** Series markers (LW v5 plugin). */
export function createSeriesMarkers(seriesApi, markers = [], opts = {}) {
  const s = seriesApi._s;
  const st = { list: (markers || []).slice().sort((a, b) => timeOf(a.time) - timeOf(b.time)), opts };
  s.markers = st;
  s.chart.invalidate();
  return {
    setMarkers(m) { st.list = (m || []).slice().sort((a, b) => timeOf(a.time) - timeOf(b.time)); s.chart.invalidate(); },
    markers() { return st.list; },
    detach() { if (s.markers === st) s.markers = null; s.chart.invalidate(); },
    getSeries() { return seriesApi; },
    applyOptions(o) { Object.assign(st.opts, o); s.chart.invalidate(); },
  };
}
export const version = () => 'aq-1';
export function isBusinessDay(t) { return !!t && typeof t === 'object' && 'year' in t; }
export function isUTCTimestamp(t) { return typeof t === 'number'; }
