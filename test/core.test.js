// aq drawing engine (prototype, phase 0): scales, time labels and data pyramid
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TimeScale } from '../src/timescale.js';
import { PriceScale, niceStep, priceTicks, precisionOf } from '../src/pricescale.js';
import { wallClock, weightOf, weights, pickTicks, tickLabel, TickIndex, W_YEAR, W_MONTH, W_DAY } from '../src/timeticks.js';
import { CandleStore, LineStore, lodFor, NA } from '../src/lod.js';

test('time scale: position, zoom around the mouse, limits', () => {
  const ts = new TimeScale({ spacing: 10, rightOffset: 5 });
  ts.setWidth(1000);
  ts.setCount(500);
  assert.equal(ts.x(499), 1000 - 5.5 * 10);
  assert.ok(Math.abs(ts.index(ts.x(123)) - 123) < 1e-9);
  const before = ts.index(300);
  ts.zoom(2, 300);
  assert.equal(ts.spacing, 20);
  assert.ok(Math.abs(ts.index(300) - before) < 1e-9, 'the index under the mouse stays fixed');
  ts.pan(1e9); // everything to the right: the first bar stays on the right edge
  assert.ok(ts.index(1000) >= 1 - 1e-9);
  ts.pan(-1e9);
  assert.ok(ts.index(0) <= 498 + 1e-9, 'at least two bars on the left');
  ts.zoom(1e-9);
  assert.ok(ts.spacing >= 500 / 500 / 1 - 1e-9 || ts.spacing >= ts.minSpacing);
  const v = ts.visible();
  assert.ok(v.first >= 0 && v.last <= 499);
});

test('time scale: new bars move the view only if the last one is visible; history does not move it', () => {
  const ts = new TimeScale({ spacing: 10, rightOffset: 5 });
  ts.setWidth(1000); ts.setCount(500);
  const off = ts.right - 499;
  ts.setCount(501);
  assert.equal(ts.right - 500, off);
  ts.pan(5000); // 500 bars back
  const r = ts.right;
  ts.setCount(502);
  assert.equal(ts.right, r);
  const x = ts.x(200);
  ts.setCount(602, { prepended: 100 });
  assert.equal(ts.x(300), x, 'the same bar stays in the same place');
});

test('price scale: margins, conversions, steps and rows', () => {
  const s = new PriceScale({ marginTop: 0.1, marginBottom: 0.1 });
  s.height = 500;
  s.fit(100, 200);
  assert.ok(Math.abs(s.toY(200) - 50) < 1e-9);
  assert.ok(Math.abs(s.toY(100) - 449) < 1e-9, 'the minimum on row height − 1 − margin, as LW');
  assert.ok(Math.abs(s.fromY(s.toY(137.5)) - 137.5) < 1e-9);
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.3), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(31), 40);
  assert.equal(niceStep(41), 50);
  assert.equal(niceStep(0.00031), 0.0005); // below one unit only 1, 2, 5 (measured on LW)
  const t = priceTicks(s, 44);
  assert.ok(t.length >= 5);
  for (let i = 1; i < t.length; i++) assert.ok(s.toY(t[i - 1]) - s.toY(t[i]) >= 44 - 1e-9);
  const lg = new PriceScale({ log: true, marginTop: 0, marginBottom: 0 });
  lg.height = 600; lg.fit(10, 100000);
  const tl = priceTicks(lg, 44);
  assert.ok(tl.length >= 5 && tl.length <= 15, String(tl.length));
  for (let i = 1; i < tl.length; i++) assert.ok(lg.toY(tl[i - 1]) - lg.toY(tl[i]) >= 44 - 1e-6, `${tl[i - 1]} ${tl[i]}`);
  assert.equal(precisionOf([85123.45, 85000, 85001.5]), 2);
  assert.equal(precisionOf([1.08765, 1.1]), 5);
  assert.equal(precisionOf([100, 200]), 0);
});

