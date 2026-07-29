/**
 * Turns a URL or body payload into an SVG string.
 *
 * Decoding rules, in order:
 *   1. strip a leading `svg:` marker
 *   2. base64 (padded, unpadded, or base64url) — or gzip+base64 via the `z` param
 *   3. percent-decoding, if base64 fails
 *   4. wrap in an `<svg>` root if the result is a bare fragment
 */

export const MAX_SVG_BYTES = 256 * 1024;

/**
 * Default viewport for a bare fragment. A wrapper with no width/height leaves
 * resvg with a 0×0 canvas, so one is required — 1200×630 is the Open Graph
 * standard and matches the 1200px width the previous Netlify rasterizer used.
 */
const DEFAULT_VIEWPORT = { width: 1200, height: 630 };

const SVG_ROOT_OPEN =
  `<svg xmlns="http://www.w3.org/2000/svg" ` +
  `width="${DEFAULT_VIEWPORT.width}" height="${DEFAULT_VIEWPORT.height}">`;

export class PayloadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PayloadError";
    this.status = status;
    this.code = code;
  }
}

function fromBase64(input) {
  // Accept both the standard and URL-safe alphabets, with or without padding.
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads a stream into bytes, aborting past `limit`.
 * Bounded because a small gzip payload can expand without limit.
 */
async function readCapped(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new PayloadError(413, "payload_too_large", `Decoded payload exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  try {
    return await readCapped(ds.readable, MAX_SVG_BYTES);
  } catch (err) {
    if (err instanceof PayloadError) throw err;
    throw new PayloadError(422, "bad_gzip", "Payload is not valid gzip data");
  }
}

function ensureRoot(svg) {
  if (svg.trimStart().startsWith("<svg")) return svg;
  return `${SVG_ROOT_OPEN}${svg}</svg>`;
}

/**
 * @param {{ s?: string, z?: string }} params
 * @returns {Promise<string>} the SVG document
 */
export async function decodePayload(params) {
  const gzipped = typeof params.z === "string" && params.z.length > 0;
  let raw = gzipped ? params.z : params.s;

  if (typeof raw !== "string" || raw.length === 0) {
    throw new PayloadError(400, "empty_payload", "No SVG payload supplied");
  }

  if (raw.startsWith("svg:")) raw = raw.slice(4);
  raw = raw.replace(/=+$/, "");

  if (raw.length === 0) {
    throw new PayloadError(400, "empty_payload", "No SVG payload supplied");
  }

  let svg;
  if (gzipped) {
    let bytes;
    try {
      bytes = fromBase64(raw);
    } catch {
      throw new PayloadError(422, "bad_gzip", "Gzip payload is not valid base64");
    }
    svg = new TextDecoder().decode(await gunzip(bytes));
  } else {
    try {
      svg = new TextDecoder().decode(fromBase64(raw));
    } catch {
      // Not base64 — treat it as percent-encoded or literal text.
      try {
        svg = decodeURIComponent(raw);
      } catch {
        svg = raw;
      }
    }
  }

  if (svg.length > MAX_SVG_BYTES) {
    throw new PayloadError(
      413,
      "payload_too_large",
      `Decoded payload exceeds ${MAX_SVG_BYTES} bytes`,
    );
  }

  return ensureRoot(svg);
}
