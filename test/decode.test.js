import { describe, it, expect } from "vitest";
import { decodePayload, PayloadError } from "../src/decode.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

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

describe("decodePayload", () => {
  it("decodes padded base64", async () => {
    expect(await decodePayload({ s: b64(SVG) })).toBe(SVG);
  });

  it("decodes base64 with = padding stripped", async () => {
    const stripped = b64(SVG).replace(/=/g, "");
    expect(await decodePayload({ s: stripped })).toBe(SVG);
  });

  it("decodes the base64url alphabet", async () => {
    const urlSafe = b64(SVG).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    expect(await decodePayload({ s: urlSafe })).toBe(SVG);
  });

  it("falls back to percent-decoding when the payload is not base64", async () => {
    expect(await decodePayload({ s: encodeURIComponent(SVG) })).toBe(SVG);
  });

  it("strips a leading svg: marker", async () => {
    expect(await decodePayload({ s: "svg:" + b64(SVG) })).toBe(SVG);
  });

  it("decodes a gzipped payload from the z param", async () => {
    expect(await decodePayload({ z: await gzipB64(SVG) })).toBe(SVG);
  });

  it("wraps a bare fragment in an svg root element", async () => {
    const out = await decodePayload({ s: b64('<rect width="5" height="5"/>') });
    expect(out).toContain('<rect width="5" height="5"/>');
    expect(out.startsWith("<svg")).toBe(true);
    expect(out.endsWith("</svg>")).toBe(true);
  });

  it("gives a wrapped fragment a default viewport", async () => {
    // Without one, resvg computes a 0x0 canvas and the render fails.
    const out = await decodePayload({ s: b64('<circle cx="60" cy="60" r="50"/>') });
    expect(out).toContain('width="1200"');
    expect(out).toContain('height="630"');
  });

  it("leaves an svg that declares its own size untouched", async () => {
    const sized = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';
    expect(await decodePayload({ s: b64(sized) })).toBe(sized);
  });

  it("passes through a raw unencoded svg string", async () => {
    expect(await decodePayload({ s: SVG })).toBe(SVG);
  });

  it("rejects a payload over the size cap", async () => {
    const huge = "<svg>" + "x".repeat(300_000) + "</svg>";
    await expect(decodePayload({ s: huge })).rejects.toThrow(PayloadError);
  });

  it("reports the size cap breach as a 413", async () => {
    const huge = "<svg>" + "x".repeat(300_000) + "</svg>";
    await expect(decodePayload({ s: huge })).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an empty payload", async () => {
    await expect(decodePayload({})).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a gzip payload that is not valid gzip", async () => {
    await expect(decodePayload({ z: b64("not gzipped at all") })).rejects.toMatchObject({
      status: 422,
    });
  });
});