test('time labels: boundary weights and choice without overlaps', () => {
  const h = 3600e3;
  assert.equal(weightOf(Date.UTC(2026, 0, 1), Date.UTC(2025, 11, 31, 23)), W_YEAR);
  assert.equal(weightOf(Date.UTC(2026, 2, 1), Date.UTC(2026, 1, 28, 23)), W_MONTH);
  assert.equal(weightOf(Date.UTC(2026, 2, 5), Date.UTC(2026, 2, 4, 23)), W_DAY);
  assert.equal(weightOf(Date.UTC(2026, 2, 5, 12), Date.UTC(2026, 2, 5, 11)), 72);
  assert.equal(weightOf(Date.UTC(2026, 2, 5, 13), Date.UTC(2026, 2, 5, 12)), 60);
  assert.equal(weightOf(Date.UTC(2026, 2, 5, 13, 1), Date.UTC(2026, 2, 5, 13)), 40);
  // Rome summer time: local midnight = 22:00 UTC
  const rome = wallClock('Europe/Rome');
  assert.equal(new Date(rome(Date.UTC(2026, 6, 1, 22))).getUTCHours(), 0);
  assert.equal(new Date(rome(Date.UTC(2026, 0, 1, 23))).getUTCHours(), 0);
  const times = Float64Array.from({ length: 24 * 40 }, (_, i) => Date.UTC(2026, 1, 1) + i * h);
  const w = weights(times, (x) => x);
  const ticks = pickTicks(0, times.length - 1, (i) => w[i], (i) => i * 2, 70);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 70);
  assert.ok(ticks.some((t) => t.w === W_MONTH), 'the month change is there');
  // index by weight: same rules, also with a step on dense levels
  const tix = new TickIndex();
  tix.build(w, times.length);
  for (const [a, b, px] of [[0, times.length - 1, 2], [100, 300, 8], [0, times.length - 1, 0.05]]) {
    const tk = tix.pick(a, b, (i) => i * px, 70);
    for (let i = 1; i < tk.length; i++) assert.ok(tk[i].x - tk[i - 1].x >= 70);
    const ref = pickTicks(a, b, (i) => w[i], (i) => i * px, 70);
    assert.equal(Math.max(...tk.map((t) => t.w)), Math.max(...ref.map((t) => t.w)), 'the highest weight is there');
    assert.ok(tk.length >= ref.length * 0.6, `${tk.length} vs ${ref.length}`);
  }
  tix.push(times.length, 90);
  assert.equal(tix.pick(times.length, times.length, (i) => i, 70)[0].i, times.length);
  assert.equal(tickLabel(Date.UTC(2026, 2, 1), W_MONTH, 'it-IT'), 'mar');
  assert.equal(tickLabel(Date.UTC(2026, 2, 1, 14, 30), 60, 'it-IT'), '14:30');
});

const bars = (n, seed = 1) => {
  let x = seed, p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    x = (x * 16807) % 2147483647;
    const r = x / 2147483647 - 0.5;
    const o = p, c = p + r * 2, hi = Math.max(o, c) + Math.abs(r), lo = Math.min(o, c) - Math.abs(r);
    out.push({ openTime: i * 60e3, open: o, high: hi, low: lo, close: c, volume: 10 + (i % 7) });
    p = c;
  }
  return out;
};
const brute = (arr, a, b, key, fn) => arr.slice(a, b + 1).reduce((m, x) => fn(m, x[key]), fn === Math.max ? -Infinity : Infinity);

