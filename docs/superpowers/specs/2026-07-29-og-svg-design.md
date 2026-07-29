# og-svg — a shared SVG→PNG renderer on Cloudflare Workers

**Date:** 2026-07-29
**Status:** approved design, not yet implemented
**Repo:** `arfct/og-svg` (this repo)
**Consumers:** `tiny.gifts`, `itty-bitty`, `redirect-app`, `timezone.fyi`

## Problem

Four projects need to turn SVG into PNG for Open Graph link previews. Each has its own
half-working implementation, and every one is blocked on a dead dependency:

| Project | Current implementation | State |
|---|---|---|
| `tiny.gifts` | `node-canvas` in a Firebase Function | Works, but pinned to Node 12 — redeploys fail |
| `itty-bitty` | `sharp` in a Netlify Function | Renderer works; **every caller invokes it wrongly** |
| `redirect-app` | references `/.netlify/functions/rasterize` | **No such function exists in the repo** |
| `timezone.fyi` | Deno `og_edge` (disabled) + `node-canvas` | Both paths dead |

The rasterizing step is identical across all four. Only the SVG authoring differs.

## Findings from the survey

### The path-vs-query bug

Both `metadata.js` edge functions build the rasterize URL as a **path**:

```js
info.i = "/.netlify/functions/rasterize/" + info.i   // itty-bitty:59, redirect-app:89
```

`itty-bitty/functions/rasterize.js:5` reads only `event.rawQuery`. Verified against
production on 2026-07-29:

| URL form | Result |
|---|---|
| `/.netlify/functions/rasterize/svg:<b64>` (as callers build it) | `502` |
| `/.netlify/functions/rasterize?<b64>` (as the function reads it) | `200 image/jpeg`, 8707 bytes |

The rasterizer is fine; no caller has ever reached it correctly. Consequence: **there are no
existing users of the `svg:` og:image feature**, so we are not bound by its current output
format or behavior.

### Existing wire format

From `itty-bitty/functions/rasterize.js`, worth preserving because it is terse and
hand-writable:

- payload is the raw query string, `=` padding stripped
- base64 first, falling back to percent-decoding
- content not starting with `<svg` is auto-wrapped in `<svg xmlns="...">…</svg>`
- output resized to 1200px wide

`itty-bitty` already depends on `brotli-wasm` and uses brotli in its own data-URL encoding,
so a brotli-compressed payload variant fits that codebase's existing conventions.

### Platform split

Only `tiny.gifts` is moving to Cloudflare. `itty-bitty`, `redirect-app` and `timezone.fyi`
stay on Netlify. Three of four consumers therefore use the HTTP interface; RPC is a
`tiny.gifts`-only optimization, not the primary path.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Packaging | Standalone Worker, own repo, HTTP + RPC | resvg WASM lives in one place; one deploy upgrades all consumers |
| Primary interface | `GET` with SVG inlined in the URL | Crawlers fetch `og:image` via GET; URLs must stay hand-craftable |
| Auth | **None** | No caller can hold a secret — these URLs are consumed by Twitterbot/Slackbot/Discordbot and written by hand |
| Abuse control | Size caps + content-addressed cache + Cloudflare rate limiting | The only levers available without auth |
| Output format | PNG only in v1 | resvg emits PNG exclusively; all crawlers accept it; no existing JPEG users to preserve |
| Default font | Manrope Regular + Bold, Latin subset, bundled | `sharp`/librsvg picked up system fonts; resvg's fontdb starts empty, so `<text>` would silently render nothing. Manrope because `tiny.gifts` already uses it, so its previews finally match its cards |
| Host | `workers.dev` for now, via a single `RENDER_ORIGIN` constant | Dedicated domain deferred; switching is a one-line change per consumer |
| Plan | Workers Paid ($5/mo) | Free tier caps CPU at 10ms; rasterizing exceeds that |

### Why no auth is safe here

An SVG payload can contain `<script>`, but resvg ignores scripting entirely and has no
network access inside the WASM sandbox. The service never echoes the SVG back — only a
rendered PNG. So inline-SVG-in-URL introduces neither an XSS nor an SSRF surface. The
residual risk is CPU consumption, which is bounded by the caps below.

## Architecture

```
                     ┌──────────────────────────────┐
   itty-bitty ──HTTP─▶│                              │
 redirect-app ──HTTP─▶│  og-svg (Cloudflare Worker)  │
 timezone.fyi ──HTTP─▶│  decode → fonts → resvg      │
   tiny.gifts ───RPC─▶│         → cache              │
                     └──────────────────────────────┘
```

`og-svg` knows nothing about greeting cards, timezones, or link metadata. Each consumer
owns its own SVG authoring and passes a finished SVG string.

### Module layout

