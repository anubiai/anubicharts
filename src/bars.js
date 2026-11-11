/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * Device-pixel geometry of candles, OHLC bars and histograms (pure functions, no access to the canvas or the GPU).
 * Written from a specification obtained by MEASURING the pixels that Lightweight Charts produces in Chrome (tables in
 * test/fixtures/lw-measures-*.json; the measurement bench is not published). Provenance stated honestly: the person who wrote the
 * code already knew, in general terms, the algorithms of that library and the previous code of this engine; this is not a clean
 * room in the strict legal sense, but a rewrite guided by measurements with a proof of equivalence (see DERIVAZIONE.md).
 */

/**
 * Width of a candle body, in CSS pixels: s(sp) = sp · share, with share 1 for close bars (spacing ≤ 4) and then decreasing towards
 * 0.8. It is NOT a formula: it is a table of measured thresholds (test/fixtures/lw-measures-bodyshare.json: for each spacing at
 * which the width in device pixels moves to the next value, at DPR 1, 2, 3, 4 and a few more, bisection to 1e-4) and its deviation
 * d(sp) = s − 0.8·sp, interpolated with a local monotone cubic (non-uniform Catmull-Rom). A rational function fitted to those
 * points was wrong by up to 0.009 px of spacing, and at every threshold there was a window in which aq and LW gave different
 * widths (423 cases out of 63,600).
 */
const SHARE_TAB = [[4,0.8],[4.30528,0.69863],[4.42801,0.65759],[4.69769,0.57518],[4.87451,0.52896],[4.99999,0.50001],[5.16746,0.46603],[5.34997,0.43431],[5.77901,0.37679],[6.47969,0.31625],[6.7055,0.30227],[7.15018,0.27986],[7.58844,0.26258],[7.80581,0.25535],[8.45279,0.23777],[9.09443,0.22446],[9.30749,0.22067],[9.73248,0.21402],[10.1564,0.20821],[10.36797,0.20562],[11.00161,0.19871],[11.63382,0.19294],[11.84433,0.1912],[12.26494,0.18805],[12.68521,0.18516],[12.89521,0.18383],[13.52481,0.18015],[14.15386,0.17691],[14.36345,0.17591],[14.78242,0.17406],[15.20127,0.17232],[15.41063,0.1715],[16.03842,0.16926],[16.66604,0.16717],[16.87517,0.16653],[17.29334,0.16533],[17.71147,0.16416],[17.92048,0.16362],[18.54742,0.16206],[19.17419,0.16065],[19.38307,0.16021],[19.80082,0.15934],[20.21851,0.15853],[20.42731,0.15815],[21.05375,0.157],[21.68007,0.15594],[21.88879,0.15564],[22.30625,0.155],[22.72367,0.1544],[22.9324,0.15408],[23.55847,0.15322],[24.18447,0.15242],[24.39314,0.15216],[24.81041,0.15167],[25.22765,0.15121],[25.43629,0.15097],[26.06211,0.15031],[26.68789,0.14969],[26.89649,0.14947],[27.31368,0.14906],[27.73079,0.1487],[27.93937,0.1485],[28.56503,0.14798],[29.19064,0.14749],[29.39919,0.14731],[29.81629,0.14697],[30.23331,0.14668],[30.44184,0.14653],[31.06743,0.14606],[31.69293,0.14566],[31.90144,0.14551],[32.31846,0.14523],[32.73541,0.145],[32.94391,0.14487],[33.5694,0.14448],[34.19481,0.14415],[34.4033,0.14403],[34.82026,0.14379],[35.23722,0.14356],[35.44564,0.14349],[36.07105,0.14316],[36.69645,0.14284]];
const SHARE_M = SHARE_TAB.map((p, i, a) => { const l = a[Math.max(0, i - 1)], r = a[Math.min(a.length - 1, i + 1)]; return (r[1] - l[1]) / (r[0] - l[0]); });
function bodyExtent(sp) {
  const n = SHARE_TAB.length;
  if (sp >= SHARE_TAB[n - 1][0]) { const [x, y] = SHARE_TAB[n - 1]; return 0.8 * sp + y + Math.min(0, SHARE_M[n - 1]) * (sp - x); } // beyond the last measurement: slope of the deviation, never rising
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (SHARE_TAB[m][0] <= sp) lo = m; else hi = m; }
  const [x0, y0] = SHARE_TAB[lo], [x1, y1] = SHARE_TAB[lo + 1], h = x1 - x0, t = (sp - x0) / h, t2 = t * t, t3 = t2 * t;
  const d = (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * SHARE_M[lo] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * SHARE_M[lo + 1];
  return 0.8 * sp + d;
}
export function bodyShare(spacing) {
  if (spacing <= 4) return 1;
  return bodyExtent(spacing) / spacing;
}

/**
 * Width (device pixels) of a candle's outline, borders included, for a spacing in CSS pixels and a horizontal pixel ratio `hpr`.
 * It always has the same parity as the wick (so the wick falls at the centre of the body).
 */