test('candle pyramid: minimum and maximum of intervals and tail update', () => {
  const b = bars(1000);
  const s = new CandleStore();
  s.set(b);
  for (const [a, z] of [[0, 999], [3, 4], [17, 517], [998, 999], [500, 500], [1, 998]]) {
    assert.deepEqual(s.range(a, z), [brute(b, a, z, 'low', Math.min), brute(b, a, z, 'high', Math.max)], `${a}-${z}`);
    assert.equal(s.volMax(a, z), brute(b, a, z, 'volume', Math.max));
  }
  // new bar with a record high, then the same one updated
  b.push({ openTime: 1000 * 60e3, open: 100, high: 1e4, low: 99, close: 101, volume: 1 });
  assert.equal(s.updateLast(b[1000]), 'append');
  assert.equal(s.range(0, 1000)[1], 1e4);
  b[1000] = { ...b[1000], high: 5e3, low: -7 };
  assert.equal(s.updateLast(b[1000]), 'update');
  assert.deepEqual(s.range(0, 1000), [-7, 5e3]);
  for (let i = 1001; i < 1100; i++) s.updateLast({ openTime: i * 60e3, open: 1, high: 2 + i, low: 0.5, close: 1, volume: 1 });
  assert.equal(s.range(0, 1099)[1], 5e3);
  assert.equal(s.range(1050, 1099)[1], 2 + 1099);
  const ref = new CandleStore();
  ref.set([...b, ...Array.from({ length: 99 }, (_, k) => ({ openTime: (1001 + k) * 60e3, open: 1, high: 2 + 1001 + k, low: 0.5, close: 1, volume: 1 }))]);
  for (let k = 1; k < ref.levels.length; k++) {
    const A = s.levels[k], B = ref.levels[k];
    assert.equal(A.len, B.len);
    for (let j = 0; j < B.len; j++) assert.ok(A.h[j] === B.h[j] && A.l[j] === B.l[j] && A.o[j] === B.o[j] && A.c[j] === B.c[j], `level ${k} group ${j}`);
  }
});

test('GPU packets of candles: group centres and relative prices', () => {
  const b = bars(10);
  const s = new CandleStore();
  s.set(b);
  const g0 = s.pack(0);
  assert.equal(g0.n, 10);
  assert.equal(g0.f[6 * 3], 3);
  assert.ok(Math.abs(g0.f[6 * 3 + 4] - (b[3].close - s.base)) < 1e-4);
  const g2 = s.pack(2); // groups of 4: 0-3, 4-7, 8-9
  assert.equal(g2.n, 3);
  assert.equal(g2.f[0], 1.5);
  assert.equal(g2.f[6 * 2], 8.5);
  assert.ok(Math.abs(g2.f[6 * 2 + 2] - (Math.max(b[8].high, b[9].high) - s.base)) < 1e-4);
  s.updateLast({ ...b[9], high: 999 });
  assert.equal(s.gpu[2].dirty, 2);
  const again = s.pack(2);
  assert.equal(again.from, 2);
  assert.ok(Math.abs(again.f[6 * 2 + 2] - (999 - s.base)) < 1e-3);
  assert.equal(lodFor(3), 0);
  assert.equal(lodFor(0.3), 2);
});

test('lines: minimum and maximum skipping na, level points in index order', () => {
  const v = Array.from({ length: 300 }, (_, i) => (i % 50 < 5 ? NaN : Math.sin(i / 7) * 10 + i * 0.01));
  const s = new LineStore();
  s.set(v);
  const fin = (a, b, fn) => v.slice(a, b + 1).filter(Number.isFinite).reduce((m, x) => fn(m, x), fn === Math.max ? -Infinity : Infinity);
  for (const [a, b] of [[0, 299], [0, 4], [3, 60], [101, 250]]) assert.deepEqual(s.range(a, b), [fin(a, b, Math.min), fin(a, b, Math.max)]);
  const g = s.pack(3);
  assert.equal(g.n, 2 * Math.ceil(300 / 8));
  assert.equal(g.f[2 * (g.n + 1) + 1], NA, 'NA points at the end');
  assert.equal(g.f[1], NA, 'NA point at the head');
  for (let p = 0; p + 1 < g.n; p += 2) assert.ok(g.f[2 * p + 2] <= g.f[2 * p + 4]);
  const g0 = s.pack(0);
  assert.equal(g0.f[3], NA, 'the first value is na');
  s.setAt(300, 1234);
  assert.equal(s.range(0, 300)[1], 1234);
  assert.equal(s.pack(0).from, 300);
});

