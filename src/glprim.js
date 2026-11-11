/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * WebGL drawings of Pine scripts for the aq engine (ScriptLayer of drawings.js in the host application, when the chart is
 * aq/lw.js): backgrounds (bgcolor), fills between two plots, plotshape/plotchar shapes, line.new lines and box.new boxes. They
 * used to go through each pane's 2D canvas, and every large 2D canvas redrawn on every frame weighs on Chrome's GPU process (at
 * 3440×1440 it was 80-90% busy); text stays on the canvas.
 * Backgrounds, fills and shapes live on the GPU in bar-index and relative-price coordinates (like the series, see gl.js):
 * scrolling and zooming only change the uniforms, and a new computation of the script resends only the changed part. Lines and
 * boxes are few (a few hundred at most) and are sent in pixels on every frame.
 * Formats (Float32Array with a Uint32 view for colours, packed like packColor of gl-layer.js):
 * - backgrounds: 3 words [first bar, last bar, colour], full pane height, borders between two bars on the pixel;
 * - fills: 11 words [i, j, a(i), a(j), b(i), b(j), high and low price of the gradient, gradient yes/no, colour, colour 2];
 * - shapes: 8 words [bar, price, location + 8·type, side in pixels (negative = size.auto), colour, label height and width with the
 *    text, 0];
 * - segments in device pixels: 9 words [x0, y0, x1, y1, thickness, colour, dash, gap, phase].
 */
import { GlxRenderer } from './glx.js';
import { VIEW, compile } from './gl.js';

const HIDE = 'gl_Position = vec4(2.0, 2.0, 0.0, 1.0);';

const BAND_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_b;
layout(location=2) in vec4 a_col;
${VIEW}
flat out vec4 v_col;
void main() {
  // border between bar i − 1 and bar i on the pixel (as drawBg: neighbouring bands do not overlap)
  float x0 = floor(px(a_b.x - 0.5) + 0.5), x1 = floor(px(a_b.y + 0.5) + 0.5);
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  if (x1 <= x0 || a_col.a <= 0.0) { ${HIDE} return; }
  gl_Position = clip(vec2(mix(x0, x1, a_c.x), mix(u_pane.x, u_pane.x + u_pane.y, a_c.y)));
}`;

const FLAT_FS = `#version 300 es
precision highp float;
flat in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`;

// vertical trapezoid between two plots: left and right edges on pixels, top and bottom with exact coverage (as gl-layer.js)
const QFILL_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec2 a_i;
layout(location=2) in vec2 a_a;
layout(location=3) in vec2 a_b;
layout(location=4) in vec3 a_g;
layout(location=5) in vec4 a_c0;
layout(location=6) in vec4 a_c1;
${VIEW}
uniform float u_dpr;
out vec2 v_p; flat out vec4 v_x; flat out vec4 v_y; flat out vec4 v_c0; flat out vec4 v_c1;
void main() {
  float x0 = floor(px(a_i.x) + 0.5), x1 = floor(px(a_i.y) + 0.5);
  float ya0 = py(a_a.x), ya1 = py(a_a.y), yb0 = py(a_b.x), yb1 = py(a_b.y);
  float gt = 0.0, gb = 0.0;
  if (a_g.z > 0.5) {
    gt = py(a_g.x); gb = py(a_g.y);
    if (abs(gt - gb) < 0.5 * u_dpr) { gt = 0.0; gb = 0.0; } // zero-length gradient: the top colour
  }
  v_x = vec4(x0, x1, ya0, ya1); v_y = vec4(yb0, yb1, gt, gb);
  v_c0 = vec4(a_c0.rgb * a_c0.a, a_c0.a); v_c1 = vec4(a_c1.rgb * a_c1.a, a_c1.a);
  v_p = vec2(0.0);
  if (x1 <= x0) { ${HIDE} return; }
  float top = min(min(ya0, ya1), min(yb0, yb1)) - 1.0, bot = max(max(ya0, ya1), max(yb0, yb1)) + 1.0;
  vec2 p = vec2(mix(x0, x1, a_c.x), mix(top, bot, a_c.y));
  v_p = p;
  gl_Position = clip(p);
}`;
const QFILL_FS = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec4 v_x; flat in vec4 v_y; flat in vec4 v_c0; flat in vec4 v_c1;
out vec4 o;
void main() {
  float t = clamp((v_p.x - v_x.x) / max(v_x.y - v_x.x, 1e-6), 0.0, 1.0);
  float ya = mix(v_x.z, v_x.w, t), yb = mix(v_y.x, v_y.y, t);
  float hi = min(ya, yb), lo = max(ya, yb);
  float cov = clamp(min(v_p.y + 0.5, lo) - max(v_p.y - 0.5, hi), 0.0, 1.0);
  if (cov <= 0.0) discard;
  vec4 c = v_c0;
  if (v_y.z != v_y.w) c = mix(v_c0, v_c1, clamp((v_p.y - v_y.z) / (v_y.w - v_y.z), 0.0, 1.0));
  o = c * cov;
}`;

// the same trapezoids already in device pixels (boxes): QUAD_STRIDE format of gl-layer.js
const PQUAD_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 a_x;   // x0 x1 ya0 ya1
layout(location=2) in vec4 a_y;   // yb0 yb1 gTop gBot
layout(location=3) in vec4 a_c0;
layout(location=4) in vec4 a_c1;
uniform vec2 u_size;
out vec2 v_p; flat out vec4 v_x; flat out vec4 v_y; flat out vec4 v_c0; flat out vec4 v_c1;
void main() {
  float top = min(min(a_x.z, a_x.w), min(a_y.x, a_y.y)) - 1.0, bot = max(max(a_x.z, a_x.w), max(a_y.x, a_y.y)) + 1.0;
  vec2 p = vec2(mix(a_x.x, a_x.y, a_c.x), mix(top, bot, a_c.y));
  v_p = p; v_x = a_x; v_y = a_y;
  v_c0 = vec4(a_c0.rgb * a_c0.a, a_c0.a); v_c1 = vec4(a_c1.rgb * a_c1.a, a_c1.a);
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`;