export function candleWidth(spacing, hpr) {
  const unit = Math.max(1, Math.floor(hpr)), full = Math.floor(spacing * hpr);
  const fixed = spacing >= 2.5 && spacing <= 4; // intermediate zone: three fixed CSS pixels, even beyond the spacing (candles overlap: measured)
  let w = fixed ? Math.floor(3 * hpr) : Math.floor(spacing * hpr * bodyShare(spacing));
  w = Math.max(unit, fixed ? w : Math.min(w, full));
  if (w >= 2 && w % 2 !== unit % 2) w--;
  return w;
}

/** Wick and border widths for a body `body` pixels wide. */
export function candleParts(body, hpr, spacing) {
  const unit = Math.max(1, Math.floor(hpr));
  const wick = Math.max(unit, Math.min(Math.min(unit, Math.floor(spacing * hpr)), body));
  let border = unit;
  if (body <= 2 * border) border = Math.max(unit, Math.floor((body - 1) / 2));
  return { wick, border, hollow: body <= 2 * border };
}

/**
 * Rectangles of a series of candles. `bars`: { n, x[] (centre in device pixels, integer), o[], h[], l[], c[] (y in device pixels,
 * with decimals), body[], border[], wick[] (packed colours) }. Returns the rectangles [x0, y0, x1, y1, colour] in `out`
 * (Float32Array in groups of 5, with `outU` a Uint32 view of the same buffer) starting at `at`; returns how many. Three passes:
 * wicks, borders, bodies (order matters with transparent colours). Wicks and borders do not enter the previous candle.
 */
export function candleRects(bars, geom, flags, out, outU, y0) {
  const { n, x, o, h, l, c } = bars;
  const { width, wick, border, hollow } = geom;
  const half = Math.floor(width / 2), wickHalf = Math.floor(wick / 2);
  let k = 0;
  const put = (xa, ya, w, hh, col) => {
    if (w <= 0 || hh <= 0) return;
    const q = k * 5;
    out[q] = xa; out[q + 1] = y0 + ya; out[q + 2] = xa + w; out[q + 3] = y0 + ya + hh; outU[q + 4] = col; k++;
  };
  const top = (j) => Math.round(Math.min(o[j], c[j])), bot = (j) => Math.round(Math.max(o[j], c[j]));
  if (flags.wick) {
    let edge = -Infinity; // last column occupied by the previous candle
    for (let j = 0; j < n; j++) {
      let a = x[j] - wickHalf; const b = a + wick - 1;
      if (a <= edge) a = edge + 1;
      const t = top(j), bt = bot(j), hi = Math.round(h[j]), lo = Math.round(l[j]);
      if (b >= a) { put(a, hi, b - a + 1, t - hi, bars.wick[j]); put(a, bt + 1, b - a + 1, lo - bt, bars.wick[j]); }
      edge = x[j] - half + width - 1;
    }
  }
  if (flags.border) {
    let edge = -Infinity;
    for (let j = 0; j < n; j++) {
      let a = x[j] - half; const b = a + width - 1;
      if (a <= edge) a = edge + 1;
      const t = top(j), bt = bot(j), col = bars.border[j];
      if (hollow) put(a, t, b - a + 1, bt - t + 1, col);
      else {
        put(a, t, border, bt - t + 1, col);
        put(b - border + 1, t, border, bt - t + 1, col);
        put(a + border, t, b - a + 1 - 2 * border, border, col);
        put(a + border, bt - border + 1, b - a + 1 - 2 * border, border, col);
      }
      edge = b;
    }
  }
  if (!flags.border || !hollow) {
    const bd = flags.border ? border : 0;
    for (let j = 0; j < n; j++) {
      const a = x[j] - half + bd, b = x[j] - half + width - 1 - bd, t = top(j) + bd, bt = bot(j) - bd;
      if (bt >= t) put(a, t, b - a + 1, bt - t + 1, bars.body[j]);
    }
  }
  return k;
}

/**
 * OHLC bars: total width (stem + ticks, device pixels), measured on LW at DPR 1, 1.5, 2, 2.5, 3, 4. With `u = max(1, floor(hpr))`
 * odd (odd stem) it is 6n - 1, with u even 6n + 1, where n grows by one every 20/3 device pixels of spacing (n = floor(0.15 · sp ·
 * hpr + 0.5) for odd u, floor(0.15 · sp · hpr) for even u), at least 1.
 */
export function barWidth(spacing, hpr) {
  const unit = Math.max(1, Math.floor(hpr)), dev = spacing * hpr;
  if (unit % 2) return 6 * Math.max(1, Math.floor((3 * dev) / 20 + 0.5)) - 1;
  return 6 * Math.max(1, Math.floor((3 * dev) / 20)) + 1;
}

/**
 * Stem and ticks of an OHLC bar: the stem is `u` wide (thin bars) or a third of the total width (rounded down, with the same
 * parity as `u` by construction); the ticks share the rest, the left one takes the pixel less.
 */
