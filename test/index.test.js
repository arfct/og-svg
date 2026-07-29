import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="teal"/></svg>';

function b64(s) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

async function gzipB64(s) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(s));
  w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  return btoa(String.fromCharCode(...buf));
}

async function pngDims(res) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("GET /health", () => {
  it("reports ok", async () => {
    const res = await SELF.fetch("https://r.test/health");
    expect(res.status).toBe(200);
  });
});

describe("bare query form", () => {
  it("renders a png from a base64 query string", async () => {
    const res = await SELF.fetch(`https://r.test/?${b64(SVG)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("renders at the svg's intrinsic size by default", async () => {
    const res = await SELF.fetch(`https://r.test/?${b64(SVG)}`);
    expect(await pngDims(res)).toEqual({ width: 120, height: 60 });
  });
});

describe("svg: path form", () => {
  it("renders a png from a path payload", async () => {
    const res = await SELF.fetch(`https://r.test/svg:${b64(SVG)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("GET /png", () => {
  it("renders from the s param", async () => {
    const res = await SELF.fetch(`https://r.test/png?s=${encodeURIComponent(b64(SVG))}`);
    expect(res.status).toBe(200);
  });

  it("honours the w param", async () => {
    const res = await SELF.fetch(
      `https://r.test/png?s=${encodeURIComponent(b64(SVG))}&w=600`,
    );
    expect(await pngDims(res)).toEqual({ width: 600, height: 300 });
  });

  it("renders from a gzipped z param", async () => {
    const z = encodeURIComponent(await gzipB64(SVG));
    const res = await SELF.fetch(`https://r.test/png?z=${z}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("applies the bg param", async () => {
    const transparent = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>';
    const plain = await SELF.fetch(`https://r.test/png?s=${encodeURIComponent(b64(transparent))}`);
    const filled = await SELF.fetch(
      `https://r.test/png?s=${encodeURIComponent(b64(transparent))}&bg=red`,
    );
    const a = new Uint8Array(await plain.arrayBuffer());
    const b = new Uint8Array(await filled.arrayBuffer());
    expect(a.byteLength).not.toBe(b.byteLength);
  });

  it("renders text with a named font from the f param", async () => {
    const text =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">' +
      '<rect width="300" height="100" fill="white"/>' +
      '<text x="10" y="60" font-family="Manrope" font-size="40">Hi</text></svg>';
    const bare =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">' +
      '<rect width="300" height="100" fill="white"/></svg>';
    const withText = await SELF.fetch(
      `https://r.test/png?s=${encodeURIComponent(b64(text))}&f=Manrope`,
    );
    const without = await SELF.fetch(`https://r.test/png?s=${encodeURIComponent(b64(bare))}`);
    const a = new Uint8Array(await withText.arrayBuffer());
    const b = new Uint8Array(await without.arrayBuffer());
    expect(a.byteLength).toBeGreaterThan(b.byteLength);
  });
});

describe("POST /png", () => {
  it("accepts a raw svg body", async () => {
    const res = await SELF.fetch("https://r.test/png", {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: SVG,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("accepts a json body with options", async () => {
    const res = await SELF.fetch("https://r.test/png", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ svg: SVG, width: 240 }),
    });
    expect(await pngDims(res)).toEqual({ width: 240, height: 120 });
  });
});

describe("caching", () => {
  it("reports a miss then a hit for the same payload", async () => {
    const unique = SVG.replace("teal", "#123456");
    const url = `https://r.test/png?s=${encodeURIComponent(b64(unique))}`;
    const first = await SELF.fetch(url);
    const second = await SELF.fetch(url);
    expect(first.headers.get("x-og-cache")).toBe("miss");
    expect(second.headers.get("x-og-cache")).toBe("hit");
  });

  it("marks successful renders immutable", async () => {
    const res = await SELF.fetch(`https://r.test/?${b64(SVG)}`);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("allows cross-origin reads", async () => {
    const res = await SELF.fetch(`https://r.test/?${b64(SVG)}`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("errors", () => {
  it("returns 400 for a missing payload", async () => {
    const res = await SELF.fetch("https://r.test/png");
    expect(res.status).toBe(400);
  });

  it("returns 422 for malformed svg", async () => {
    const res = await SELF.fetch(`https://r.test/?${b64("<svg><unclosed")}`);
    expect(res.status).toBe(422);
  });

  it("returns a structured json error body", async () => {
    const res = await SELF.fetch("https://r.test/png");
    const body = await res.json();
    expect(body).toMatchObject({ code: expect.any(String), error: expect.any(String) });
  });

  it("never caches an error response", async () => {
    const res = await SELF.fetch("https://r.test/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for an unknown route", async () => {
    const res = await SELF.fetch("https://r.test/nope/deeper");
    expect(res.status).toBe(404);
  });
});