// segments in pixels: body cut square at the ends (canvas lineCap 'butt'), antialiasing on the sides, dashing
const SEG_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 a_seg;
layout(location=2) in float a_w;
layout(location=3) in vec4 a_col;
layout(location=4) in vec3 a_dash;
uniform vec2 u_size;
out vec2 v_p; flat out vec4 v_seg; flat out float v_w; flat out vec4 v_col; flat out vec3 v_dash;
void main() {
  vec2 p0 = a_seg.xy, p1 = a_seg.zw, d = p1 - p0;
  float len = length(d);
  vec2 t = len > 0.0 ? d / len : vec2(1.0, 0.0), n = vec2(-t.y, t.x);
  float e = a_w * 0.5 + 1.0;
  vec2 p = p0 + t * (a_c.x < 0.5 ? 0.0 : len) + n * a_c.y * e;
  v_p = p; v_seg = a_seg; v_w = a_w; v_col = vec4(a_col.rgb * a_col.a, a_col.a); v_dash = a_dash;
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
  if (len <= 0.0) ${HIDE}
}`;
const SEG_FS = `#version 300 es
precision highp float;
in vec2 v_p; flat in vec4 v_seg; flat in float v_w; flat in vec4 v_col; flat in vec3 v_dash;
out vec4 o;
void main() {
  vec2 a = v_seg.xy, ba = v_seg.zw - a, pa = v_p - a;
  float L = max(length(ba), 1e-4), along = dot(pa, ba) / L;
  float cov = clamp(v_w * 0.5 + 0.5 - abs(dot(pa, vec2(-ba.y, ba.x))) / L, 0.0, 1.0);
  if (v_dash.x > 0.0) {
    float m = mod(v_dash.z + along, v_dash.x + v_dash.y);
    cov *= clamp(v_dash.x - m + 0.5, 0.0, 1.0) * clamp(m + 0.5, 0.0, 1.0);
  }
  if (cov <= 0.0) discard;
  o = v_col * cov;
}`;

/**
 * Shapes of plotshape/plotchar like drawShape of drawings.js, with the signed distance of each outline (antialiasing like the
 * canvas). Size, position and distance from the bar are computed here from the bar spacing, like sized()/shapeBody(): zooming asks
 * nothing of the CPU. Types: 0 xcross, 1 cross, 2 circle, 3 square, 4 diamond, 5 triangleup, 6 triangledown, 7 arrowup, 8
 * arrowdown, 9 flag, 10 labelup, 11 labeldown. Locations: 0 absolute, 1 above, 2 below, 3 top, 4 bottom.
 */
const SHAPE_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 a_s;    // bar, price, location + 8·type, side (negative: size.auto)
layout(location=2) in vec4 a_col;
layout(location=3) in vec2 a_t;    // labels: text height (lines · 13 + 6, 0 without text), text width + 10
${VIEW}
uniform float u_dpr;
out vec2 v_q; flat out vec4 v_col; flat out vec4 v_g;
void main() {
  float bs = u_view.z / u_dpr;
  float P = a_s.w < 0.0 ? max(3.0, min(11.0, floor(bs * 1.5 + 0.5))) : min(a_s.w, max(5.0, floor(bs * 3.0 + 0.5)));
  int code = int(a_s.z + 0.5), loc = code - (code / 8) * 8, kind = code / 8;
  if (u_px.y < 0.0 && (loc == 1 || loc == 2)) loc = 3 - loc; // inverted scale: above and below swap
  float sc = kind <= 1 ? 0.5 : kind == 9 ? 0.7 : 1.0;
  bool label = kind >= 10;
  float body = label ? (a_t.x > 0.0 ? a_t.x : P) + 5.0 : P * sc;
  float W = max(P, a_t.y);
  float cy, d = u_dpr;
  if (loc == 0 || loc == 1 || loc == 2 || kind > 11) {
    if (abs(a_s.y) > 1e38 || kind > 11) { ${HIDE} v_col = vec4(0.0); v_q = vec2(0.0); v_g = vec4(0.0); return; }
    float y = py(a_s.y);
    cy = loc == 0 ? y : loc == 1 ? y - (4.0 + body * 0.5) * d : y + (4.0 + body * 0.5) * d;
  } else if (loc == 3) cy = u_pane.x + (4.0 + body * 0.5) * d;
  else cy = u_pane.x + u_pane.y - (4.0 + body * 0.5) * d;
  float cx = px(a_s.x);
  vec2 h = vec2((label ? max(W * 0.5, 5.0) : body * 0.5) + 2.0, body * 0.5 + 2.0);
  v_q = mix(-h, h, a_c);
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  v_g = vec4(P, body, W, float(kind));
  gl_Position = clip(vec2(cx, cy) + v_q * d);
}`;
const SHAPE_FS = `#version 300 es
precision highp float;
in vec2 v_q; flat in vec4 v_col; flat in vec4 v_g;
uniform float u_dpr;
out vec4 o;
float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float box(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float rbox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float tri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2, v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
void main() {
  float P = v_g.x, body = v_g.y, W = v_g.z, sd;
  int kind = int(v_g.w + 0.5);
  vec2 q = v_q;
  float r = body * 0.5;
  if (kind == 0 || kind == 1) {
    float lw = max(1.2, P / 11.0);
    sd = kind == 0 ? min(seg(q, vec2(-r, -r), vec2(r, r)), seg(q, vec2(r, -r), vec2(-r, r))) : min(seg(q, vec2(-r, 0.0), vec2(r, 0.0)), seg(q, vec2(0.0, -r), vec2(0.0, r)));
    sd -= lw * 0.5;
  } else if (kind == 2) sd = length(q) - r;
  else if (kind == 3) sd = box(q, vec2(r));
  else if (kind == 4) sd = (abs(q.x) + abs(q.y) - r) * 0.70710678;
  else if (kind == 5) sd = tri(q, vec2(0.0, -r), vec2(r, 0.8 * r), vec2(-r, 0.8 * r));
  else if (kind == 6) sd = tri(q, vec2(0.0, r), vec2(r, -0.8 * r), vec2(-r, -0.8 * r));
  else if (kind == 7 || kind == 8) {
    float dd = kind == 7 ? 1.0 : -1.0, w = r * 0.38;
    sd = min(tri(q, vec2(0.0, -dd * r), vec2(r, 0.0), vec2(-r, 0.0)), box(q - vec2(0.0, dd * r * 0.5), vec2(w, r * 0.5)));
  } else if (kind == 9) {
    float x = -0.7 * r, lw = max(1.2, P / 10.0);
    sd = min(seg(q, vec2(x, r), vec2(x, -r)) - lw * 0.5, tri(q, vec2(x, -r), vec2(r, -0.55 * r), vec2(x, -0.05 * r)));
  } else {
    float h = body - 5.0;
    if (kind == 10) {
      float top = -h * 0.5 + 2.5;
      sd = min(rbox(q - vec2(0.0, top + h * 0.5), vec2(W * 0.5, h * 0.5), 3.0), tri(q, vec2(0.0, top - 5.0), vec2(5.0, top), vec2(-5.0, top)));
    } else {
      float top = -h * 0.5 - 2.5;
      sd = min(rbox(q - vec2(0.0, top + h * 0.5), vec2(W * 0.5, h * 0.5), 3.0), tri(q, vec2(0.0, top + h + 5.0), vec2(5.0, top + h), vec2(-5.0, top + h)));
    }
  }
  float cov = clamp(0.5 - sd * u_dpr, 0.0, 1.0);
  if (cov <= 0.0) discard;
  o = v_col * cov;
}`;

