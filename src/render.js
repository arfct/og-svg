/**
 * Rasterizes an SVG document to PNG bytes using resvg (WASM).
 *
 * resvg has no network access and no system fonts. Consequences:
 *   - `<image href="https://…">` renders nothing; embed raster data as a `data:` URI
 *   - `<text>` renders nothing unless font bytes are supplied via `opts.fonts`
 */

import { Resvg } from "@cf-wasm/resvg/workerd";

/** 4M pixels — e.g. 2000×2000. Guards CPU on a metered plan. */
export const MAX_OUTPUT_PIXELS = 4_000_000;

export const DEFAULT_FONT_FAMILY = "Manrope";

export class RenderError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RenderError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {string} svg
 * @param {{
 *   width?: number,
 *   height?: number,
 *   scale?: number,
 *   background?: string,
 *   fonts?: Uint8Array[],
 *   defaultFontFamily?: string,
 * }} [opts]
 * @returns {Promise<Uint8Array>} PNG bytes
 */
export async function renderPng(svg, opts = {}) {
  const fitTo = resolveFitTo(opts);

  const options = {
    fitTo,
    font: {
      fontBuffers: opts.fonts ?? [],
      defaultFontFamily: opts.defaultFontFamily ?? DEFAULT_FONT_FAMILY,
      loadSystemFonts: false,
    },
  };
  if (opts.background) options.background = opts.background;

  let resvg;
  try {
    resvg = await Resvg.async(svg, options);
  } catch (err) {
    throw new RenderError(422, "bad_svg", `Could not parse SVG: ${err.message}`);
  }

  // resvg.width/height are the SVG's *intrinsic* size. The output size depends
  // on fitTo, so project it before rendering — the cap exists to avoid spending
  // the CPU in the first place.
  const [outWidth, outHeight] = projectSize(fitTo, resvg.width, resvg.height);
  if (outWidth * outHeight > MAX_OUTPUT_PIXELS) {
    resvg.free?.();
    throw new RenderError(
      413,
      "output_too_large",
      `Output of ${outWidth}×${outHeight} exceeds ${MAX_OUTPUT_PIXELS} pixels`,
    );
  }

  try {
    const image = resvg.render();
    const png = image.asPng();
    image.free?.();
    return png;
  } catch (err) {
    throw new RenderError(422, "render_failed", `Could not render SVG: ${err.message}`);
  } finally {
    resvg.free?.();
  }
}

/** Projects the rendered output size for a fitTo mode against an intrinsic size. */
function projectSize(fitTo, intrinsicWidth, intrinsicHeight) {
  const ratio = intrinsicHeight / intrinsicWidth;
  switch (fitTo.mode) {
    case "width":
      return [fitTo.value, Math.round(fitTo.value * ratio)];
    case "height":
      return [Math.round(fitTo.value / ratio), fitTo.value];
    case "zoom":
      return [
        Math.round(intrinsicWidth * fitTo.value),
        Math.round(intrinsicHeight * fitTo.value),
      ];
    default:
      return [intrinsicWidth, intrinsicHeight];
  }
}

function resolveFitTo(opts) {
  if (opts.width) return { mode: "width", value: Math.round(opts.width) };
  if (opts.height) return { mode: "height", value: Math.round(opts.height) };
  if (opts.scale && opts.scale !== 1) return { mode: "zoom", value: opts.scale };
  return { mode: "original" };
}