// Price grid steps against 258 measurements on LW (font 12, minimum spacing 30 px): when the smallest discarded step is less than
// half a pixel from the threshold, LW sometimes skips a step (not reproduced: it is a rounding artefact, not a rule)
import { niceStep as niceStepFx } from '../src/pricescale.js';
test('price grid steps as LW', () => {
  const { rows } = JSON.parse(readFileSync(new URL('./fixtures/lw-measures-steps.json', import.meta.url), 'utf8'));
  assert.ok(rows.length > 250);
  let exact = 0, edge = 0;
  for (const [ppu, step] of rows) {
    const raw = 30 / ppu, got = niceStepFx(raw);
    if (got === step) { exact++; continue; }
    const below = niceStepFx(raw * 0.6); // the nearest discarded candidate
    assert.ok(Math.abs(below * ppu - 30) < 0.5, `ppu ${ppu}: LW ${step}, calcolato ${got}`);
    edge++;
  }
  assert.ok(exact > rows.length * 0.99, `${exact} uguali, ${edge} al limite`);
});

// Prices that fall on a whole row: exact y (before 358.99999999999994 instead of 359; at DPR 1.5 and 2.5 the row 538.5 was rounded
// badly)
test('price scale: a price on a whole row gives an integer y', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let checked = 0;
  for (let n = 0; n < 300; n++) {
    const ps = new PriceScale();
    ps.height = 100 + Math.floor(rnd() * 600);
    const m = 10 ** (rnd() * 6 - 2), lo = (rnd() - 0.3) * m, hi = lo + (0.5 + rnd() * 5) * m;
    ps.lo = lo; ps.hi = hi;
    for (const j of [0, 1, Math.floor(ps.span / 3), ps.span - 1, ps.span]) {
      const p = hi - (j * (hi - lo)) / ps.span;
      assert.equal(ps.toY(p), j, `row ${j}, field ${lo} - ${hi}, height ${ps.height}`);
      checked++;
    }
  }
  assert.equal(checked, 1500);
});

// Time labels: chosen level and filling as on LW (observed with tickMarkFormatter: label times)
test('time labels: filling with bars without a boundary, from the left, at the first that is far enough', () => {
  const n = 40, w = new Uint8Array(n); // no boundary
  for (let i = 0; i < n; i += 5) w[i] = 51; // one boundary every 5 bars
  const tix = new TickIndex(); tix.build(w, n);
  const xOf = (i) => i * 40; // 40 px per bar, minimum distance 80: one bar in every 2
  const got = tix.pick(0, n - 1, xOf, 80, [], 200, 40).map((k) => k.i);
  // boundaries at 5, 10, 15...; filling 2 bars from the neighbours (3 and 7 and 8 and 12...): never two labels less than 2 bars
  // apart
  for (let a = 1; a < got.length; a++) assert.ok(got[a] - got[a - 1] >= 2, `${got[a - 1]} ${got[a]}`);
  assert.ok(got.includes(5) && got.includes(10) && got.includes(15));
  assert.ok(got.length > n / 5 + 5, 'il riempimento aggiunge etichette: ' + got.length);
});

test('niceStep with minMove: steps below one measured on LW (12 minMove values)', () => {
  const FXM = JSON.parse(readFileSync(new URL('./fixtures/lw-measures-minmove.json', import.meta.url), 'utf8')).ladders;
  for (const [mm, lad] of Object.entries(FXM)) {
    const m = +mm;
    assert.equal(niceStep(m * 0.3, m), m, `sotto il passo minimo ${mm}`);
    for (let i = 0; i < lad.length; i++) {
      assert.equal(niceStep(lad[i], m), lad[i], `${mm}: ${lad[i]}`);
      if (i + 1 < lad.length) assert.equal(niceStep(lad[i] * 1.001, m), lad[i + 1], `${mm}: dopo ${lad[i]}`);
    }
    assert.equal(niceStep(lad[lad.length - 1] * 1.001, m), lad[lad.length - 1] < 1 ? 1 : 2, `${mm}: oltre`);
  }
  // without minMove, or with a non-integer 1/minMove, nothing changes
  assert.equal(niceStep(0.07), 0.1);
  assert.equal(niceStep(0.07, 0.8), 0.1);
});
