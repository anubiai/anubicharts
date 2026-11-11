# Derivation from Lightweight Charts, function by function (2026-11-10)

(The file name is kept from the original Italian version; the content below is the English translation.)

This file lists, for each part of the engine, whether it is original, was rewritten from pixel measurements of Lightweight Charts (LW), or
is still treated as a derived work of Lightweight Charts (Apache-2.0). Sources: the maintainers' internal measurement notes and two
reviews done by AI (Claude) sessions. "Status" is the verdict of the second review, updated after the fixes that followed it.

| Part | File | Declared status |
|---|---|---|
| Public interface (createChart, series, scales, panes, primitives, markers) | `lw.js` | **Follows the LW API** for compatibility (a documented interface) |
| `candleWidth`, `bodyShare` | `bars.js` | `bodyShare` is a table of 81 measured thresholds with interpolation (no formula); the case structure of `candleWidth` (fixed zone, parity) is similar to the original: **inspired** |
| `candleParts`, `candleRects` | `bars.js` | **Derived/inspired**: same order of passes, same wick and border rule (measured on pixels, but they coincide with the original's structure); text rewritten |
| `barWidth`, `barParts`, `barRects` | `bars.js` | Width re-expressed from measurements; tick threshold and ticks inside the stem equal to the original: **inspired** |
| `histGap`, `histColumns` | `bars.js` | **Derived/inspired**: gap, narrowing below 4 px and side choice coincide with the original |
| Histogram heights | `lw.js` `drawHistogram` | **Derived** (a few lines of arithmetic equal to the original) |
| `pointMarker` | `bars.js` | Radius and centre measured over 36 combinations; half-pixel correction in the odd case: **inspired** |
| `priceAxisWidth`, `timeAxisHeight`, `crossPriceLabel`, `crossTimeLabel`, `timeTickMinDist` | `lw.js` | Lines and formulas fitted to measurements (fixtures): **measured** |
| `measureAxis` | `lw.js` | Rewritten from measurements after the second review (all grid labels, no constants from the original source): **measured** |
| `niceStep`, `priceTicks`, `minMove` rule | `pricescale.js` | Table of steps measured, different algorithm; steps with `minMove` derived from 190 pixel comparisons: **measured** |
| `weightOf`, `TickIndex.pick`, time filling | `timeticks.js`, `lw.js` | Year, month, day, hour scheme common to every time axis; single level and filling measured with `tickMarkFormatter`: **measured/inspired** |
| `updateBase` (last-bar rule) | `lw.js` | Behaviour documented by the API (`shiftVisibleRangeOnNewBar`), threshold measured (rightOffset greater than -1): **measured** |
| Long press at 240 ms | `lw.js` `onDown` | Same value as LW, measured with synthetic events: **measured** |
| `dashPhases`, `dashOrigin` | `glx.js`, `lw.js` | Dash phase observed and verified over 72 combinations: **measured** |
| LOD (pyramid), GPU packets, WebGL (`gl*.js`, `glprim.js`), script primitives, interaction | various | Original work by AnubiAI |

All parts marked "derived/inspired" must be treated as derived works of Lightweight Charts (Apache-2.0): they keep the copyright and
license notice and the attribution note (see `NOTICE`).

The measurement fixtures used by the tests are in `test/fixtures/`: they contain numbers measured on LW's rendered output (pixel positions
and sizes), not LW source code.

This is **not** a clean-room implementation and no clean-room claim is made.
