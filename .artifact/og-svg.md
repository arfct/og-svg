---
title: og-svg
date: 2026-07
status: released
category: infrastructure
tags: [web]
url: https://github.com/arfct/og-svg
links:
  source: https://github.com/arfct/og-svg
media:
  - src: tiny-gifts-card.png
    caption: The preview image tiny.gifts serves for a gift with no message, an SVG rasterized by og-svg with its text in the bundled Manrope
    alt: A white card reading A tiny.gift for you in black type, tilted slightly on a pale grey starburst
unconfirmed: [date, status]
---

Four projects each drew their link-preview images with a rasterizer of their own, and every one of those was blocked on a dead dependency, before og-svg took over the step they had in common. It is a Cloudflare Worker that takes an SVG and returns a PNG. Composing the SVG stays with the caller, who sends it in the address, as base64 or as brotli-compressed base64, or posts it as a request body of up to 256 KB; another Worker can skip HTTP and call og-svg through a service binding.

Rendering is done by resvg compiled to WebAssembly, and two things follow for whoever writes the SVG. There is no system font stack, so text is set in the bundled Manrope unless a family is named, in which case the font is fetched from the google/fonts repository and cached. An embedded image must be a data URI, because resvg cannot reach the network from inside its sandbox, and one given as a web address renders as nothing, with no error.

The service asks for no key, because its addresses end up in the og:image tags of public pages, where a caller has nowhere to keep a secret. Abuse is bounded by caps on the size of the SVG and of the output and by a cache keyed on a hash of the SVG and its options. tiny.gifts calls og-svg over a service binding, and the image is the card it returns; itty.bitty.site and redirect.app call it over HTTP.

JavaScript, WebAssembly, Cloudflare Workers. 2026.
