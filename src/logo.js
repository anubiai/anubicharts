/**
 * Anubi mark shown as the attribution logo (bottom-left of the first pane), the way Lightweight Charts shows its own.
 * Turn it off with `layout: { attributionLogo: false }`.
 */
export const MARK_VIEWBOX = "11.5 2 40.95 59.95";
export const MARK_PATH = "M23.45 2.00 L17.24 19.66 L21.45 27.87 L23.04 25.35 L19.81 19.04 L23.04 5.90 L24.79 23.71 L22.79 27.97 L27.92 30.95 L29.51 34.49 L22.27 29.25 L22.12 34.59 L26.89 39.16 L29.00 45.42 L31.51 45.63 L29.31 43.21 L29.82 41.83 L34.18 41.83 L34.69 43.21 L32.44 44.45 L34.18 45.99 L37.31 38.80 L41.88 34.54 L41.73 29.25 L34.49 34.44 L35.98 31.00 L41.21 27.92 L39.16 23.71 L40.91 5.90 L44.09 18.83 L40.91 25.35 L42.50 27.87 L46.70 19.66 L40.29 2.00 L35.26 20.02 L38.60 24.33 L34.18 20.94 L29.77 20.94 L25.40 24.38 L28.69 20.02 Z M26.79 24.94 L28.95 24.89 L31.97 28.33 L35.00 24.89 L37.16 24.94 L31.97 31.05 Z M23.81 31.05 L26.17 32.18 L27.41 32.95 L28.18 33.77 L28.69 34.69 L29.97 36.03 L30.02 36.39 L29.72 38.70 L29.36 36.44 L28.95 35.72 L28.02 34.90 L26.38 34.64 L25.56 34.28 L25.15 33.98 L24.63 33.41 L24.22 32.69 L23.76 31.26 Z M40.14 31.10 L40.19 31.31 L39.78 32.59 L39.21 33.57 L38.70 34.08 L37.57 34.64 L35.93 34.90 L35.00 35.72 L34.64 36.34 L34.23 38.70 L33.92 36.29 L34.03 35.98 L35.36 34.59 L35.82 33.72 L36.54 32.95 L37.77 32.18 Z M31.97 22.68 L33.77 24.17 L33.77 24.28 L31.97 26.59 L30.18 24.28 L30.18 24.22 L30.54 23.86 Z M22.58 36.90 L22.84 40.55 L23.76 43.57 L32.03 56.76 L40.24 43.52 L41.16 40.55 L41.42 36.90 L38.03 40.03 L36.59 44.70 L33.62 47.63 L32.38 47.73 L30.33 47.63 L27.30 44.60 L25.97 40.08 Z M17.24 50.14 L22.38 54.51 L25.51 54.51 L32.03 61.95 L38.44 54.51 L41.57 54.46 L46.70 50.09 L37.88 50.09 L31.97 59.13 L25.97 50.09 Z M39.21 47.89 L49.22 47.89 L52.45 45.37 L52.04 44.40 L41.47 44.40 Z M11.50 45.32 L11.60 45.52 L13.04 46.50 L14.78 47.94 L24.63 47.94 L22.48 44.45 L11.85 44.45 Z M12.62 42.29 L20.43 42.34 L21.61 42.24 L21.14 40.49 L20.94 39.11 L14.06 39.11 Z M42.29 42.24 L47.47 42.29 L51.22 42.19 L49.84 39.06 L42.96 39.06 L42.70 40.80 Z M15.04 36.80 L20.79 36.85 L21.04 33.77 L16.42 33.77 Z M42.91 33.77 L43.11 36.80 L48.86 36.75 L47.53 33.72 Z M19.66 26.69 L18.48 29.10 L18.22 29.77 L18.07 29.97 L17.30 31.67 L17.35 31.72 L21.20 31.72 L21.35 30.38 L21.35 28.69 Z M44.29 26.69 L42.60 28.69 L42.60 30.08 L42.75 31.67 L46.60 31.67 L46.45 31.20 L44.81 27.77 L44.60 27.20 Z";

export function createLogo() {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:absolute;z-index:3;pointer-events:none;opacity:.6;display:none";
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;overflow:visible"><path fill="#fff" stroke="#131722" stroke-width="2" stroke-linejoin="round" paint-order="stroke" vector-effect="non-scaling-stroke" fill-rule="evenodd" d="${MARK_PATH}"/></svg>`;
  return el;
}

/** Puts the logo at the bottom-left of the first pane; hides it if there is no room or the option is off. */
export function placeLogo(el, on, left, paneTop, paneH, width = 34, height = 45, margin = 10) {
  const ok = on && paneH > height + margin * 2;
  el.style.display = ok ? "block" : "none";
  if (!ok) return;
  el.style.height = height + "px";
  el.style.width = width + "px";
  el.style.left = left + margin + "px";
  el.style.top = paneTop + paneH - height - margin + "px";
}
