/*
 * AnubiCharts, the AnubiQuant chart engine. Copyright (c) 2026 AnubiAI (anubiai.com).
 * Licensed under the Apache License, Version 2.0; see LICENSE. Parts are derived from, or inspired by, TradingView Lightweight Charts(TM),
 * Copyright (c) 2025 TradingView, Inc. (Apache-2.0); see NOTICE and DERIVAZIONE.md. Not affiliated with TradingView, Inc.
 */
/**
 * WebGL2 drawing of the aq engine. A single canvas for all panes, shown as it is (no copy into a 2D canvas, which with Lightweight
 * Charts cost ~2 ms of GPU process per pane). Candles, volume and lines live in GPU buffers in bar-index and relative-price
 * coordinates (lod.js): the shader brings them to pixels with the current view (uniforms), so dragging or zooming rewrites nothing
 * on the GPU, and a new price resends only the last group.
 * Lines: six vertices per segment with antialiasing computed in the shader, "mitre" joins from the neighbouring points read from
 * the same buffer (see LINE_VS). Candles and histograms on whole pixels like Lightweight Charts: centre on the pixel column, body
 * a number of pixels wide with the same parity as the wick.
 */
import { NA } from './lod.js';

export const VIEW = `
uniform vec2 u_size;   // canvas in device pixels
uniform vec4 u_view;   // integer index of the right edge, its fractional part, pixels per bar, width of the area
uniform vec2 u_pane;   // top y and height of the pane (device pixels)
uniform vec4 u_px;     // top of the field (relative to base; logarithm of the price in log scale), pixels per unit, log, base
float px(float i) { return u_view.w - ((u_view.x - i) + u_view.y) * u_view.z; }
float py(float p) { float v = u_px.z > 0.5 ? log(max(p + u_px.w, 1e-12)) : p; return u_pane.x + (u_px.x - v) * u_px.y; }
vec4 clip(vec2 p) { return vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0); }
`;

