import { describe, it, expect } from "vitest";
import { fontCandidateUrls, loadFont, FontError, isTruetype } from "../src/fonts.js";

describe("isTruetype", () => {
  it("accepts the 0x00010000 sfnt version", () => {
    expect(isTruetype(new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x99]))).toBe(true);
  });

  it("accepts the OpenType 'OTTO' tag", () => {
    expect(isTruetype(new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x99]))).toBe(true);
  });

  it("rejects a woff2 payload", () => {
    expect(isTruetype(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBe(false);
  });

  it("rejects Google's /l/font kit format", () => {
    // Observed magic from the unknown-User-Agent fallback endpoint.
    expect(isTruetype(new Uint8Array([0x90, 0x73, 0x01, 0x00]))).toBe(false);
  });

  it("rejects bytes shorter than a magic number", () => {
    expect(isTruetype(new Uint8Array([0x00, 0x01]))).toBe(false);
  });
});

describe("fontCandidateUrls", () => {
  it("puts the static weight file ahead of the variable font", () => {
    const urls = fontCandidateUrls("Manrope", 700);
    const staticIdx = urls.findIndex((u) => u.includes("Manrope-Bold.ttf"));
    const variableIdx = urls.findIndex((u) => u.includes("Manrope%5Bwght%5D.ttf"));
    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(variableIdx).toBeGreaterThanOrEqual(0);
    expect(staticIdx).toBeLessThan(variableIdx);
  });

  it("maps weight 400 to the Regular filename", () => {
    expect(fontCandidateUrls("Manrope", 400).some((u) => u.includes("Manrope-Regular.ttf"))).toBe(true);
  });

  it("maps weight 600 to the SemiBold filename", () => {
    expect(fontCandidateUrls("Manrope", 600).some((u) => u.includes("Manrope-SemiBold.ttf"))).toBe(true);
  });

  it("strips spaces from multi-word families", () => {
    const urls = fontCandidateUrls("Noto Sans SC", 400);
    expect(urls[0]).toContain("/ofl/notosanssc/");
    expect(urls.some((u) => u.includes("NotoSansSC-Regular.ttf"))).toBe(true);
  });

  it("searches the ofl licence directory before apache and ufl", () => {
    const urls = fontCandidateUrls("Manrope", 400);
    expect(urls.findIndex((u) => u.includes("/ofl/"))).toBeLessThan(
      urls.findIndex((u) => u.includes("/apache/")),
    );
  });

  it("only produces raw.githubusercontent urls", () => {
    for (const url of fontCandidateUrls("Manrope", 400)) {
      expect(url.startsWith("https://raw.githubusercontent.com/google/fonts/")).toBe(true);
    }
  });
});

describe("loadFont", () => {
  it("resolves a Google family to real truetype bytes", async () => {
    const bytes = await loadFont({ family: "Manrope", weight: 700 });
    expect(isTruetype(bytes)).toBe(true);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("resolves a CJK family", async () => {
    const bytes = await loadFont({ family: "Noto Sans SC", weight: 400 });
    expect(isTruetype(bytes)).toBe(true);
  });

  it("rejects an unknown family with a 422", async () => {
    await expect(
      loadFont({ family: "ThisFontDoesNotExistAnywhere12345" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("surfaces an unknown family as a FontError", async () => {
    await expect(
      loadFont({ family: "ThisFontDoesNotExistAnywhere12345" }),
    ).rejects.toThrow(FontError);
  });

  it("fetches a caller-supplied font url directly", async () => {
    const bytes = await loadFont({
      family: "Manrope",
      url: "https://fonts.gstatic.com/s/manrope/v20/xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FO_F.ttf",
    });
    expect(isTruetype(bytes)).toBe(true);
  });

  it("rejects a caller-supplied url that is not a font", async () => {
    await expect(
      loadFont({ family: "X", url: "https://fonts.googleapis.com/css2?family=Manrope" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("caches resolved font bytes for a repeat load", async () => {
    const first = await loadFont({ family: "Manrope", weight: 400 });
    const second = await loadFont({ family: "Manrope", weight: 400 });
    expect(second.byteLength).toBe(first.byteLength);
    const anyCached = await Promise.all(
      fontCandidateUrls("Manrope", 400).map((u) => caches.default.match(u)),
    );
    expect(anyCached.some(Boolean)).toBe(true);
  });
});
