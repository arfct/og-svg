/**
 * Resolves font families to TrueType bytes for resvg.
 *
 * resvg parses TTF/OTF and *not* woff2.
 *
 * The obvious approach — asking the Google Fonts CSS2 API for TrueType by
 * sending a legacy User-Agent — does NOT work from inside a Worker. Workers
 * control their own User-Agent, so Google always answers with its
 * unknown-agent `/l/font?kit=…` endpoint, whose payload begins `90 73 01 00`
 * and is not an sfnt at all. Verified from workerd on 2026-07-29.
 *
 * Instead we read TrueType straight out of the google/fonts repository over
 * raw.githubusercontent.com, which does no content negotiation.
 */

const RAW_BASE = "https://raw.githubusercontent.com/google/fonts/main";

/** google/fonts groups families by licence directory. */
const LICENCE_DIRS = ["ofl", "apache", "ufl"];

const WEIGHT_NAMES = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export class FontError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "FontError";
    this.status = status;
    this.code = code;
  }
}

/** True if the bytes begin with an sfnt version resvg can parse. */
export function isTruetype(bytes) {
  if (!bytes || bytes.byteLength < 4) return false;
  const [a, b, c, d] = bytes;
  if (a === 0x00 && b === 0x01 && c === 0x00 && d === 0x00) return true; // TrueType
  if (a === 0x4f && b === 0x54 && c === 0x54 && d === 0x4f) return true; // 'OTTO'
  if (a === 0x74 && b === 0x72 && c === 0x75 && d === 0x65) return true; // 'true'
  return false;
}

function nearestWeightName(weight) {
  const target = Number(weight) || 400;
  const available = Object.keys(WEIGHT_NAMES).map(Number);
  const closest = available.reduce((best, w) =>
    Math.abs(w - target) < Math.abs(best - target) ? w : best,
  );
  return WEIGHT_NAMES[closest];
}

/**
 * Candidate raw URLs for a family, most-preferred first.
 *
 * Static per-weight files come before the variable font: fontdb exposes a
 * variable font as its default instance, so a static Bold renders bold where
 * `Manrope[wght].ttf` may not.
 */
export function fontCandidateUrls(family, weight = 400) {
  const slug = family.trim().toLowerCase().replace(/\s+/g, "");
  const camel = family.trim().replace(/\s+/g, "");
  const weightName = nearestWeightName(weight);
  const variable = `${encodeURIComponent(`${camel}[wght]`)}.ttf`;

  const urls = [];
  for (const dir of LICENCE_DIRS) {
    urls.push(
      `${RAW_BASE}/${dir}/${slug}/static/${camel}-${weightName}.ttf`,
      `${RAW_BASE}/${dir}/${slug}/${camel}-${weightName}.ttf`,
      `${RAW_BASE}/${dir}/${slug}/${variable}`,
    );
  }
  return urls;
}

async function cachedFetch(url) {
  const cache = caches.default;
  const hit = await cache.match(url);
  if (hit) return hit;

  const res = await fetch(url);
  if (!res.ok) return res;

  const cacheable = new Response(res.body, res);
  cacheable.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  await cache.put(url, cacheable.clone());
  return cacheable;
}

/**
 * @param {{ family: string, weight?: number, url?: string }} spec
 * @returns {Promise<Uint8Array>} TrueType bytes
 */
export async function loadFont(spec) {
  if (spec.url) {
    const res = await cachedFetch(spec.url);
    if (!res.ok) {
      throw new FontError(
        422,
        "font_unavailable",
        `Font fetch failed for ${spec.url}: HTTP ${res.status}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isTruetype(bytes)) {
      throw new FontError(
        422,
        "font_not_truetype",
        `${spec.url} is not TrueType or OpenType`,
      );
    }
    return bytes;
  }

  for (const url of fontCandidateUrls(spec.family, spec.weight)) {
    const res = await cachedFetch(url);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (isTruetype(bytes)) return bytes;
  }

  throw new FontError(
    422,
    "font_unknown",
    `No TrueType source found in google/fonts for "${spec.family}"`,
  );
}
