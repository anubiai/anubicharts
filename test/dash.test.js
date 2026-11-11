// Dashing of lines in the aq engine (dashPhases of src/glx.js): the pattern starts at the first point that LW would draw and is
// measured along the line, like the canvas's setLineDash. Scrolling the chart without changing that point, the phase of each segment
// does not change (the dashes move with the line instead of "walking" over it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashPhases } from '../src/glx.js';

const NA = 3e38;
function packet(vals) {
  const f = new Float32Array((vals.length + 3) * 3);
  f[1] = NA;
  vals.forEach((v, i) => { f[3 * (i + 1)] = i; f[3 * (i + 1) + 1] = v; });
  f[3 * (vals.length + 1) + 1] = NA; f[3 * (vals.length + 2) + 1] = NA;
  return { f, n: vals.length };
}
const view = (rightF) => ({ rightI: 20, rightF, sp: 10, areaW: 400, paneY: 0, hi: 10, k: 4, log: false, base: 0 });

test('horizontal line: phase = distance from the origin point, reduced to the period', () => {
  const g = packet(new Array(12).fill(5));
  const out = dashPhases(g, 0, 10, view(0), 3, 8, new Float32Array(10));
  // segment j starts at point j: (j − 3) · 10 px from point 3, modulo 8
  for (let j = 0; j < 10; j++) assert.equal(out[j], ((((j - 3) * 10) % 8) + 8) % 8);
});

test('scrolling with the same origin point the phase does not change; along the line also when rising', () => {
  const vals = [1, 2, 4, 3, 5, 9, 2, 2, 6, 1, 3, 4];
  const g = packet(vals);
  const a = Array.from(dashPhases(g, 0, 10, view(0), 2, 12, new Float32Array(10)));
  const b = Array.from(dashPhases(g, 0, 10, view(0.37), 2, 12, new Float32Array(10)));
  for (let j = 0; j < 10; j++) assert.ok(Math.abs(a[j] - b[j]) < 1e-3, `segmento ${j}`);
  // segment 3 (from point 3): length of segment 2 (points 2→3) from point 2, in pixels (10 in x, 4 per unit in y)
  assert.ok(Math.abs(a[3] - (Math.hypot(10, 4 * (vals[3] - vals[2])) % 12)) < 1e-3);
});

test('a gap (NA value) does not count in the length', () => {
  const g = packet([5, 5, 5, NA, 5, 5, 5]);
  const out = dashPhases(g, 0, 6, view(0), 0, 1000, new Float32Array(6));
  assert.deepEqual(Array.from(out), [0, 10, 20, 20, 20, 30]);
});