```
src/index.js    WorkerEntrypoint — fetch handler + toPng RPC method
src/decode.js   URL/body payload → SVG string
src/fonts.js    family name → TTF bytes, cached
src/render.js   resvg wrapper, option normalization, pixel cap
src/cache.js    content-addressed Cache API get/put
assets/         bundled default font
```

Each module is independently testable and has one job. `decode.js` and `render.js` are pure
functions of their inputs; `fonts.js` and `cache.js` own the two I/O paths.

## Interface

### RPC (Cloudflare-native consumers)

```js
toPng(svg: string, opts?: {
  width?: number,          // output px width; default: SVG intrinsic, else 1200
  height?: number,
  scale?: number,          // default 1
  background?: string,     // CSS color; default transparent
  fonts?: Array<
      { family: string, weight?: number, style?: 'normal'|'italic' }
    | { family: string, url: string }>,
  defaultFontFamily?: string,
}) => Response              // image/png with cache headers
```

Returns a whole `Response` rather than bytes — RPC supports it, and the caller can pass it
straight through with its content-type and cache headers intact. Callers wanting bytes use
`await res.arrayBuffer()`.

### HTTP

```
GET  /?<base64>                        same query convention as the old rasterize.js
GET  /svg:<base64>                     path form the metadata.js callers already emit
GET  /png?s=<b64url>&w=1200&f=Manrope&bg=white
GET  /png?b=<b64url of brotli(svg)>    high-capacity variant
POST /png                              body = SVG (image/svg+xml) or {svg, ...opts} (JSON)
GET  /health
```

All responses carry `Access-Control-Allow-Origin: *`, matching the headers `itty-bitty`
already sets for its `/render/*` and `/js/*` paths, so previews can be loaded in-page via
`<img>` as well as by crawlers.

### Payload capacity

Cloudflare's URL limit is **16 KB**. After origin and path overhead that is roughly:

| Encoding | Usable raw SVG |
|---|---|
| plain base64 (`s=`) | ~12 KB |
| brotli + base64 (`b=`) | ~60–95 KB |
| `POST` body | up to the 256 KB cap |

The `b=` variant ships in v1 rather than being deferred — `itty-bitty`'s content is exactly
the kind that benefits, and retrofitting an encoding across four consumers later is worse
than supporting it now.

### Decoding rules

Applied in order, carried over from `rasterize.js` plus the brotli addition:

1. Strip a leading `svg:` marker if present
2. Strip `=` padding; accept both base64 and base64url alphabets
3. If the `b=` param was used, brotli-decompress after base64-decoding
4. If base64 decoding fails, percent-decode instead
5. If the result does not start with `<svg`, wrap it in `<svg xmlns="http://www.w3.org/2000/svg">…</svg>`

## Fonts

resvg parses TTF/OTF. It does **not** parse woff2. The Google Fonts CSS2 API serves woff2 to
modern clients and TTF to legacy ones, so `fonts.js` requests the CSS with a legacy
User-Agent, extracts the `format('truetype')` URL, and fetches that.

This is the most fragile part of the system. It gets its own module and a test that asserts
the fetched bytes begin with a TTF magic number — not merely that the request succeeded,
which would let a silent woff2 regression pass.

Resolution order:

1. `{ family, url }` — fetch the caller's own TTF (also how a private font like
   `tiny.gifts`' Brillig would be used)
2. `{ family, weight, style }` — resolve via Google Fonts as above
3. Neither supplied — use the bundled default sans

Fonts are cached in the Cache API keyed by resolved URL, independently of render caching.

CJK requires an explicit `f=Noto+Sans+SC` (or equivalent); the bundled default is Latin.

## Caching and limits

Cache key is `sha256(svg + JSON.stringify(normalizedOpts))`, looked up in `caches.default`
under a synthetic URL. On a miss, render and `ctx.waitUntil(cache.put(...))`. Because the key
covers the entire input, successful responses ship
`Cache-Control: public, max-age=31536000, immutable`.

| Guard | Limit | Response |
|---|---|---|
| URL length | 16 KB | enforced by Cloudflare before we run |
| POST body / decoded SVG | 256 KB | `413` |
| Output pixels | 4,000,000 (e.g. 2000×2000) | `413` |
| resvg parse failure | — | `422` |
| Unresolvable named font | — | `422` |

A Cloudflare rate-limiting rule applies to cache misses only, so repeat traffic on valid
URLs is never throttled.

`<image href="https://…">` inside a payload renders nothing — resvg has no network access.
Embedded raster content must be a `data:` URI. This is documented prominently in the README
because it is non-obvious and silent.

## Failure behavior

Errors return JSON `{ error, code }` with **`Cache-Control: no-store`**. The no-store is
load-bearing: a cached 4xx would outlive the fix that resolves it. RPC throws instead of
returning an error response.

A crawler receiving a non-image shows no preview image and falls back to title and
description, which is the correct degradation. `tiny.gifts` additionally falls back to a
static `og-fallback.png` asset with a short TTL, as the consumer where a missing preview is
most visible.

