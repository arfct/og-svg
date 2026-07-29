# og-svg

A shared SVG→PNG renderer running on Cloudflare Workers. Built for generating Open Graph
link-preview images, but it does nothing OG-specific — SVG in, PNG out.

> **Status:** design complete, implementation not started.
> See [the design spec](docs/superpowers/specs/2026-07-29-og-svg-design.md).

## Why

Four projects each had their own rasterizer, and every one was blocked on a dead
dependency — `node-canvas` on Node 12, `sharp` in a Netlify Function, Deno `og_edge`. The
rasterizing step was identical in all of them; only the SVG authoring differed. This is that
step, extracted once.

## Interface

```
GET  /?<base64>                        SVG inlined in the query
GET  /svg:<base64>                     path form
GET  /png?s=<b64url>&w=1200&f=Manrope&bg=white
GET  /png?b=<b64url of brotli(svg)>    high-capacity variant
POST /png                              body = SVG, or {svg, ...opts} as JSON
GET  /health
```

Cloudflare-native callers can skip HTTP entirely and use the RPC method over a service
binding:

```js
const res = await env.RENDER.toPng(svg, { width: 1200, background: "white" })
```

Payload capacity, since Cloudflare caps URLs at 16 KB:

| Encoding | Usable raw SVG |
|---|---|
| plain base64 (`s=`) | ~12 KB |
| brotli + base64 (`b=`) | ~60–95 KB |
| `POST` body | up to 256 KB |

## Two things that will surprise you

**Embedded images must be `data:` URIs.** resvg has no network access inside the WASM
sandbox, so `<image href="https://example.com/photo.jpg">` renders *nothing* — silently, with
no error. Inline the bytes.

**Fonts are explicit.** There is no system font stack. `<text>` uses the bundled default
(Manrope) unless you name a family with `f=`, which is resolved from Google Fonts and cached.
Non-Latin text needs an explicit family — e.g. `f=Noto+Sans+SC` for Chinese.

## Consumers

| Project | How it calls |
|---|---|
| [tiny.gifts](https://tiny.gifts) | RPC over a service binding |
| [itty.bitty.site](https://itty.bitty.site) | inline SVG in the URL |
| [redirect.app](https://redirect.app) | inline SVG via an `svg:` marker |
| [timezone.fyi](https://timezone.fyi) | builds an SVG server-side, posts it |

## License

MIT
