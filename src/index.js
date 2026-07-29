/**
 * og-svg — SVG in, PNG out.
 *
 * Two doors onto the same renderer:
 *   - HTTP, for callers anywhere (Netlify functions, crawlers, curl)
 *   - `toPng` RPC, for Workers wired up with a service binding
 *
 * There is deliberately no authentication: these URLs land in `og:image`
 * attributes fetched by crawlers and are written by hand, so no caller can hold
 * a secret. Abuse is bounded by the size caps in decode.js/render.js, the
 * content-addressed cache below, and a rate-limiting rule on the route.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { decodePayload, PayloadError } from "./decode.js";
import { renderPng, RenderError, DEFAULT_FONT_FAMILY } from "./render.js";
import { loadFont, FontError } from "./fonts.js";
import manropeRegular from "../assets/manrope-regular.ttf";
import manropeBold from "../assets/manrope-bold.ttf";

const BUNDLED_FONTS = [new Uint8Array(manropeRegular), new Uint8Array(manropeBold)];

const IMMUTABLE = "public, max-age=31536000, immutable";
const CORS = { "Access-Control-Allow-Origin": "*" };

export default class extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true }, 200, { "Cache-Control": "no-store" });
    }

    try {
      const { svg, opts } = await parseRequest(request, url);
      return await this.renderCached(svg, opts);
    } catch (err) {
      return errorResponse(err);
    }
  }

  /**
   * RPC entry point. Returns a whole Response so a calling Worker can pass it
   * straight through with its content type and cache headers intact.
   *
   * @param {string} svg
   * @param {object} [opts] see render.js
   * @returns {Promise<Response>}
   */
  async toPng(svg, opts = {}) {
    return this.renderCached(svg, opts);
  }

  async renderCached(svg, opts) {
    const cache = caches.default;
    const key = await cacheKey(svg, opts);

    const hit = await cache.match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("X-Og-Cache", "hit");
      return res;
    }

    const fonts = await resolveFonts(opts);
    const png = await renderPng(svg, { ...opts, fonts });

    const headers = {
      "Content-Type": "image/png",
      "Cache-Control": IMMUTABLE,
      ...CORS,
    };

    // Stash a clean copy, then answer with the cache status attached.
    this.ctx.waitUntil(cache.put(key, new Response(png, { headers })));

    return new Response(png, {
      headers: { ...headers, "X-Og-Cache": "miss" },
    });
  }
}

async function resolveFonts(opts) {
  if (Array.isArray(opts.fonts) && opts.fonts.length) return opts.fonts;

  const family = opts.fontFamily;
  if (!family || family === DEFAULT_FONT_FAMILY) return BUNDLED_FONTS;

  const named = await loadFont({ family, weight: opts.fontWeight });
  // Keep the bundled faces as a fallback for glyphs the named font lacks.
  return [named, ...BUNDLED_FONTS];
}

async function parseRequest(request, url) {
  if (request.method === "POST") return parseBody(request);

  if (url.pathname === "/png") {
    return {
      svg: await decodePayload({
        s: url.searchParams.get("s") ?? undefined,
        z: url.searchParams.get("z") ?? undefined,
      }),
      opts: optsFromQuery(url.searchParams),
    };
  }

  if (url.pathname === "/") {
    // itty-bitty's convention: the whole raw query string is the payload.
    // Read url.search rather than searchParams so a standard-alphabet '+'
    // survives — searchParams would decode it to a space.
    return {
      svg: await decodePayload({ s: url.search.slice(1) || undefined }),
      opts: {},
    };
  }

  if (url.pathname.startsWith("/svg:")) {
    return {
      svg: await decodePayload({ s: url.pathname.slice(1) }),
      opts: optsFromQuery(url.searchParams),
    };
  }

  throw new PayloadError(404, "not_found", `No route for ${url.pathname}`);
}

async function parseBody(request) {
  const type = request.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch {
      throw new PayloadError(400, "bad_json", "Request body is not valid JSON");
    }
    if (typeof body.svg !== "string" || !body.svg.length) {
      throw new PayloadError(400, "empty_payload", "No svg field in the JSON body");
    }
    return { svg: body.svg, opts: normalizeOpts(body) };
  }

  const text = await request.text();
  if (!text.length) {
    throw new PayloadError(400, "empty_payload", "Empty request body");
  }
  return { svg: text, opts: {} };
}

function optsFromQuery(params) {
  return normalizeOpts({
    width: params.get("w"),
    height: params.get("h"),
    scale: params.get("scale"),
    background: params.get("bg"),
    fontFamily: params.get("f"),
    fontWeight: params.get("fw"),
  });
}

function normalizeOpts(raw) {
  const opts = {};
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  if (num(raw.width)) opts.width = num(raw.width);
  if (num(raw.height)) opts.height = num(raw.height);
  if (num(raw.scale)) opts.scale = num(raw.scale);
  if (raw.background) opts.background = String(raw.background);
  if (raw.fontFamily) opts.fontFamily = String(raw.fontFamily);
  if (num(raw.fontWeight)) opts.fontWeight = num(raw.fontWeight);
  if (Array.isArray(raw.fonts)) opts.fonts = raw.fonts;
  return opts;
}

async function cacheKey(svg, opts) {
  const material = JSON.stringify([svg, sortedOpts(opts)]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://og-svg.internal/c/${hex}`;
}

function sortedOpts(opts) {
  // Font buffers are not part of the identity — the family/weight that
  // produced them is, and those are plain values.
  const { fonts, ...rest } = opts;
  return Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
  });
}

function errorResponse(err) {
  const known =
    err instanceof PayloadError || err instanceof RenderError || err instanceof FontError;
  const status = known ? err.status : 500;
  const code = known ? err.code : "internal_error";
  const message = known ? err.message : "Unexpected error while rendering";

  // no-store matters: a cached 4xx would outlive the fix that resolves it.
  return json({ error: message, code }, status, { "Cache-Control": "no-store" });
}
