# Section Rendering API

A dependency-free theme library that drives Shopify's Section Rendering API through
`li-render-*` HTML attributes (filtering, predictive search, recommendations,
pagination and option-based product rendering).

This repo keeps two versions side by side:

| Version | Path | Global | Events | Status |
|---|---|---|---|---|
| **v1** | [`v1/index.js`](v1/index.js) | – (no global) | `liquify:*` | Legacy — kept for existing themes |
| **v2** | [`v2/index.js`](v2/index.js) · [`v2/README.md`](v2/README.md) | `window.liquiflowRenderer` | `liquiflow:*` | Current — modular rewrite |

> The asset paths moved into `v1/` and `v2/` folders, so update the asset URL in
> your theme accordingly.

## v2 highlights

- Modular core with `window.liquiflowRenderer` (config, state, cache, instances).
- Filters delegated on `document`, so they work after re-renders **and** when a
  drawer is reparented to `<body>`, on any page and any number of instances.
- Result cache (LRU), working `AbortController`, opt-in DOM morphing.
- Pagination / load-more module (products, blogs, any array).
- Option-based product rendering (`option_values`) for high-variant products and
  combined listings — replaces v1's custom wrapper.
- Symmetric per-module render events (`{type}-before-render` / `{type}-rendered`).

See [`v2/README.md`](v2/README.md) for the full attribute and event reference.