const RECT_VS = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 a_r;
layout(location=2) in vec4 a_col;
uniform vec2 u_size;
flat out vec4 v_col;
void main() {
  vec2 p = vec2(mix(a_r.x, a_r.z, a_c.x), mix(a_r.y, a_r.w, a_c.y));
  v_col = vec4(a_col.rgb * a_col.a, a_col.a);
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);
}`;
const FLAT_FS = `#version 300 es
precision highp float;
flat in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`;

// volume (and histograms): rectangle from the bottom of the area up to the value
const HIST_VS = `#version 300 es
layout(location=0) in vec3 a_c;
layout(location=1) in vec4 a_b0;
layout(location=2) in vec2 a_b1;
${VIEW}
uniform vec2 u_w;
uniform vec3 u_vol;     // bottom of the area (y), pixels per volume unit, minimum width
uniform vec4 u_up; uniform vec4 u_down;
flat out vec4 v_col;
void main() {
  float x = px(a_b0.x), c = floor(x), bw = max(u_w.y, u_vol.z);
  float x0 = c - floor(bw * 0.5), x1 = x0 + bw;
  float y1 = u_vol.x, y0 = floor(u_vol.x - a_b1.y * u_vol.y + 0.5);
  y0 = min(y0, y1 - 1.0);
  vec4 col = a_b1.x >= a_b0.y ? u_up : u_down;
  v_col = vec4(col.rgb * col.a, col.a);
  gl_Position = clip(vec2(mix(x0, x1, a_c.x), mix(y0, y1, a_c.y)));
}`;

// Lines: one quadrilateral per segment with "mitre" joins computed from the neighbouring points (pm before p0, p2 after p1). Two
// consecutive segments compute the same vertex on the shared point, so they do not overlap and leave no holes: every pixel is
// coloured once without stencil (with a per-line stencil, the technique of gl-layer.js in the host application, the Intel UHD 630
// GPU took 28 ms per frame with 37 lines and 3000 bars in view; without it ~5). v_d = distance from the segment's line for
// antialiasing (affine in the quadrilateral, so exact even when interpolated).
const LINE_VS = `#version 300 es
layout(location=0) in vec2 a_c;   // x: 0 on point p0, 1 on p1; y: side -1/+1
layout(location=1) in vec2 a_pm;
layout(location=2) in vec2 a_p0;
layout(location=3) in vec2 a_p1;
layout(location=4) in vec2 a_p2;
${VIEW}
uniform float u_lw;     // thickness in device pixels
out float v_d;
bool na(float v) { return abs(v) > 1e38; }
vec2 P(vec2 a) { return vec2(px(a.x), py(a.y)); }
void main() {
  vec2 q0 = P(a_p0), q1 = P(a_p1), d = q1 - q0;
  float len = length(d);
  v_d = 0.0;
  if (na(a_p0.y) || na(a_p1.y) || len < 1e-3) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  vec2 t = d / len, n = vec2(-t.y, t.x);
  bool atEnd = a_c.x > 0.5;
  vec2 q = atEnd ? q1 : q0, nb = atEnd ? a_p2 : a_pm;
  float e = u_lw * 0.5 + 1.0, c = 1.0;
  vec2 m = n;
  if (!na(nb.y)) {
    vec2 qo = P(nb), d2 = atEnd ? qo - q1 : q0 - qo;
    float l2 = length(d2);
    if (l2 > 1e-3) {
      vec2 s = t + d2 / l2;
      float ls = length(s);
      if (ls > 1e-3) { vec2 tm = s / ls; m = vec2(-tm.y, tm.x); c = max(dot(m, n), 0.3); }
    }
  }
  v_d = a_c.y * e;
  gl_Position = clip(q + m * (a_c.y * e / c));
}`;
const LINE_FS = `#version 300 es
precision highp float;
in float v_d;
uniform float u_lw;
uniform vec4 u_col;
out vec4 o;
void main() {
  float cov = clamp(u_lw * 0.5 + 0.5 - abs(v_d), 0.0, 1.0);
  if (cov <= 0.0) discard;
  float al = u_col.a * cov;
  o = vec4(u_col.rgb * al, al);
}`;

export function compile(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

// ---- CSS colours → [r, g, b, a] 0..1
const COLORS = new Map();
let probe = null;
export function rgba(c) {
  let v = COLORS.get(c);
  if (v) return v;
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    if (h.length === 6) h += 'ff';
    v = [0, 2, 4, 6].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
  } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(c))) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    v = [+m[1] / 255, +m[2] / 255, +m[3] / 255, Math.max(0, Math.min(1, a))];
  } else {
    probe ||= document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000';
    probe.fillStyle = c;
    const n = probe.fillStyle;
    v = n !== c && typeof n === 'string' ? rgba(n) : [0, 0, 0, 1];
  }
  if (COLORS.size > 2000) COLORS.clear();
  COLORS.set(c, v);
  return v;
}
export const packRgba = (c) => {
  const [r, g, b, a] = rgba(c);
  return ((Math.round(a * 255) << 24) | (Math.round(b * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(r * 255)) >>> 0;
};

export class GlRenderer {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { alpha: !!opts.alpha, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 non disponibile');
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.setup(); this.lost = false; this.onRestore?.(); });
    this.setup();
    // GPU time (tests): EXT_disjoint_timer_query_webgl2
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.gpuMs = null;
    this.measureGpu = false;
    this.debug = { skip: {} }; // tests: which parts to draw
  }

  setup() {
    const gl = this.gl;
    this.P = {
      rect: compile(gl, RECT_VS, FLAT_FS),
      hist: compile(gl, HIST_VS, FLAT_FS),
      line: compile(gl, LINE_VS, LINE_FS),
    };
    const quad = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); return b; };
    this.boxQuad = quad([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    this.capQuad = quad([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]);
    const c12 = [];
    for (const part of [0, 1]) for (const [x, y] of [[0, 0], [1, 0], [0, 1], [0, 1], [1, 0], [1, 1]]) c12.push(x, y, part);
    this.candleQuad = quad(c12);
    this.rectBufs = [{ b: gl.createBuffer(), cap: 0 }, { b: gl.createBuffer(), cap: 0 }]; // below and above the series
    this.vao = gl.createVertexArray();
    this.bufs = new Map(); // series data: store → Map(level → { g, b, cap })
  }

  /** GPU buffer for packet g (lod.js) of level k of store: resends only what changed. */
  dataBuffer(store, k, g, stride, extra = 0) {
    const gl = this.gl;
    let m = this.bufs.get(store);
    if (!m) this.bufs.set(store, (m = new Map()));
    let e = m.get(k);
    if (!e) { e = { g: null, b: gl.createBuffer(), cap: 0 }; m.set(k, e); }
    gl.bindBuffer(gl.ARRAY_BUFFER, e.b);
    const bytes = (g.n + extra) * stride * 4;
    if (e.g !== g || bytes > e.cap) {
      // GPU memory grows only if the data no longer fits (before, it doubled with every new packet, that is with every setData of a
      // series: the app does ~1 per second for indicators and after 20-30 s it was gigabytes and Chrome's GPU process froze for
      // seconds); with data of the same size the existing buffer is rewritten
      if (bytes > e.cap) {
        e.cap = Math.max(bytes + (bytes >> 1), 4096);
        gl.bufferData(gl.ARRAY_BUFFER, e.cap, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, g.f, 0, (g.n + extra) * stride);
      e.g = g;
    } else if (g.from < g.n + extra) {
      gl.bufferSubData(gl.ARRAY_BUFFER, g.from * stride * 4, g.f, g.from * stride, (g.n + extra - g.from) * stride);
    }
    g.from = Infinity;
    return e.b;
  }

  forget(store) {
    const m = this.bufs.get(store);
    if (!m) return;
    for (const e of m.values()) this.gl.deleteBuffer(e.b);
    this.bufs.delete(store);
  }

  /** Start of the frame: size in device pixels, background. */
  begin(w, h, bg) {
    const gl = this.gl;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.w = w; this.h = h;
    if (this.measureGpu && this.timer) this.startQuery();
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    if (bg) { const [r, g, b] = rgba(bg); gl.clearColor(r, g, b, 1); } else gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Clip to a pane's rectangle (device pixels from the top); null = everything. */
  clipTo(r) {
    const gl = this.gl;
    if (!r) { gl.disable(gl.SCISSOR_TEST); return; }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(r.x, this.h - r.y - r.h, r.w, r.h);
  }

  use(prog, quad, size) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.uniform2f(prog.u.u_size, this.w, this.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
  }
  attr(loc, size, type, norm, stride, off) {
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, norm, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  }
  disableFrom(loc) { for (let i = loc; i < 5; i++) this.gl.disableVertexAttribArray(i); }

  /** View and scale shared by drawings in data coordinates. */
  viewUniforms(prog, U) {
    const gl = this.gl, u = prog.u;
    gl.uniform4f(u.u_view, U.rightI, U.rightF, U.sp, U.areaW);
    gl.uniform2f(u.u_pane, U.paneY, U.paneH);
    gl.uniform4f(u.u_px, U.hi, U.k, U.log ? 1 : 0, U.base);
  }

  /** Rectangles in device pixels: f = Float32Array in groups of 5 (x0 y0 x1 y1 colour packed as Uint32). */
  rects(f, n, slot = 0) {
    if (!n) return;
    const gl = this.gl, rb = (this.rectBufs[slot] ||= { b: gl.createBuffer(), cap: 0 }); // one buffer per draw in the same frame
    gl.bindBuffer(gl.ARRAY_BUFFER, rb.b);
    const bytes = n * 20;
    if (bytes > rb.cap) { rb.cap = Math.max(bytes, rb.cap * 2, 4096); gl.bufferData(gl.ARRAY_BUFFER, rb.cap, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f, 0, n * 5);
    this.use(this.P.rect, this.boxQuad, 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, rb.b);
    this.attr(1, 4, gl.FLOAT, false, 20, 0);
    this.attr(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  }

  /** Volume of level k: height from the bottom `bottom` (device pixels), `k2` pixels per unit. */
  volume(store, k, from, count, U, { bottom, scale, up, down, minW = 1 }) {
    if (count <= 0 || this.debug.skip.volume) return;
    const gl = this.gl, P = this.P.hist;
    const b = this.dataBuffer(store, k, store.pack(k), 6);
    this.use(P, this.candleQuad, 3);
    this.viewUniforms(P, U);
    gl.uniform2f(P.u.u_w, U.wickW, U.bodyW);
    gl.uniform3f(P.u.u_vol, bottom, scale, minW);
    gl.uniform4fv(P.u.u_up, rgba(up)); gl.uniform4fv(P.u.u_down, rgba(down));
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    this.attr(1, 4, gl.FLOAT, false, 24, from * 24);
    this.attr(2, 2, gl.FLOAT, false, 24, from * 24 + 16);
    this.disableFrom(3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  /** Line: points [from, from + count] of level k (count segments). */
  line(store, k, from, count, U, { color, width }) {
    if (count <= 0 || this.debug.skip.line) return;
    const gl = this.gl, P = this.P.line;
    const b = this.dataBuffer(store, k, store.pack(k), 2, 3); // with the NA point at the head and the two at the end
    this.use(P, this.capQuad, 2);
    this.viewUniforms(P, U);
    gl.uniform1f(P.u.u_lw, width);
    gl.uniform4fv(P.u.u_col, rgba(color));
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    // point i in slot i + 1 (slot 0 = NA): the segment starting at point `from` reads slots from ... from + 3
    const off = from * 8;
    this.attr(1, 2, gl.FLOAT, false, 8, off);
    this.attr(2, 2, gl.FLOAT, false, 8, off + 8);
    this.attr(3, 2, gl.FLOAT, false, 8, off + 16);
    this.attr(4, 2, gl.FLOAT, false, 8, off + 24);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  end() {
    if (this.measureGpu && this.timer && this.q) { this.gl.endQuery(this.timer.TIME_ELAPSED_EXT); this.queries.push(this.q); this.q = null; }
    this.pollQueries();
  }

  startQuery() {
    const gl = this.gl;
    this.q = gl.createQuery();
    gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.q);
  }
  pollQueries() {
    const gl = this.gl;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.timer?.GPU_DISJOINT_EXT ?? 0);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      this.queries.shift();
      if (!disjoint) { this.gpuMs = ns / 1e6; this.onGpu?.(this.gpuMs); }
    }
  }
}

export { NA };