export function barParts(spacing, hpr, thin) {
  const unit = Math.max(1, Math.floor(hpr)), width = barWidth(spacing, hpr);
  const stem = thin ? unit : Math.max(unit, Math.floor(width / 3));
  // with spacing below floor(1.5 · hpr) CSS pixels (1 at DPR 1, 3 at DPR 2, 6 at DPR 4: measured) only the stems remain
  if (spacing < Math.floor(1.5 * hpr)) return { stem, left: 0, right: 0 };
  const rest = Math.max(0, width - stem), left = Math.floor(rest / 2);
  return { stem, left, right: rest - left };
}

/**
 * Rectangles of a series of OHLC bars. `bars`: as for candleRects (integer centre x, o[], h[], l[], c[] in device pixels with
 * decimals, body[] = colour). `geom`: { stem, left, right } (widths in pixels). Per bar: stem from round(high) to round(low),
 * extended by floor(stem/2) at each end; left tick at the open and right tick at the close, as tall as the stem and centred on
 * round(value), but pushed inside the stem. The stem starts at x - floor(stem/2). Returns how many rectangles.
 */
export function barRects(bars, geom, out, outU, y0) {
  const { n, x, o, h, l, c } = bars, { stem, left, right } = geom, half = Math.floor(stem / 2);
  let k = 0;
  const put = (xa, ya, xb, yb, col) => { const q = k * 5; out[q] = xa; out[q + 1] = y0 + ya; out[q + 2] = xb; out[q + 3] = y0 + yb; outU[q + 4] = col; k++; };
  for (let j = 0; j < n; j++) {
    const a = x[j] - half, col = bars.body[j], top = Math.round(h[j]) - half, bot = Math.max(Math.round(l[j]) + half, top + 1);
    // the ticks stay inside the stem (measured: with the close on the low the tick moves up one row)
    const tick = (v) => Math.max(top, Math.min(Math.round(v) - half, bot - stem));
    put(a, top, a + stem, bot, col);
    if (left > 0) { const yo = tick(o[j]); put(a - left, yo, a, yo + stem, col); }
    if (right > 0) { const yc = tick(c[j]); put(a + stem, yc, a + stem + right, yc + stem, col); }
  }
  return k;
}

/** Gap in device pixels between two histogram columns (none with bars narrower than one pixel). */
export const histGap = (pitch, hpr) => (Math.ceil(pitch) <= 1 ? 0 : Math.max(1, Math.floor(hpr)));

/**
 * Columns of a histogram. cx[]: centres in device pixels (with decimals); adj[]: consecutiveness (two bars are adjacent if their
 * values differ by 1); pitch: spacing in device pixels; gapPx: gap between two columns. Writes left[] and right[]. Measured
 * specification: column round(pitch) - gap wide, centred on the rounded centre; between two adjacent bars the gap becomes exactly
 * gapPx: too large, the next column is widened to the left; too small, the previous one is shortened.
 */
export function histColumns(n, cx, adj, pitch, gapPx, left, right) {
  const w0 = Math.round(pitch) - gapPx, half = Math.floor(w0 / 2);
  for (let j = 0; j < n; j++) { const r = Math.round(cx[j]); left[j] = r - half; right[j] = left[j] + w0 - 1; }
  for (let j = 1; j < n; j++) {
    if (adj[j] !== adj[j - 1] + 1) continue;
    const gap = left[j] - right[j - 1] - 1;
    if (gap > gapPx) left[j] -= gap - gapPx;
    else if (gap < gapPx) right[j - 1] -= gapPx - gap;
  }
  let narrow = Infinity;
  for (let j = 0; j < n; j++) { if (right[j] < left[j]) right[j] = left[j]; narrow = Math.min(narrow, right[j] - left[j] + 1); }
  // narrow columns (less than 4 pixels): all like the narrowest; the extra pixel is taken from the side towards which the rounding
  // of the centre moved the column
  if (gapPx > 0 && narrow < 4) {
    for (let j = 0; j < n; j++) {
      const extra = right[j] - left[j] + 1 - narrow;
      if (extra <= 0) continue;
      if (Math.round(cx[j]) > cx[j]) right[j] -= extra; else left[j] += extra;
    }
  }
}

/**
 * Point markers (pointMarkersVisible): CSS radius = pointMarkersRadius or lineWidth/2 + 2. Measured on LW (36 combinations, DPR
 * 1-4): the centroid is at the exact y and at round(x·dpr) + 0.5 when floor(dpr) is odd (0 if even); the covered area matches a
 * circle of radius cssRadius·dpr, plus 0.4 px in the odd case (within 9%: with the smallest radii, 2.5 px, the soft edge matters
 * more).
 */
export function pointMarker(dpr, lineWidth, radiusCss) {
  const corr = (Math.max(1, Math.floor(dpr)) % 2) / 2, r = radiusCss || lineWidth / 2 + 2;
  return { radius: r * dpr + (corr ? 0.4 : 0), xCorr: corr };
}
