// aq engine, Lightweight Charts-compatible layer: time index (union of times) and series data in columns
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeIndex, SeriesStore, KIND_OHLC, KIND_VALUE } from '../src/lw-data.js';
import { NA } from '../src/lod.js';

test('time index: sorted union without duplicates, append at the end, search', () => {
  const ti = new TimeIndex();
  ti.rebuild([Float64Array.of(10, 20, 30), Float64Array.of(20, 25, 40), Float64Array.of()]);
  assert.deepEqual([...ti.t.subarray(0, ti.n)], [10, 20, 25, 30, 40]);
  assert.equal(ti.indexOf(25), 2);
  assert.equal(ti.indexOf(26), -1);
  assert.equal(ti.lower(26), 3);
  ti.append(50);
  assert.equal(ti.indexOf(50), 5);
});

const valueStore = (vals, ti) => {
  const st = new SeriesStore(KIND_VALUE);
  st.alloc(vals.length);
  vals.forEach((v, i) => { st.t[i] = (i + 1) * 60; st.v[i] = v == null ? NaN : v; });
  st.n = vals.length;
  ti.rebuild([st.t.subarray(0, st.n)]);
  st.remap(ti);
  st.build();
  return st;
};

test('value series: positions of a logical interval, minimum and maximum skipping empties', () => {
  const ti = new TimeIndex();
  const vals = Array.from({ length: 500 }, (_, i) => (i % 40 < 3 ? null : Math.sin(i / 9) * 50 + i));
  const st = valueStore(vals, ti);
  const fin = (a, b) => vals.slice(a, b + 1).filter((v) => v != null);
  for (const [a, b] of [[0, 499], [0, 2], [17, 333], [480, 499]]) {
    const [pa, pb] = st.posRange(a, b);
    const [mn, mx] = st.range(pa, pb);
    const f = fin(a, b);
    assert.equal(mn, f.length ? Math.min(...f) : Infinity, `${a}-${b}`);
    assert.equal(mx, f.length ? Math.max(...f) : -Infinity);
  }
  // positions with non-contiguous logical indices (series with fewer times than the scale)
  const sparse = new SeriesStore(KIND_VALUE);
  sparse.alloc(3);
  [[60, 1], [240, 2], [600, 3]].forEach(([t, v], i) => { sparse.t[i] = t; sparse.v[i] = v; });
  sparse.n = 3;
  sparse.remap(ti);
  sparse.build();
  // times 60, 240, 600 → logical indices 0, 3, 9
  assert.deepEqual(sparse.posRange(1, 9), [1, 2]);
  assert.deepEqual(sparse.posRange(4, 8), [2, 1], 'no point: the end comes before the start');
  assert.deepEqual(sparse.posRange(10, 2000), [3, 2]);
});

test('line packets: NA slots at head and tail, groups in order, colours and tail update', () => {
  const ti = new TimeIndex();
  const st = valueStore(Array.from({ length: 100 }, (_, i) => i % 7), ti);
  const col = () => 0xff0000ff;
  const g0 = st.packPoints(0, col);
  assert.equal(g0.n, 100);
  assert.equal(g0.f[1], NA);
  assert.equal(g0.f[3 * 5], 4, 'point 4 in slot 5');
  assert.equal(g0.u[3 * 5 + 2], 0xff0000ff);
  assert.equal(g0.f[3 * 101 + 1], NA);
  const g2 = st.packPoints(2, col);
  assert.equal(g2.n, 50);
  for (let s = 1; s < 50; s += 2) assert.ok(g2.f[3 * s] <= g2.f[3 * (s + 1)]);
  // no change: nothing to resend to the GPU
  assert.equal(st.packPoints(0, col).from, Infinity);
  st.v[99] = 1000; st.refresh(99);
  const g = st.packPoints(0, col);
  assert.equal(g.from, 99);
  assert.equal(g.f[3 * 100 + 1], 1000 - st.base);
  // steps: one extra point before each point, with the previous value
  const gs = st.packPoints(0, col, true);
  assert.equal(gs.n, 199);
  assert.equal(gs.f[3 * 2], 1); assert.equal(gs.f[3 * 2 + 1], 0 - st.base);
});

test('candles: groups like a higher timeframe, colours per bar', () => {
  const ti = new TimeIndex();
  const st = new SeriesStore(KIND_OHLC);
  const n = 10;
  st.alloc(n);
  for (let i = 0; i < n; i++) { st.t[i] = i * 60; st.o[i] = 100 + i; st.c[i] = 101 + i; st.h[i] = 105 + i; st.l[i] = 95 + i; }
  st.n = n;
  ti.rebuild([st.t.subarray(0, n)]);
  st.remap(ti);
  st.build();
  const cols = (i, up) => [up ? 1 : 2, 3, 4];
  const g = st.packOhlc(2, cols, 8); // groups 0-3, 4-7, 8-9
  assert.equal(g.n, 3);
  assert.equal(g.f[8 * 1], 5.5);
  assert.equal(g.f[8 * 1 + 1], 104 - st.base, 'open of the first bar');
  assert.equal(g.f[8 * 1 + 4], 108 - st.base, 'close of the last');
  assert.equal(g.f[8 * 1 + 2], 112 - st.base, 'massimo del gruppo');
  assert.equal(g.u[8 * 1 + 5], 1);
  assert.deepEqual(st.range(0, 9), [95, 114]);
});

test('TimeIndex: times that no series uses any more are removed (symbol change with less history)', () => {
  const ti = new TimeIndex();
  const a = [1, 2, 3, 4, 5], b = [3, 4, 5, 6];
  for (const t of a) assert.equal(ti.ref(t), true);
  for (const t of b) ti.ref(t);
  assert.equal(ti.ref(6), false); // already used by b
  ti.unref(6);
  // a leaves the scale: 1 and 2 stay without a series, 3-5 are still used by b
  const freed = a.filter((t) => ti.unref(t));
  assert.deepEqual(freed, [1, 2]);
  assert.equal(ti.prune(freed), true);
  assert.equal(ti.refs.has(1), false);
  assert.equal(ti.refs.get(3), 1);
  // a time freed and reused immediately by the same series does not count as removed
  const f2 = [3].filter((t) => ti.unref(t));
  ti.ref(3);
  assert.equal(ti.prune(f2), false);
});
