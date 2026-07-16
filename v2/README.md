# liquiflow — Section Rendering API library

A dependency-free theme library (single file, no build step) that drives Shopify's
[Section Rendering API](https://shopify.dev/docs/api/section-rendering) through
`li-render-*` HTML attributes. It covers collection/search filtering, predictive
search, product recommendations, pagination/load-more and option-based product
rendering for high-variant products.

Include `index.js` as a theme asset (e.g. `{{ 'liquiflow.js' | asset_url | script_tag }}`).
It self-initialises on `DOMContentLoaded` and re-initialises sections on
`shopify:section:load` (Theme Editor).

---

## Public API: `window.liquiflow`

```js
window.liquiflow = {
  version,                       // "2.0.0"
  config,                        // global defaults (see below)
  state: { filters: { … } },     // active filters per section id
  cache,                         // in-memory result cache (LRU)
  instances,                     // initialised wrappers
  render(opts),                  // programmatic renderSection call
  refresh(),                     // re-scan the DOM and init new wrappers
}
```

### `config`

| Option           | Default                                                          | Description                                          |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `debug`          | `false`                                                          | Enable `console.warn` hints for misconfigured markup |
| `morph`          | `false`                                                          | Use morphing as the global default swap strategy     |
| `inputDebounce`  | `300`                                                            | Debounce (ms) for text inputs                        |
| `cacheLimit`     | `50`                                                             | Max number of cached section responses               |
| `reservedParams` | `['q','type','options[prefix]','options[unavailable_products]']` | Params kept when clearing all filters                |

---

## Events (on `document`, all `bubbles: true`)

Every render fires a **before** and an **after** event — both a generic one and a
type-specific one, so listeners can scope to a phase and/or a module.

| Event                                      | When                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `liquiflow:before-render`                  | Before every fetch (generic; `detail.type` names the module)                 |
| `liquiflow:{type}-before-render`           | Before a fetch, per module: `filter` / `search` / `recommended` / `paginate` |
| `liquiflow:sections-rendered`              | After every successful DOM swap (generic)                                    |
| `liquiflow:{type}-rendered`                | After a render, per module: `filter` / `search` / `recommended` / `paginate` |
| `liquiflow:before-product-sections-render` | Before a product option render                                               |
| `liquiflow:product-sections-rendered`      | After a product option render                                                |

> The product module keeps its own `before-product-sections-render` /
> `product-sections-rendered` pair (rather than the `{type}-before-render` scheme) to
> match the existing consumer contract (delivery time, product scripts, etc.).

### `event.detail`

Every rendered event carries `detail.morph` — `true` when existing DOM nodes were
kept (morphed), `false` when the content was replaced. Use it to decide whether a
third-party widget inside the swapped region needs a cheap refresh or a full
re-init:

```js
document.addEventListener('liquiflow:product-sections-rendered', (e) => {
  if (e.detail.morph) slider.update();   // same nodes kept
  else initSlider();                      // nodes replaced → re-init
});
```

`before-render` details also include `type`; `product-sections-rendered` includes
`sectionId` and the resolved `variantId`.

---

## Opt-in morphing

By default the DOM is swapped via `innerHTML`. Enable morphing (which preserves
focus, scroll position and input state) per wrapper:

```html
<div li-render-filter="wrapper" li-render-morph>…</div>
```

For stable node matching across reordered lists, set `id` or `li-render-key` on
the child elements.

Mark a JS-managed subtree (a slider, map, etc.) with `li-render-morph-ignore` to
leave it untouched during a morph — useful when a script has already rewritten the
markup and a diff against the server HTML would fight those transforms:

```html
<div class="slider" li-render-morph-ignore> … </div>
```

---

## Filter module

Wrapper: `li-render-filter="wrapper"`.

| Attribute (role)                               | Description                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `li-render-filter="filter"`                    | Filter control (checkbox/radio). Radios are unique automatically (they replace the value). |
| `li-render-filter="sort"`                      | Sort select → `sort_by` (always unique)                                                    |
| `li-render-filter="price-min"` / `"price-max"` | Price inputs (render only when the value actually changes)                                 |
| `li-render-filter="remove"`                    | Remove a single filter (`li-render-filter-value` = ready-made Liquid URL)                  |
| `li-render-filter="clear-all"`                 | Clear all filters (reserved params such as `q` are kept)                                   |
| `li-render-filter="submit-button"`             | Submit manually instead of live rendering                                                  |
| `li-render-filter="target"`                    | Optional inner region to swap                                                              |
| `li-render-filter="count-value"`               | Target for filter count values                                                             |

Parameter attributes on `filter` controls:

| Attribute                    | Default                                         |
| ---------------------------- | ----------------------------------------------- |
| `li-render-filter-name`      | – (e.g. `{{ filter_value.param_name }}`)        |
| `li-render-filter-value`     | – (e.g. `{{ filter_value.value }}`)             |
| `li-render-filter-count`     | – (e.g. `{{ filter_value.count }}`)             |
| `li-render-filter-trigger`   | `change` (`click` also supported)               |
| `li-render-filter-unique`    | Auto (radio/select = true); override explicitly |
| `li-render-filter-min-param` | `filter.v.price.gte`                            |
| `li-render-filter-max-param` | `filter.v.price.lte`                            |

### Delegation & detached controls (modals/drawers)

All filter interactions are delegated on `document` (not on the wrapper). This means
controls keep working **after a re-render** and **when moved out of the wrapper** —
e.g. a filter drawer that a modal library reparents to `<body>`. Filters work on any
page and with any number of instances.

Each control is routed to its filter instance by, in order:

1. the closest `[li-render-filter="wrapper"]` ancestor (when still in the subtree);
2. the closest `[li-render-filter-section="{{ section.id }}"]` ancestor — add this to
   a detached drawer when the page has **more than one** filter section;
3. the single filter instance on the page (no extra markup needed for the common case).

No re-init is needed after a render, even when a `target` is set. On `/search` the
`q` parameter is preserved.

---

## Search module (predictive search)

Wrapper: `li-render-search="wrapper"`, with `li-render-search="input"` and
`li-render-search="target"`. Uses `search/suggest`.

Resource configuration (on the wrapper): `li-render-search-type`,
`li-render-search-limit`, `li-render-search-limit-scope`,
`li-render-search-unavailable`, `li-render-search-fields`.

---

## Recommended module

Wrapper: `li-render-recommended="wrapper"`, optional `li-render-recommended="target"`.

| Attribute                       | Default                                        |
| ------------------------------- | ---------------------------------------------- |
| `li-render-recommended-path`    | – (`{{ routes.product_recommendations_url }}`) |
| `li-render-recommended-product` | – (`{{ product.id }}`)                         |
| `li-render-recommended-limit`   | `4`                                            |
| `li-render-recommended-intent`  | `related`                                      |

Loads initially and on `shopify:section:load` in the Theme Editor.

---

## Pagination / load-more module

Generic for products, blogs and any array.

| Attribute (role)               | Description                                          |
| ------------------------------ | ---------------------------------------------------- |
| `li-render-paginate="wrapper"` | Wrapper                                              |
| `li-render-paginate="list"`    | Items container (load-more appends here)             |
| `li-render-paginate="item"`    | A single item                                        |
| `li-render-paginate="button"`  | Load-more button (render only when `paginate.next`)  |
| `li-render-paginate="count"`   | Count display (template with `{loaded}` / `{total}`) |
| `li-render-paginate="total"`   | Hidden input holding the total count                 |
| `li-render-paginate="link"`    | Numbered pagination (the section is replaced)        |

| Attribute                         | Default                                       |
| --------------------------------- | --------------------------------------------- |
| `li-render-section-id`            | Section id (falls back to `.shopify-section`) |
| `li-render-paginate-page-param`   | `page`                                        |
| `li-render-paginate-loading-text` | Button text while loading                     |
| `li-render-paginate-count-text`   | Template for the count display                |

**Load-more** (button present) appends new items; **numbered pagination** (`link`)
replaces the section. The active filter query is preserved while paginating.

---

## Product module

Option-based rendering for [high-variant products](https://shopify.dev/docs/storefronts/themes/product-merchandising/variants/support-high-variant-products):
renders with **option value IDs (`option_values`)** instead of a variant ID.

Wrapper: `li-render-product="wrapper"`.

| Attribute                              | Description                                                       |
| -------------------------------------- | ----------------------------------------------------------------- |
| `li-render-section-id`                 | Section id (falls back to `.shopify-section`)                     |
| `li-render-product-url`                | Product URL (`{{ product.url }}`)                                 |
| `li-render-product-option-id`          | Option value id on the input/`<option>` (`{{ option_value.id }}`) |
| `li-render-product-option-select`      | Marks a `<select>` as an option picker                            |
| `li-render-product-url` (on the input) | Combined listings: `{{ option_value.product_url }}`               |
| `li-render-product-replace="NAME"`     | Region to swap (present in the wrapper and the response)          |
| `li-render-product-variant-id`         | Element carrying the resolved variant id (for URL sync)           |

Flow on option change: collect the checked/selected ids → fetch
`{product_url}?section_id=…&option_values=id1,id2` → replace (or morph) the marked
regions → update `variant` in the address bar. For **combined listings** (a
different `product_url`) the whole product section is swapped.

---

## Migration from v1

- `li-render-custom*` → product module (`li-render-product*`). `liquify:custom-rendered` is removed.
- **Namespace rename:** all events moved from `liquify:*` to `liquiflow:*`. Any theme
  code listening to the old names must be updated (filter/search/recommended/
  sections consumers).
- Consumers of `liquiflow:product-sections-rendered` (delivery time, swiper, etc.)
  are served by the new product module.
- Per-theme `load-more.js` can be replaced by the pagination module.
