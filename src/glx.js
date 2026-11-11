/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * WebGL drawings of the series types of the Lightweight Charts-compatible layer (lw.js): lines with one colour per point and
 * dashes, areas and baselines (fill down to the bottom or to the base value), histograms with one colour per bar, candles with
 * body, border and wick coloured bar by bar (Pine's barcolor), OHLC bars. All in index and relative-price coordinates (see gl.js);
 * colours are already resolved on the CPU (point or series colour) and packed into 4 bytes.
 * Packet formats (Float32Array with a Uint32 view for colours):
 * - points (lines, areas, baselines, histograms): 3 words per point [index, value, colour], with one NA slot at the head and two
 *    at the end (each segment reads the point before and the two after for the joins);
 * - candles: 8 words [index, open, high, low, close, body, border, wick];
 * - OHLC bars: 6 words [index, open, high, low, close, colour].
 */
import { GlRenderer, VIEW, compile, rgba } from './gl.js';

const LINE_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_pm;
layout(location=2) in vec2 a_p0;
layout(location=3) in vec2 a_p1;
layout(location=4) in vec2 a_p2;
layout(location=5) in vec4 a_col;
layout(location=6) in float a_ph; // dashing: length of the line from its first point to the start of the segment (pixels)
${VIEW}
uniform float u_lw;
out float v_d; out float v_s; flat out vec4 v_col;
bool na(float v) { return abs(v) > 1e38; }
vec2 P(vec2 a) { return vec2(px(a.x), py(a.y)); }
void main() {
  vec2 q0 = P(a_p0), q1 = P(a_p1), d = q1 - q0;
  float len = length(d);
  v_d = 0.0; v_s = 0.0; v_col = vec4(0.0);
  if (na(a_p0.y) || na(a_p1.y) || len < 1e-3 || a_col.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 t = d / len, n = vec2(-t.y, t.x);
  bool atEnd = a_c.x > 0.5;
  vec2 q = atEnd ? q1 : q0, nb = atEnd ? a_p2 : a_pm;
  float e = u_lw * 0.5 + 1.0, c = 1.0;
  vec2 m = n;
  bool sharp = false; // join sharper than ~60°: the mitre shortens the tip, so it is covered by extending the segment by half the thickness (like LW's round join)
  if (!na(nb.y)) {
    vec2 qo = P(nb), d2 = atEnd ? qo - q1 : q0 - qo;
    float l2 = length(d2);
    if (l2 > 1e-3) {
      vec2 s = t + d2 / l2;
      float ls = length(s);
      if (ls > 1e-3) { vec2 tm = s / ls; m = vec2(-tm.y, tm.x); c = dot(m, n); if (c < 0.5) { sharp = true; m = n; c = 1.0; } }
      else { sharp = true; }
    }
  }
  vec2 p = q + m * (a_c.y * e / c);
  if (sharp) p += t * ((atEnd ? 1.0 : -1.0) * (u_lw * 0.5));
  v_d = a_c.y * e; v_s = a_ph + dot(p - q0, t);
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  gl_Position = clip(p);
}`;
const LINE_FS = `#version 300 es
precision highp float;
in float v_d; in float v_s; flat in vec4 v_col;
uniform float u_lw;
// pixel on, pixel off (0 = solid), along the line from its first drawn point like setLineDash of LW's canvas: when scrolling the
// chart the dashes move with the line (before, the phase was the screen x and the dashes "walked" along the line)
uniform vec2 u_dash;
out vec4 o;
void main() {
  float cov = clamp(u_lw * 0.5 + 0.5 - abs(v_d), 0.0, 1.0);
  if (u_dash.x > 0.0) {
    float per = u_dash.x + u_dash.y, m = mod(v_s, per);
    // coverage of pixel [m - 0.5, m + 0.5] by the dash [0, on] and by the start of the next one
    cov *= clamp(min(m + 0.5, u_dash.x) - max(m - 0.5, 0.0), 0.0, 1.0) + clamp(m + 0.5 - per, 0.0, 1.0);
  }
  if (cov <= 0.0) discard;
  o = v_col * cov;
}`;

// area and baseline: vertical trapezoid between the line and the bottom (area) or the base value (baseline)
const FILL_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_p0;
layout(location=2) in vec2 a_p1;
${VIEW}
uniform float u_baseY;
out vec2 v_p; flat out vec4 v_seg;
bool na(float v) { return abs(v) > 1e38; }
void main() {
  vec2 q0 = vec2(px(a_p0.x), py(a_p0.y)), q1 = vec2(px(a_p1.x), py(a_p1.y));
  v_seg = vec4(q0, q1); v_p = vec2(0.0);
  if (na(a_p0.y) || na(a_p1.y) || q1.x - q0.x < 1e-4) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float top = min(min(q0.y, q1.y), u_baseY) - 1.0, bot = max(max(q0.y, q1.y), u_baseY) + 1.0;
  vec2 p = vec2(mix(q0.x, q1.x, a_c.x), mix(top, bot, a_c.y));
  v_p = p;
  gl_Position = clip(p);
}`;
const FILL_FS = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec4 v_seg;
uniform float u_baseY;
uniform int u_kind;          // 0 area (gradient from u_g.x to u_g.y), 1 baseline (above and below the base value)
uniform vec2 u_g;
uniform vec4 u_c0; uniform vec4 u_c1; uniform vec4 u_c2; uniform vec4 u_c3;
out vec4 o;
void main() {
  float t = clamp((v_p.x - v_seg.x) / max(v_seg.z - v_seg.x, 1e-6), 0.0, 1.0);
  float ly = mix(v_seg.y, v_seg.w, t);
  float hi = min(ly, u_baseY), lo = max(ly, u_baseY);
  float cov = clamp(min(v_p.y + 0.5, lo) - max(v_p.y - 0.5, hi), 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec4 c;
  if (u_kind == 0) c = mix(u_c0, u_c1, clamp((v_p.y - u_g.x) / max(u_g.y - u_g.x, 1.0), 0.0, 1.0));
  else if (v_p.y < u_baseY) c = mix(u_c0, u_c1, clamp((v_p.y - u_g.x) / max(u_baseY - u_g.x, 1.0), 0.0, 1.0));
  else c = mix(u_c2, u_c3, clamp((v_p.y - u_baseY) / max(u_g.y - u_baseY, 1.0), 0.0, 1.0));
  o = vec4(c.rgb * c.a, c.a) * cov;
}`;

const FLAT_FS = `#version 300 es
precision highp float;
flat in vec4 v_col;
out vec4 o;
void main() { if (v_col.a <= 0.0) discard; o = v_col; }`;

// histogram: from the base value to the value, one colour per bar
const HIST_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_b;
layout(location=2) in vec4 a_col;
${VIEW}
uniform float u_w;      // width in whole pixels
uniform float u_base;   // relative base value
flat out vec4 v_col;
bool na(float v) { return abs(v) > 1e38; }
void main() {
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  if (na(a_b.y)) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float c = floor(px(a_b.x)), x0 = c - floor(u_w * 0.5), x1 = x0 + u_w;
  float ya = floor(py(a_b.y) + 0.5), yb = floor(py(u_base) + 0.5);
  float y0 = min(ya, yb), y1 = max(max(ya, yb), y0 + 1.0);
  gl_Position = clip(vec2(mix(x0, x1, a_c.x), mix(y0, y1, a_c.y)));
}`;

// point markers (pointMarkersVisible), measured on LW's pixels: filled circle, x centre rounded to the pixel plus a correction (half
// a pixel with an odd tick), also added to the radius; y not rounded
const POINT_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_b;
layout(location=2) in vec4 a_col;
${VIEW}
uniform float u_r;      // radius in device pixels
uniform float u_corr;   // offset of x from the pixel (0 or 0.5, see pointMarker)
out vec2 v_p; flat out vec2 v_o; flat out vec4 v_col;
bool na(float v) { return abs(v) > 1e38; }
void main() {
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  vec2 o = vec2(floor(px(a_b.x) + 0.5) + u_corr, py(a_b.y));
  v_o = o; v_p = o;
  if (na(a_b.y) || a_col.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 p = o + (a_c * 2.0 - 1.0) * (u_r + 1.0);
  v_p = p;
  gl_Position = clip(p);
}`;
const POINT_FS = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec2 v_o; flat in vec4 v_col;
uniform float u_r;
out vec4 o;
void main() {
  float cov = clamp(u_r + 0.5 - length(v_p - v_o), 0.0, 1.0);
  if (cov <= 0.0) discard;
  o = v_col * cov;
}`;


const DASH = [[0, 0], [1, 1], [2, 2], [6, 6], [1, 4]]; // LineStyle: solid, dotted, dashed, large dashes, sparse dots
/** Dash pattern in device pixels for the given style and thickness. */
export const dashFor = (style, w) => { const d = DASH[style] || DASH[0]; return [d[0] * w, d[1] * w]; };

/**
 * Dash phase of each segment [from, from + count) of a point packet (stride 3: index, relative value, colour; one NA slot at the
 * head): length in device pixels along the line from the point with logical index `origin` (the first point that LW draws, where
 * setLineDash starts the pattern) to the start of the segment, reduced to the period. Same coordinates as px()/py() of the shader.
 * Segments with an NA end do not count (in LW the empty gaps are not points of the line).
 */
export function dashPhases(g, from, count, U, origin, period, out) {
  const f = g.f, { rightI, rightF, sp, areaW, paneY, hi, k, log, base } = U;
  const X = (i) => areaW - (rightI - i + rightF) * sp;
  const Y = (v) => paneY + (hi - (log ? Math.log(Math.max(v + base, 1e-12)) : v)) * k;
  let cum = 0, at = null, x0 = 0, y0 = 0, ok0 = false;
  {
    const s = from + 1, v = f[3 * s + 1];
    ok0 = Math.abs(v) <= 1e38; if (ok0) { x0 = X(f[3 * s]); y0 = Y(v); }
  }
  for (let j = 0; j < count; j++) {
    const s = from + 1 + j;
    if (at === null && ok0 && f[3 * s] >= origin) at = cum;
    out[j] = cum;
    const v = f[3 * s + 4], ok1 = Math.abs(v) <= 1e38;
    let x1 = 0, y1 = 0;
    if (ok1) { x1 = X(f[3 * s + 3]); y1 = Y(v); if (ok0) cum += Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)); }
    x0 = x1; y0 = y1; ok0 = ok1;
  }
  at ??= 0;
  for (let j = 0; j < count; j++) { const r = (out[j] - at) % period; out[j] = r < 0 ? r + period : r; }
  return out;
}

export class GlxRenderer extends GlRenderer {
  setup() {
    super.setup();
    const gl = this.gl;
    this.P.line2 = compile(gl, LINE_VS, LINE_FS);
    this.P.fill = compile(gl, FILL_VS, FILL_FS);
    this.P.hist2 = compile(gl, HIST_VS, FLAT_FS);
    this.P.points = compile(gl, POINT_VS, POINT_FS);
    const quad = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); return b; };
    const c18 = [];
    for (const part of [0, 1, 2]) for (const [x, y] of [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]]) c18.push(x, y, part);
    this.quad18 = quad(c18);
  }
  disableFrom(loc) { for (let i = loc; i < 6; i++) this.gl.disableVertexAttribArray(i); }

  /** Line: segments from point `from` (count segments) of packet g; colours per point. */
  line2(key, g, from, count, U, { width, style = 0, origin = -Infinity }) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.line2;
    const b = this.dataBuffer(key, g.k, g, 3, 3);
    this.use(P, this.capQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_lw, width);
    const [on, off] = dashFor(style, Math.max(1, Math.round(width)));
    gl.uniform2f(P.u.u_dash, on, off);
    if (on) {
      // per-segment phase computed here on every draw (it depends on the view): only for dashed lines, which are few
      const ph = dashPhases(g, from, count, U, origin, on + off, (this.phArr = this.phArr?.length >= count ? this.phArr : new Float32Array(Math.max(count, 1024))));
      let m = this.bufs.get(key);
      if (!m) this.bufs.set(key, (m = new Map()));
      let e = m.get('dash');
      if (!e) { e = { b: gl.createBuffer(), cap: 0 }; m.set('dash', e); } // forget(key) frees it with the others
      gl.bindBuffer(gl.ARRAY_BUFFER, e.b);
      if (count * 4 > e.cap) { e.cap = Math.max(count * 4, e.cap * 2, 4096); gl.bufferData(gl.ARRAY_BUFFER, e.cap, gl.DYNAMIC_DRAW); }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ph, 0, count);
      this.attr(6, 1, gl.FLOAT, false, 4, 0);
    } else { gl.disableVertexAttribArray(6); gl.vertexAttrib1f(6, 0); }
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = 12, o = from * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 2, gl.FLOAT, false, S, o + S);
    this.attr(3, 2, gl.FLOAT, false, S, o + 2 * S);
    this.attr(4, 2, gl.FLOAT, false, S, o + 3 * S);
    this.attr(5, 4, gl.UNSIGNED_BYTE, true, S, o + S + 8);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    if (on) gl.disableVertexAttribArray(6);
  }

  /** Fill of an area (kind 0) or baseline (kind 1) under the segments [from, from + count). */
  fill(key, g, from, count, U, { kind, baseY, g0, g1, c0, c1, c2 = c0, c3 = c1 }) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.fill;
    const b = this.dataBuffer(key, g.k, g, 3, 3);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_baseY, baseY);
    gl.uniform1i(P.u.u_kind, kind);
    gl.uniform2f(P.u.u_g, g0, g1);
    gl.uniform4fv(P.u.u_c0, rgba(c0)); gl.uniform4fv(P.u.u_c1, rgba(c1)); gl.uniform4fv(P.u.u_c2, rgba(c2)); gl.uniform4fv(P.u.u_c3, rgba(c3));
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = 12, o = (from + 1) * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 2, gl.FLOAT, false, S, o + S);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Histogram: points [from, from + count) of the point packet (one NA slot at the head). */
  hist2(key, g, from, count, U, { width, base }) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.hist2;
    const b = this.dataBuffer(key, g.k, g, 3, 3);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_w, width);
    gl.uniform1f(P.u.u_base, base);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = 12, o = (from + 1) * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 4, gl.UNSIGNED_BYTE, true, S, o + 8);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Point markers [from, from + count) of the point packet (one NA slot at the head), radius in device pixels. */
  points(key, g, from, count, U, { radius, xCorr }) {
    if (count <= 0 || !(radius > 0)) return;
    const gl = this.gl, P = this.P.points;
    const b = this.dataBuffer(key, g.k, g, 3, 3);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_r, radius);
    gl.uniform1f(P.u.u_corr, xCorr);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = 12, o = (from + 1) * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 4, gl.UNSIGNED_BYTE, true, S, o + 8);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

}
