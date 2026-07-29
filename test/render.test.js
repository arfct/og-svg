import { describe, it, expect } from "vitest";
import { renderPng, RenderError, MAX_OUTPUT_PIXELS } from "../src/render.js";
import manropeRegular from "../assets/manrope-regular.ttf";

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';

const withText = (text) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">` +
  `<rect width="400" height="200" fill="white"/>` +
  (text ? `<text x="20" y="100" font-family="Manrope" font-size="48" fill="black">${text}</text>` : "") +
  `</svg>`;

function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR width/height are the two big-endian uint32s at offsets 16 and 20.
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isPng(bytes) {
  return (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  );
}

describe("renderPng", () => {
  it("returns bytes with a PNG signature", async () => {
    const out = await renderPng(SQUARE);
    expect(isPng(out)).toBe(true);
  });

  it("renders at the SVG's intrinsic size when no width is given", async () => {
    const out = await renderPng(SQUARE);
    expect(pngSize(out)).toEqual({ width: 100, height: 100 });
  });

  it("scales to a requested width, preserving aspect ratio", async () => {
    const out = await renderPng(SQUARE, { width: 600 });
    expect(pngSize(out)).toEqual({ width: 600, height: 600 });
  });

  it("rejects an output larger than the pixel cap", async () => {
    const width = Math.ceil(Math.sqrt(MAX_OUTPUT_PIXELS)) + 1000;
    await expect(renderPng(SQUARE, { width })).rejects.toMatchObject({ status: 413 });
  });

  it("sizes a sizeless SVG from its content bounding box", async () => {
    // resvg does not fail on a missing width/height — it shrink-wraps the
    // content, giving a canvas far smaller than any useful preview. That is
    // why decode.js gives wrapped fragments an explicit 1200x630 viewport.
    const sizeless = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
    const { width, height } = pngSize(await renderPng(sizeless));
    expect(width).toBeLessThan(100);
    expect(height).toBeLessThan(100);
  });

  it("rejects malformed SVG with a 422", async () => {
    await expect(renderPng("<svg><unclosed")).rejects.toMatchObject({ status: 422 });
  });

  it("surfaces malformed SVG as a RenderError", async () => {
    await expect(renderPng("<svg><unclosed")).rejects.toThrow(RenderError);
  });

  it("draws glyphs when a font buffer is supplied", async () => {
    const fonts = [new Uint8Array(manropeRegular)];
    const blank = await renderPng(withText(null), { fonts });
    const lettered = await renderPng(withText("Hello"), { fonts });
    // Glyphs add real detail, so the compressed PNG must grow.
    expect(lettered.byteLength).toBeGreaterThan(blank.byteLength);
  });

  it("draws nothing for text when no font is available", async () => {
    const blank = await renderPng(withText(null), { fonts: [] });
    const lettered = await renderPng(withText("Hello"), { fonts: [] });
    expect(lettered.byteLength).toBe(blank.byteLength);
  });

  it("applies a background colour beneath the SVG", async () => {
    const transparent = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"></svg>';
    const plain = await renderPng(transparent);
    const filled = await renderPng(transparent, { background: "rgb(0,128,255)" });
    expect(filled).not.toEqual(plain);
  });
});
