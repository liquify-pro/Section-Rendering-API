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

## Public API: `window.liquiflowRenderer`

```js
window.liquiflowRenderer = {
  version,                       // "2.1.0"
  config,                        // global defaults (see below)
  state: { filters: { … } },     // active filters per section id
  cache,                         // in-memory result cache (LRU)
  instances,                     // initialised wrappers
  render(opts),                  // programmatic renderSection call
  refresh(),                     // re-scan the DOM and init new wrappers
  product, pagination,           // the modules, for inspection in the console
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

## Value sync (`li-render-source` → `li-render-target`)

After **every** render (filter, search, product, pagination) named values are copied
out of the response into live elements anywhere on the page — even outside the
swapped region. Use it for things like a product count shown next to a filter button
or in a drawer header. Replaces v1's `li-render-custom-source` / `-target`.

```html
<!-- In the rendered section (the response): the value carrier -->
<span li-render-source="count">{{ collection.products_count }} products</span>

<!-- Anywhere on the page: the live target(s) that receive it -->
<span li-render-target="count"></span>
```

- The v1 names `li-render-custom-source` / `li-render-custom-target` are accepted
  as aliases, and may be mixed with the new ones.
- The **source** value is the element's `value` (for `input`/`select`/`textarea`)
  or its trimmed `textContent`.
- Each **target** writes as `textContent` by default. Set `li-render-target-mode`
  to `html` (innerHTML) or to any attribute name (e.g. `title`, `aria-label`) to
  write there instead.
- Multiple targets may share one name. Writes are skipped when the value is
  unchanged, so untouched targets never trigger a reflow.

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
| `li-render-paginate-batch`        | Fixed items per view/click (see below)        |

**Load-more** (button present) appends new items; **numbered pagination** (`link`)
replaces the section. The active filter query is preserved while paginating.

Clicks are delegated on `document` and call `preventDefault()`, so an `<a>` or a
submit button works as the trigger and keeps working after a filter/sort re-render
replaces it. The next-page counter is stored on the wrapper.

Load-more writes the loaded `?page=N` into the address bar (via `replaceState`, so
back/forward and deep links work); changing a filter clears `page` again. On a
reload/deep-link to `?page=N`, Shopify renders only page N, so on init the module
fetches pages `1..N-1` and prepends them — the full accumulated range is restored.

### Fixed batch size (`li-render-paginate-batch`)

A Shopify page holds N **products**, but a section may expand each product into a
varying number of **items** — a tile per colour variant, one row per size, a card
per bundle option. Paginating by page then produces ragged batches: 12 products can
be 12 tiles or 40, and every click grows the grid by a different amount.

Set a batch size on the wrapper and the module renders exactly that many items per
view and per click instead:

```html
<div li-render-paginate="wrapper" li-render-paginate-batch="24"> … </div>
```

A page's surplus items are parked in a buffer and handed out on the following
clicks; when the buffer runs short the module fetches further pages until it can
serve a full batch. The server-rendered first view is levelled the same way — the
surplus is moved into the buffer, and if Liquid produced *fewer* items than one
batch the module tops up from the next page. The last batch is short, because the
source is exhausted.

Keep `{% paginate … by %}` **at or above** the batch size; then page one already
over-produces and no extra request is needed on load. Deep links stay batch-aligned:
after restoring pages `1..N-1` the grid is trimmed to a whole number of batches.

Omit the attribute (or set `0`) for the default one-page-per-click behaviour.
Load-more only — numbered pagination (`link`) replaces the whole section.

**Static cells in the list.** Anything inside the list that is not marked
`li-render-paginate="item"` — a promo tile, an ad, a banner between products —
is counted as a grid cell and charged against the batch: with two promo tiles a
batch of 24 renders 22 items, so the grid still shows 24 cells. Such cells cannot
be buffered (Liquid re-renders them per page, usually keyed on `forloop.index`),
so only the copies from the first view are kept and later pages' copies are
dropped — they appear once, in place, instead of repeating every batch. Direct
children of the list are counted, one child = one cell.

> The batch is a **count of items**, not a guarantee about which products they come
> from. A single product's tiles can straddle two batches.

**State and filters.** The page counter, the buffer and the loaded count live on the
wrapper element, so they survive a re-render (which swaps `innerHTML` but keeps the
node) and reparenting into a drawer. Because a filter or sort produces a new result
set, the module listens for `liquiflow:filter-rendered` and resets that state — the
next click starts from page 2 of the new result set rather than continuing the old
one.

**Hiding the button on the last page.** The decision is made in JS, but the signal
comes from your Liquid: the module hides the button when the fetched response no
longer contains a `[li-render-paginate="button"]` element, so wrap it in
`{% if paginate.next %}`. As a JS-only fallback, add a
`<input li-render-paginate="total" value="{{ paginate.pages ... }}">` (total item
count) and the button is hidden once `loaded >= total`, even if Liquid keeps
rendering it.

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
| `li-render-product-variants`           | JSON map of the combinations that exist (see below)              |

### Valid combinations (`li-render-product-variants`)

Without a variant map the module sends whatever is checked. Pick a colour that
does not come in the selected size and Shopify finds no variant for that
combination — `product.selected_variant` is `nil` and the stale size stays
selected. Liquid cannot fix this on its own: it never learns *which* option the
shopper just changed (a theme cannot read custom query parameters), and "keep the
most matching values" would simply undo the change.

Give the module the combinations that exist and it keeps the value just picked,
moving the other options onto a variant that is real:

```html
<script type="application/json" li-render-product-variants>
  { "options":  [[{ "id": "1", "name": "Blau" }, { "id": "2", "name": "Grün" }],
                 [{ "id": "10", "name": "XS" }, { "id": "12", "name": "XL" }]],
    "variants": [{ "options": ["Blau", "XS"], "available": true },
                 { "options": ["Grün", "XL"], "available": true }] }
</script>
```

`options` lists each option's values in option order, with `id` matching
`li-render-product-option-id`; `variants` names the combinations by option value
name. Put it anywhere inside the product wrapper — outside a
`li-render-product-replace` region, since it is static per product.

Blau/XS → Grün then resolves to Grün/XL. The rules:

- The value just picked is always kept.
- A combination that exists is left alone — a sold-out one included, so the
  shopper still sees it marked unavailable instead of being moved off it.
- Otherwise the closest existing combination wins: the one keeping the most of
  the other chosen values, preferring available ones, ties going to the
  product's own variant order.
- **Variants left out of the map are unreachable.** Omitting the ones a shop has
  deactivated is how they stay out of the selectors.

Omit the script entirely and the previous behaviour is unchanged.

Flow on option change: collect the checked/selected ids → fetch
`{product_url}?section_id=…&option_values=id1,id2` → replace (or morph) the marked
regions → update `variant` in the address bar. For **combined listings** (a
different `product_url`) the whole product section is swapped.

---

## Migration from v1

- `li-render-custom*` → product module (`li-render-product*`). `liquify:custom-rendered` is removed.
- `li-render-custom-source` / `-target` → `li-render-source` / `li-render-target`.
  The old names still work (they are read as aliases), so an unmigrated theme keeps
  syncing rather than failing silently — but prefer the new spelling in new markup.
- **Namespace rename:** all events moved from `liquify:*` to `liquiflow:*`. Any theme
  code listening to the old names must be updated (filter/search/recommended/
  sections consumers).
- Consumers of `liquiflow:product-sections-rendered` (delivery time, swiper, etc.)
  are served by the new product module.
- Per-theme `load-more.js` can be replaced by the pagination module.