## Consumer migration

Ordered — the renderer ships and is verified standalone before any consumer changes, since
none of them can be tested until it answers.

This design spans five repos and is deliberately **not** one implementation plan. It splits
into two substantial plans plus three trivial patches:

| Work | Shape |
|---|---|
| og-svg renderer | Its own plan — the bulk of the engineering |
| tiny.gifts port | Its own plan — platform migration, XSS fix, template rewrite |
| itty-bitty, redirect-app | One-line patches, no plan needed |
| timezone.fyi | Small patch — new template module plus a fetch |

### 1. og-svg (this repo)

Build, test, deploy to `workers.dev`. No consumers yet.

### 2. tiny.gifts

Clean replacement of Firebase; Firebase functions and both GitHub Actions are deleted in the
same change.

- `public/` becomes the Workers static-assets directory with `not_found_handling: "none"`,
  so path-based card URLs fall through to the Worker
- `src/index.js` — routes `/og`, `/image`, and a catch-all HTML shell
- `src/card-svg.js` — the card SVG template, replacing the `node-canvas` drawing
- `src/path-info.js` — deduplicates `infoForPath`, currently copy-pasted in
  `public/gift.js:23` and `functions/index.js:6` differing only by a `clean` flag
- **HTML escaping** on all interpolated path values, fixing the XSS at `functions/index.js:39-54`
- `/image` — guarded 302 per decision: require `https:`, reject IP literals and `localhost`,
  cap timeout and bytes, then redirect only if the scraped URL parses as https.
  `HTMLRewriter` replaces `cheerio`
- `stripes.svg` inlined as a `data:` URI in the card template
- **Deterministic tilt** from `hash(re)` replacing `Math.random()` at `functions/index.js:137`,
  or the content-addressed cache never hits
- Delete `public/old-puzzlebox.html` and `public/puzzlestar.svg` (dead, and would otherwise
  be uploaded as assets)

### 3. itty-bitty

One line at `netlify/edge-functions/metadata.js:59` — point at `${RENDER_ORIGIN}/png?s=` with
the payload as a query parameter, fixing the path-vs-query bug. Delete
`functions/rasterize.js` and drop the `sharp` dependency.

### 4. redirect-app

Same one-line fix at `netlify/edge-functions/metadata.js:89`. Since the repo never contained
a `rasterize.js`, this makes the `svg:` feature work for the first time.

### 5. timezone.fyi

Replace both dead paths with a `zones-svg.js` template plus a fetch to `RENDER_ORIGIN`.
Drops `canvas` and `og_edge`, and removes the
`edge_functions = "./netlify/edge-functions-disabled"` indirection in `netlify.toml`.

## Testing

Neither this repo nor `tiny.gifts` has tests today; this is greenfield.

`vitest` with `@cloudflare/vitest-pool-workers`, which runs tests inside workerd so the WASM
actually loads.

**og-svg:**

- `decode.js` — padded and unpadded base64, base64url, percent-encoded, `svg:` prefix,
  brotli, bare-fragment auto-wrap, oversized payload → 413
- `fonts.js` — fetched bytes begin with a TTF magic number; a named family resolves; an
  unknown family → 422
- `render.js` — PNG signature present and IHDR dimensions match the requested width; `<text>`
  renders non-blank using the default font; pixel cap enforced
- `cache.js` — a second identical request skips the renderer (spy on the render function)

No golden-image byte comparisons: resvg version bumps would churn them constantly. Assert
dimensions and non-blankness instead.

**tiny.gifts:**

- `infoForPath` round-trips, covering the `_`/`__` substitution and the base64 fragment with
  its every-300-character `_` insertion (`public/gift.js:51`) — the subtlest code in the repo
- the escape helper against `"><script>alert(1)</script>`
- `/image` rejects `http:`, IP literals, and `file:`
- `/og` returns a PNG against a stubbed service binding

## Out of scope

- **JPEG/WebP output.** Requires a second encoder pass. Revisit only if PNG size becomes a
  real problem for photo-like SVGs.
- **Satori / HTML-to-SVG layout.** Deliberately excluded: layout is per-project, and every
  current consumer either has hand-written SVG or a card simple enough to template as a
  string. A consumer wanting HTML layout can run Satori on its own side of the boundary and
  still call this service to rasterize.
- **Text wrapping and measurement.** The existing `node-canvas` code does not wrap either
  (`functions/index.js:159`), so templates keep manual `<tspan dy>` line breaks. Not a
  regression.
- **A dedicated domain.** `RENDER_ORIGIN` is a single constant per consumer; switching later
  is one line each.
- **CJK in the bundled default font.** Available on demand via `f=`, not bundled.

## Notes

`RENDER_ORIGIN` is set to the `workers.dev` hostname that `wrangler deploy` prints on first
deploy. It is defined once per consumer repo and referenced nowhere else.