export const BAND_STRIDE = 3, QFILL_STRIDE = 11, SHAPE_STRIDE = 8, SEG_STRIDE = 9;
export const SHAPE_KIND = { xcross: 0, cross: 1, circle: 2, square: 3, diamond: 4, triangleup: 5, triangledown: 6, arrowup: 7, arrowdown: 8, flag: 9, labelup: 10, labeldown: 11 };
export const SHAPE_LOC = { abs: 0, above: 1, below: 2, top: 3, bottom: 4 };

export class GlpRenderer extends GlxRenderer {
  setup() {
    super.setup();
    const gl = this.gl;
    this.P.band = compile(gl, BAND_VS, FLAT_FS);
    this.P.qfill = compile(gl, QFILL_VS, QFILL_FS);
    this.P.seg = compile(gl, SEG_VS, SEG_FS);
    this.P.shape = compile(gl, SHAPE_VS, SHAPE_FS);
    this.P.pquad = compile(gl, PQUAD_VS, QFILL_FS);
    this.tmpBufs = [];
  }

  /** Data of a single frame in a temporary buffer (one per draw in the same frame). */
  tmp(f, words, slot) {
    const gl = this.gl, sb = (this.tmpBufs[slot] ||= { b: gl.createBuffer(), cap: 0 });
    gl.bindBuffer(gl.ARRAY_BUFFER, sb.b);
    const bytes = words * 4;
    if (bytes > sb.cap) { sb.cap = Math.max(bytes, sb.cap * 2, 4096); gl.bufferData(gl.ARRAY_BUFFER, sb.cap, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f, 0, words);
    return sb.b;
  }

  /** Trapezoids and rectangles in device pixels (QUAD_STRIDE format of gl-layer.js, 10 words). */
  pquads(f, n, slot = 0) {
    if (!n) return;
    const gl = this.gl;
    const b = this.tmp(f, n * 10, slot);
    this.use(this.P.pquad, this.boxQuad, 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    this.attr(1, 4, gl.FLOAT, false, 40, 0);
    this.attr(2, 4, gl.FLOAT, false, 40, 16);
    this.attr(3, 4, gl.UNSIGNED_BYTE, true, 40, 32);
    this.attr(4, 4, gl.UNSIGNED_BYTE, true, 40, 36);
    this.disableFrom(5);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  }
  disableFrom(loc) { for (let i = loc; i < 8; i++) this.gl.disableVertexAttribArray(i); }

  /** Backgrounds: bands [from, from + count) of packet g (key `key`). */
  bands(key, g, from, count, U) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.band;
    const b = this.dataBuffer(key, g.k, g, BAND_STRIDE, 0);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = BAND_STRIDE * 4, o = from * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 4, gl.UNSIGNED_BYTE, true, S, o + 8);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Fills: trapezoids [from, from + count) of packet g. */
  qfills(key, g, from, count, U, dpr) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.qfill;
    const b = this.dataBuffer(key, g.k, g, QFILL_STRIDE, 0);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_dpr, dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = QFILL_STRIDE * 4, o = from * S;
    this.attr(1, 2, gl.FLOAT, false, S, o);
    this.attr(2, 2, gl.FLOAT, false, S, o + 8);
    this.attr(3, 2, gl.FLOAT, false, S, o + 16);
    this.attr(4, 3, gl.FLOAT, false, S, o + 24);
    this.attr(5, 4, gl.UNSIGNED_BYTE, true, S, o + 36);
    this.attr(6, 4, gl.UNSIGNED_BYTE, true, S, o + 40);
    this.disableFrom(7);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Shapes [from, from + count) of packet g. */
  shapes(key, g, from, count, U, dpr) {
    if (count <= 0) return;
    const gl = this.gl, P = this.P.shape;
    const b = this.dataBuffer(key, g.k, g, SHAPE_STRIDE, 0);
    this.use(P, this.boxQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_dpr, dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = SHAPE_STRIDE * 4, o = from * S;
    this.attr(1, 4, gl.FLOAT, false, S, o);
    this.attr(2, 4, gl.UNSIGNED_BYTE, true, S, o + 16);
    this.attr(3, 2, gl.FLOAT, false, S, o + 20);
    this.disableFrom(4);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Segments in device pixels (f in groups of SEG_STRIDE); slot: one buffer per draw in the same frame. */
  segs(f, n, slot = 0) {
    if (!n) return;
    const gl = this.gl;
    const b = this.tmp(f, n * SEG_STRIDE, slot);
    this.use(this.P.seg, this.capQuad, 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const S = SEG_STRIDE * 4;
    this.attr(1, 4, gl.FLOAT, false, S, 0);
    this.attr(2, 1, gl.FLOAT, false, S, 16);
    this.attr(3, 4, gl.UNSIGNED_BYTE, true, S, 20);
    this.attr(4, 3, gl.FLOAT, false, S, 24);
    this.disableFrom(5);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  }
}
