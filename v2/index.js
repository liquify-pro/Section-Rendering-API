/**
 * liquiflow — Section Rendering API library
 *
 * Drives Shopify's Section Rendering API through `li-render-*` HTML attributes.
 * Public surface: the `window.liquiflowRenderer` global, `liquiflow:*` DOM events
 * (dispatched on `document`, all bubbling) and the `li-render-*` attributes.
 * See README.md for the full attribute and event reference.
 *
 * @version 2.0.0
 */
(() => {
  'use strict';

  const VERSION = '2.1.0';

  const config = {
    debug: false,
    morph: false,
    inputDebounce: 300,
    cacheLimit: 50,
    // Params that survive a "clear all filters" action (keeps the search term).
    reservedParams: ['q', 'type', 'options[prefix]', 'options[unavailable_products]'],
  };

  const warn = (...args) => { if (config.debug) console.warn('[liquiflow]', ...args); };

  const parser = new DOMParser();

  const debounce = (callback, wait) => {
    let timeoutId = null;
    return (...args) => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => callback(...args), wait);
    };
  };

  const root = () => (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

  const isSearchPage = () => window.location.pathname.replace(/\/$/, '').endsWith('/search') || window.location.pathname === '/search';

  const getSectionId = (element) => {
    const section = element.closest('.shopify-section') || element.closest('section');
    const match = (section?.id || '').match(/shopify-section-(.+)/);
    if (!match) {
      warn('[getSectionId] Could not resolve a section id for', element);
      return '';
    }
    return match[1];
  };

  const emit = (name, detail = {}) => {
    document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, cancelable: false }));
  };

  /* --- Text/attribute sync (li-render-source → li-render-target) ---- *
   * Copies named values out of a rendered response into live elements
   * anywhere on the page (e.g. a "42 products" count shown outside the
   * swapped region). Replaces v1's li-render-custom-source/target.
   * -------------------------------------------------------------------- */

  const readSourceValue = (el) =>
    (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
      ? el.value : el.textContent.trim();

  // v1 spelled these li-render-custom-source/-target. Both are accepted, so a
  // theme that has not been migrated keeps syncing instead of failing silently.
  const SOURCE_SELECTOR = '[li-render-source], [li-render-custom-source]';
  const TARGET_SELECTOR = '[li-render-target], [li-render-custom-target]';
  const roleName = (el, attr) => el.getAttribute(attr) || el.getAttribute(attr.replace('li-render-', 'li-render-custom-'));

  const syncTargets = (sourceRoot) => {
    const sources = sourceRoot.querySelectorAll(SOURCE_SELECTOR);
    if (!sources.length) return;

    // One pass to collect values, one pass to write them — with a change
    // guard so untouched targets never trigger a reflow.
    const values = new Map();
    sources.forEach((el) => {
      const name = roleName(el, 'li-render-source');
      if (name && !values.has(name)) values.set(name, readSourceValue(el));
    });

    document.querySelectorAll(TARGET_SELECTOR).forEach((target) => {
      const name = roleName(target, 'li-render-target');
      if (!values.has(name)) return;
      const value = values.get(name);
      const mode = target.getAttribute('li-render-target-mode') || 'text';
      if (mode === 'text') {
        if (target.textContent !== value) target.textContent = value;
      } else if (mode === 'html') {
        if (target.innerHTML !== value) target.innerHTML = value;
      } else if (target.getAttribute(mode) !== value) {
        target.setAttribute(mode, value); // mode = attribute name
      }
    });
  };

  /* --- Result cache (LRU, keyed by fetch URL) ----------------------- */

  const cache = {
    _map: new Map(),
    has(key) { return this._map.has(key); },
    get(key) {
      if (!this._map.has(key)) return null;
      const value = this._map.get(key);
      this._map.delete(key);
      this._map.set(key, value);
      return value;
    },
    set(key, value) {
      this._map.set(key, value);
      while (this._map.size > config.cacheLimit) {
        this._map.delete(this._map.keys().next().value);
      }
    },
    clear() { this._map.clear(); },
  };

  /* --- AbortController registry (one controller per channel) -------- */

  const controllers = new Map();

  const nextSignal = (channel) => {
    controllers.get(channel)?.abort();
    const controller = new AbortController();
    controllers.set(channel, controller);
    return controller.signal;
  };

  /* --- Morph: dependency-free DOM diff ------------------------------ */

  const nodeKey = (node) => (node.nodeType === 1 ? (node.id || node.getAttribute('li-render-key') || '') : '');

  const isFormControl = (node) =>
    node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement;

  const morphAttributes = (from, to) => {
    const formControl = isFormControl(from);
    // `value`/`checked` are synced as live properties below; copying them as
    // attributes would clobber a focused or edited control.
    const skip = (name) => formControl && (name === 'value' || name === 'checked');

    for (const attr of Array.from(to.attributes)) {
      if (!skip(attr.name) && from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
    }
    for (const attr of Array.from(from.attributes)) {
      if (!skip(attr.name) && !to.hasAttribute(attr.name)) from.removeAttribute(attr.name);
    }

    if (formControl && document.activeElement !== from) {
      if (from instanceof HTMLInputElement && (from.type === 'checkbox' || from.type === 'radio')) from.checked = to.checked;
      else from.value = to.value;
    }
  };

  const morph = (fromEl, toEl) => {
    // Leave JS-managed subtrees (sliders, maps, …) untouched during a morph.
    if (fromEl.nodeType === 1 && fromEl.hasAttribute('li-render-morph-ignore')) return;

    if (fromEl.nodeName !== toEl.nodeName) {
      fromEl.replaceWith(toEl.cloneNode(true));
      return;
    }

    morphAttributes(fromEl, toEl);

    const keyed = new Map();
    Array.from(fromEl.childNodes).forEach((node) => {
      const key = nodeKey(node);
      if (key) keyed.set(key, node);
    });

    let cursor = fromEl.firstChild;

    Array.from(toEl.childNodes).forEach((toChild) => {
      const key = nodeKey(toChild);
      let match = key && keyed.has(key) ? keyed.get(key) : null;

      if (!match && cursor && !nodeKey(cursor) && cursor.nodeType === toChild.nodeType &&
        (cursor.nodeType !== 1 || cursor.nodeName === toChild.nodeName)) {
        match = cursor;
      }

      if (match) {
        if (match !== cursor) fromEl.insertBefore(match, cursor);
        else cursor = cursor.nextSibling;

        if (match.nodeType === 1) morph(match, toChild);
        else if (match.nodeValue !== toChild.nodeValue) match.nodeValue = toChild.nodeValue;
        if (key) keyed.delete(key);
      } else {
        fromEl.insertBefore(toChild.cloneNode(true), cursor);
      }
    });

    while (cursor) {
      const nextCursor = cursor.nextSibling;
      fromEl.removeChild(cursor);
      cursor = nextCursor;
    }
    keyed.forEach((node) => { if (node.parentNode === fromEl) fromEl.removeChild(node); });
  };

  /* --- renderSection: the fetch + swap primitive -------------------- */

  const renderSection = async ({ url, wrapperSelector, targetSelector, type = '', channel, morph: useMorph, onDocument }) => {
    emit('liquiflow:before-render', { url, type });
    if (type) emit(`liquiflow:${type}-before-render`, { url });

    const swapSelector = targetSelector || wrapperSelector;
    const signal = nextSignal(channel || wrapperSelector);

    try {
      let newDocument = cache.get(url);

      if (!newDocument) {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`[renderSection] Fetch failed (${response.status}) for ${url}`);
        newDocument = parser.parseFromString(await response.text(), 'text/html');
        cache.set(url, newDocument);
      }

      const newElements = newDocument.querySelectorAll(swapSelector);
      const currentElements = document.querySelectorAll(swapSelector);

      if (newElements.length === 0) {
        warn('[renderSection] No matching elements in response for', swapSelector);
        return newDocument;
      }
      if (currentElements.length !== newElements.length) {
        warn('[renderSection] Element count mismatch for', swapSelector);
        return newDocument;
      }

      currentElements.forEach((currentElement, index) => {
        if (useMorph) morph(currentElement, newElements[index]);
        else currentElement.innerHTML = newElements[index].innerHTML;
      });

      if (typeof onDocument === 'function') onDocument(newDocument);
      syncTargets(newDocument);

      emit('liquiflow:sections-rendered', { url, type, morph: !!useMorph });
      if (type) emit(`liquiflow:${type}-rendered`, { url, morph: !!useMorph });

      return newDocument;
    } catch (error) {
      if (error.name === 'AbortError') warn('[renderSection] Request aborted:', url);
      else console.error('[liquiflow]', error.message || error);
      return null;
    }
  };

  /* ================================================================== *
   *  Filter module
   * ================================================================== */

  const Filter = {
    instances: [],
    registry: new Map(), // sectionId → instance
    wired: false,

    isUnique(control) {
      if (control.hasAttribute('li-render-filter-unique')) return control.getAttribute('li-render-filter-unique') !== 'false';
      return control.type === 'radio' || control.tagName === 'SELECT';
    },

    // Resolve the instance a control belongs to regardless of where it currently
    // lives in the DOM — a filter drawer is often reparented to <body>, detaching
    // its controls from the wrapper subtree.
    resolveInstance(el) {
      const wrapper = el.closest('[li-render-filter="wrapper"]');
      if (wrapper && wrapper.__liquiflow) return wrapper.__liquiflow;
      const linked = el.closest('[li-render-filter-section]')?.getAttribute('li-render-filter-section');
      if (linked && this.registry.has(linked)) return this.registry.get(linked);
      if (this.registry.size === 1) return this.registry.values().next().value;
      return null;
    },

    // Live controls for a section may live outside its wrapper, so state syncing
    // scans the whole document and filters by instance.
    forEachControl(instance, role, callback) {
      document.querySelectorAll(`[li-render-filter="${role}"]`).forEach((el) => {
        if (this.resolveInstance(el) === instance) callback(el);
      });
    },

    syncControls(instance) {
      this.forEachControl(instance, 'filter', (el) => {
        const param = el.getAttribute('li-render-filter-name');
        const value = el.getAttribute('li-render-filter-value');
        if (!param || !value) return;

        const active = instance.filters.has(param, value);
        el.checked = active;
        const custom = el.parentElement?.querySelector('div');
        if (custom) custom.classList.toggle('w--redirected-checked', active);
      });
    },

    syncPrice(instance) {
      this.forEachControl(instance, 'price-min', (el) => {
        const param = el.getAttribute('li-render-filter-min-param') || 'filter.v.price.gte';
        el.value = instance.filters.has(param) ? instance.filters.get(param) : '';
      });
      this.forEachControl(instance, 'price-max', (el) => {
        const param = el.getAttribute('li-render-filter-max-param') || 'filter.v.price.lte';
        el.value = instance.filters.has(param) ? instance.filters.get(param) : '';
      });
    },

    syncCounts(instance, newDocument) {
      newDocument.querySelectorAll('[li-render-filter="filter"]').forEach((el) => {
        const param = el.getAttribute('li-render-filter-name');
        const value = el.getAttribute('li-render-filter-value');
        const countSource = el.getAttribute('li-render-filter-count');
        if (!param || !value || countSource == null) return;

        const count = parseInt(countSource, 10);
        document.querySelectorAll(`[li-render-filter-name="${param}"][li-render-filter-value="${value}"]`).forEach((live) => {
          if (Filter.resolveInstance(live) !== instance) return;
          live.classList.toggle('is-disabled', count === 0);
          const target = live.parentElement?.querySelector('[li-render-filter="count-value"]');
          if (target) target.textContent = Number.isNaN(count) ? '' : count;
        });
      });
    },

    apply(instance, { render }) {
      const { filters } = instance;
      filters.delete('page'); // result set changed → reset pagination

      liquiflowRenderer.state.filters[instance.sectionId] = Object.fromEntries(filters.entries());

      const pathname = window.location.pathname;
      history.replaceState(null, '', pathname + (filters.toString() ? `?${filters}` : ''));

      if (!render) return;

      const url = `${pathname}?section_id=${instance.sectionId}${filters.toString() ? `&${filters}` : ''}`;
      renderSection({
        url,
        wrapperSelector: '[li-render-filter="wrapper"]',
        targetSelector: instance.hasTarget ? '[li-render-filter="target"]' : undefined,
        type: 'filter',
        channel: `filter:${instance.sectionId}`,
        morph: instance.morph,
        onDocument: (doc) => {
          Filter.syncControls(instance);
          Filter.syncPrice(instance);
          Filter.syncCounts(instance, doc);
        },
      });
    },

    setParam(instance, param, value, { unique = false, remove = false } = {}) {
      const { filters } = instance;
      if (remove || value === '') {
        value === '' ? filters.delete(param) : filters.delete(param, value);
      } else if (unique) {
        filters.set(param, value);
      } else if (filters.has(param, value)) {
        filters.delete(param, value);
      } else {
        filters.append(param, value);
      }
    },

    handleControl(control, eventType) {
      const trigger = control.getAttribute('li-render-filter-trigger') || 'change';
      if (eventType !== trigger) return;
      const instance = this.resolveInstance(control);
      if (!instance) return;

      const param = control.getAttribute('li-render-filter-name');
      const value = control.getAttribute('li-render-filter-value');
      if (!param || value == null) return;

      const isCheckbox = control.type === 'checkbox';
      this.setParam(instance, param, value, { unique: this.isUnique(control), remove: isCheckbox && !control.checked });
      this.apply(instance, { render: !instance.hasSubmit });
    },

    // Delegation is bound once on `document` (not per wrapper), so controls keep
    // working after a DOM swap AND when moved outside their wrapper (e.g. into a
    // modal reparented to <body>), on any page and any number of instances.
    wire() {
      if (this.wired) return;
      this.wired = true;

      const closest = (e, selector) => (e.target instanceof Element ? e.target.closest(selector) : null);

      document.addEventListener('change', (e) => {
        const control = closest(e, '[li-render-filter="filter"]');
        if (control) return this.handleControl(control, 'change');
        const sort = closest(e, '[li-render-filter="sort"]');
        if (sort) {
          const instance = this.resolveInstance(sort);
          if (!instance) return;
          this.setParam(instance, 'sort_by', sort.value, { unique: true });
          this.apply(instance, { render: true });
        }
      });

      document.addEventListener('click', (e) => {
        const control = closest(e, '[li-render-filter="filter"]');
        if (control && (control.getAttribute('li-render-filter-trigger') || 'change') === 'click') {
          return this.handleControl(control, 'click');
        }
        const submit = closest(e, '[li-render-filter="submit-button"]');
        if (submit) {
          const instance = this.resolveInstance(submit);
          if (!instance) return;
          e.preventDefault();
          return this.apply(instance, { render: true });
        }
        const remove = closest(e, '[li-render-filter="remove"]');
        if (remove) {
          const instance = this.resolveInstance(remove);
          if (!instance) return;
          e.preventDefault();
          const removeUrl = remove.getAttribute('li-render-filter-value');
          if (!removeUrl) return;
          instance.filters = new URLSearchParams(new URL(removeUrl, window.location.origin).search);
          return this.apply(instance, { render: true });
        }
        const clear = closest(e, '[li-render-filter="clear-all"]');
        if (clear) {
          const instance = this.resolveInstance(clear);
          if (!instance) return;
          e.preventDefault();
          const preserved = new URLSearchParams();
          config.reservedParams.forEach((param) => {
            if (instance.filters.has(param)) instance.filters.getAll(param).forEach((v) => preserved.append(param, v));
          });
          instance.filters = preserved;
          this.apply(instance, { render: true });
        }
      });

      const handlePrice = (el, defaultParam, attr) => {
        const instance = this.resolveInstance(el);
        if (!instance) return;
        const param = el.getAttribute(attr) || defaultParam;
        const current = instance.filters.has(param) ? instance.filters.get(param) : '';
        const next = el.value.trim();
        if (next === current) return; // only render when the price actually changed
        this.setParam(instance, param, next, { unique: true, remove: next === '' });
        this.apply(instance, { render: true });
      };
      document.addEventListener('blur', (e) => {
        const min = closest(e, '[li-render-filter="price-min"]');
        if (min) return handlePrice(min, 'filter.v.price.gte', 'li-render-filter-min-param');
        const max = closest(e, '[li-render-filter="price-max"]');
        if (max) return handlePrice(max, 'filter.v.price.lte', 'li-render-filter-max-param');
      }, true);

      const onSearchInput = debounce((el) => {
        const instance = this.resolveInstance(el);
        if (!instance || !isSearchPage()) return;
        this.setParam(instance, 'q', el.value, { unique: true, remove: el.value === '' });
        this.apply(instance, { render: true });
      }, config.inputDebounce);
      document.addEventListener('input', (e) => {
        const el = closest(e, '[li-render-filter="search"]');
        if (el) onSearchInput(el);
      });
      document.addEventListener('submit', (e) => {
        const form = e.target;
        const el = form.querySelector?.('[li-render-filter="search"]');
        if (!el || isSearchPage() || !el.value) return;
        const instance = this.resolveInstance(el);
        const searchQuery = instance ? Search.buildResourceQuery(instance.wrapper) : '';
        e.preventDefault();
        form.action = `/search?${searchQuery ? `${searchQuery}&` : ''}q=${encodeURIComponent(el.value)}`;
        form.submit();
      });
    },

    init(wrapper) {
      this.wire();

      const sectionId = getSectionId(wrapper);
      // Reuse the existing instance on re-init (Theme Editor reload) so the active
      // filter state and registry stay intact instead of duplicating.
      const instance = this.registry.get(sectionId) || {
        module: 'filter',
        sectionId,
        filters: new URLSearchParams(window.location.search),
      };
      instance.wrapper = wrapper;
      instance.hasTarget = !!wrapper.querySelector('[li-render-filter="target"]');
      instance.hasSubmit = wrapper.querySelectorAll('[li-render-filter="submit-button"]').length > 0;
      instance.morph = wrapper.hasAttribute('li-render-morph') || config.morph;
      wrapper.__liquiflow = instance;

      if (!this.registry.has(sectionId)) {
        this.registry.set(sectionId, instance);
        this.instances.push(instance);
        liquiflowRenderer.instances.push(instance);
      }
      liquiflowRenderer.state.filters[sectionId] = Object.fromEntries(instance.filters.entries());

      this.syncControls(instance);
      this.syncPrice(instance);
    },
  };

  /* ================================================================== *
   *  Search module (predictive search)
   * ================================================================== */

  const Search = {
    buildResourceQuery(wrapper) {
      const map = {
        'li-render-search-type': 'resources[type]',
        'li-render-search-limit': 'resources[limit]',
        'li-render-search-limit-scope': 'resources[limit_scope]',
        'li-render-search-unavailable': 'resources[options][unavailable_products]',
        'li-render-search-fields': 'resources[options][fields]',
      };
      const query = new URLSearchParams();
      Object.entries(map).forEach(([attr, param]) => {
        const value = wrapper.getAttribute(attr);
        if (value !== null) query.append(param, value);
      });
      return query.toString();
    },

    init(wrapper) {
      const inputs = wrapper.querySelectorAll('[li-render-search="input"]');
      if (inputs.length === 0) return;

      const sectionId = getSectionId(wrapper);
      const resourceQuery = this.buildResourceQuery(wrapper);
      const morphOn = wrapper.hasAttribute('li-render-morph') || config.morph;

      inputs.forEach((input) => {
        input.addEventListener('input', debounce(() => {
          const term = input.value.trim();
          if (!term) return;
          const url = `${root()}search/suggest?q=${encodeURIComponent(term)}&section_id=${sectionId}${resourceQuery ? `&${resourceQuery}` : ''}`;
          renderSection({
            url,
            wrapperSelector: '[li-render-search="wrapper"]',
            targetSelector: '[li-render-search="target"]',
            type: 'search',
            channel: `search:${sectionId}`,
            morph: morphOn,
          });
        }, config.inputDebounce));
      })
    }
  };

  /* ================================================================== *
   *  Recommended module
   * ================================================================== */

  const Recommended = {
    init(wrapper) {
      const sectionId = getSectionId(wrapper);
      const path = wrapper.getAttribute('li-render-recommended-path');
      const productId = wrapper.getAttribute('li-render-recommended-product');
      const limit = wrapper.getAttribute('li-render-recommended-limit') || 4;
      const intent = wrapper.getAttribute('li-render-recommended-intent') || 'related';

      if (!sectionId) return warn('[recommended] Missing section id.');
      if (!path) return warn('[recommended] Missing li-render-recommended-path.');
      if (!productId) return warn('[recommended] Missing li-render-recommended-product.');

      const query = new URLSearchParams({ section_id: sectionId, product_id: productId, limit, intent });
      renderSection({
        url: `${path}?${query}`,
        wrapperSelector: '[li-render-recommended="wrapper"]',
        targetSelector: wrapper.querySelector('[li-render-recommended="target"]') ? '[li-render-recommended="target"]' : undefined,
        type: 'recommended',
        channel: `recommended:${sectionId}`,
        morph: wrapper.hasAttribute('li-render-morph') || config.morph,
      });
    },
  };

  /* ================================================================== *
   *  Pagination / load-more module (products, blogs, any array)
   * ================================================================== */

  const Pagination = {
    wired: false,
    wrapperSelector: '[li-render-paginate="wrapper"]',
    itemSelector: '[li-render-paginate="item"]',

    config(wrapper) {
      return {
        sectionId: wrapper.getAttribute('li-render-section-id') || getSectionId(wrapper),
        pageParam: wrapper.getAttribute('li-render-paginate-page-param') || 'page',
        morph: wrapper.hasAttribute('li-render-morph') || config.morph,
        batch: this.batchSize(wrapper),
      };
    },

    /* --- Fixed batch size (li-render-paginate-batch="24") --------------
     * A Shopify page holds N *products*, but a section may expand each one
     * into a variable number of items — a tile per colour variant, say.
     * Paginating by page then yields ragged batches (12 products can be
     * anywhere from 12 to 40 tiles) and the grid grows unevenly.
     *
     * With a batch size the module renders exactly N items per view and per
     * click: a page's surplus is parked in a buffer and further pages are
     * fetched whenever the buffer runs short. Off (0) keeps the default
     * one-page-per-click behaviour.
     *
     * Load-more only — numbered pagination (`link`) replaces the section.
     * ------------------------------------------------------------------- */
    batchSize(wrapper) {
      const raw = parseInt(wrapper.getAttribute('li-render-paginate-batch'), 10);
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    },

    // Cells in the list that pagination does not own — promo tiles, an ad, a
    // banner between products. They cannot be buffered (the section re-renders
    // them per page), but they do occupy grid slots, so they count against the
    // batch: with two promo tiles a batch of 24 renders 22 items and the grid
    // still shows 24 cells. Direct children only; one child = one cell.
    foreignCells(list) {
      return [...list.children].filter((child) => !child.matches(this.itemSelector)).length;
    },

    updateCount(wrapper, loaded, total) {
      const countDisplay = wrapper.querySelector('[li-render-paginate="count"]');
      if (!countDisplay) return;
      const template = countDisplay.getAttribute('li-render-paginate-count-text') || countDisplay.textContent;
      countDisplay.textContent = template.replace('{loaded}', loaded).replace('{total}', total);
    },

    // Fetch one page's rendered section and return the matching wrapper + items.
    async fetchPage(wrapper, page) {
      const { sectionId, pageParam } = this.config(wrapper);
      const params = new URLSearchParams(window.location.search);
      params.set('section_id', sectionId);
      params.set(pageParam, page);
      const url = `${window.location.pathname}?${params}`;

      let doc = cache.get(url);
      if (!doc) {
        const response = await fetch(url, { signal: nextSignal(`paginate:${sectionId}:${page}`) });
        if (!response.ok) throw new Error(`[paginate] Fetch failed (${response.status}) for ${url}`);
        doc = parser.parseFromString(await response.text(), 'text/html');
        cache.set(url, doc);
      }

      // Match the corresponding wrapper by document order among all wrappers.
      const index = [...document.querySelectorAll(this.wrapperSelector)].indexOf(wrapper);
      const newWrapper = doc.querySelectorAll(this.wrapperSelector)[index] || doc.querySelector(this.wrapperSelector);
      const items = newWrapper ? [...newWrapper.querySelectorAll(this.itemSelector)] : [];
      return { url, doc, newWrapper, items };
    },

    // Liquid stops rendering the "next" button once the last page is reached.
    sourceExhausted(newWrapper) {
      return !newWrapper || !newWrapper.querySelector('[li-render-paginate="button"]');
    },

    // True once everything is loaded — either Liquid stopped rendering the
    // "next" button, or a provided total says the list is complete.
    isComplete(wrapper, newWrapper) {
      const total = parseInt(newWrapper?.querySelector('[li-render-paginate="total"]')?.value, 10);
      return this.sourceExhausted(newWrapper) || (Number.isFinite(total) && wrapper.__paginateLoaded >= total);
    },

    // Page/buffer state lives on the wrapper so it survives a re-render (which
    // swaps innerHTML but keeps the node) and reparenting into a drawer.
    seed(wrapper, list, pageParam) {
      if (!wrapper.__paginateBuffer) wrapper.__paginateBuffer = [];
      if (wrapper.__paginatePage != null) return;
      wrapper.__paginatePage = (parseInt(new URLSearchParams(window.location.search).get(pageParam), 10) || 1) + 1;
      wrapper.__paginateLoaded = list.querySelectorAll(this.itemSelector).length;
      wrapper.__paginateDone = false;
    },

    // Fetch further pages until the buffer holds `want` items or the source runs
    // out. Returns the last fetch (for syncTargets and the total input).
    async fill(wrapper, want) {
      let last = null;
      while (wrapper.__paginateBuffer.length < want && !wrapper.__paginateDone) {
        const result = await this.fetchPage(wrapper, wrapper.__paginatePage);
        wrapper.__paginatePage += 1;
        last = result;
        result.items.forEach((item) => wrapper.__paginateBuffer.push(document.importNode(item, true)));
        if (!result.items.length || this.sourceExhausted(result.newWrapper)) wrapper.__paginateDone = true;
      }
      return last;
    },

    // Move up to `count` buffered items into the list.
    drain(wrapper, list, count) {
      const items = wrapper.__paginateBuffer.splice(0, count);
      items.forEach((item) => list.appendChild(item));
      wrapper.__paginateLoaded += items.length;
      return items.length;
    },

    // One Shopify page per click (default).
    async advancePage(wrapper, list) {
      const { url, doc, newWrapper, items } = await this.fetchPage(wrapper, wrapper.__paginatePage);
      let added = 0;
      if (items.length) {
        items.forEach((item) => list.appendChild(document.importNode(item, true)));
        added = items.length;
        wrapper.__paginateLoaded += added;
        wrapper.__paginatePage += 1;
      }
      return { added, url, doc, newWrapper, complete: !items.length || this.isComplete(wrapper, newWrapper) };
    },

    // Exactly `batch` items per click, buffered across page boundaries.
    async advanceBatched(wrapper, list, batch) {
      const last = await this.fill(wrapper, batch);
      const added = this.drain(wrapper, list, batch);
      const complete = wrapper.__paginateDone && !wrapper.__paginateBuffer.length;
      return { added, url: last?.url, doc: last?.doc, newWrapper: last?.newWrapper, complete };
    },

    async loadMore(wrapper, button) {
      const list = wrapper.querySelector('[li-render-paginate="list"]');
      const { sectionId, pageParam, batch } = this.config(wrapper);
      if (!sectionId || !list) return warn('[paginate] Missing section id or list element.');

      this.seed(wrapper, list, pageParam);

      const page = wrapper.__paginatePage;
      emit('liquiflow:before-render', { type: 'paginate' });
      emit('liquiflow:paginate-before-render', { page, batch });

      const busyLabel = button.getAttribute('li-render-paginate-loading-text');
      const idleLabel = button.textContent;
      button.disabled = true;
      if (busyLabel) button.textContent = busyLabel;

      try {
        const { added, url, doc, newWrapper, complete } = batch
          ? await this.advanceBatched(wrapper, list, batch)
          : await this.advancePage(wrapper, list);

        if (added) {
          this.updateCount(wrapper, wrapper.__paginateLoaded, newWrapper?.querySelector('[li-render-paginate="total"]')?.value);

          // Reflect the last fetched page in the address bar (deep-link / back
          // button), preserving existing query and without leaking section_id.
          const address = new URLSearchParams(window.location.search);
          address.set(pageParam, wrapper.__paginatePage - 1);
          history.replaceState(null, '', `${window.location.pathname}?${address}`);

          if (doc) syncTargets(doc);
          emit('liquiflow:paginate-rendered', { url, mode: 'load-more', added });
          emit('liquiflow:sections-rendered', { url, type: 'paginate' });
        }

        button.disabled = false;
        if (busyLabel) button.textContent = idleLabel;
        if (complete) button.style.display = 'none';
      } catch (error) {
        if (error.name !== 'AbortError') console.error('[liquiflow]', error.message || error);
        button.disabled = false;
        if (busyLabel) button.textContent = idleLabel;
      }
    },

    // Bring the server-rendered first view to exactly `batch` items: park the
    // surplus in the buffer, or top up from the next page when the section
    // produced fewer items than one batch.
    async balance(wrapper, list, batch) {
      // Promo tiles already fill part of the first view's grid.
      const target = Math.max(1, batch - this.foreignCells(list));
      const rendered = [...list.querySelectorAll(this.itemSelector)];

      if (rendered.length > target) {
        rendered.slice(target).forEach((item) => {
          list.removeChild(item);
          wrapper.__paginateBuffer.push(item);
        });
        wrapper.__paginateLoaded = target;
        return;
      }

      const short = target - rendered.length;
      const button = wrapper.querySelector('[li-render-paginate="button"]');
      if (!short || !button) return; // already exact, or there is no next page

      try {
        await this.fill(wrapper, short);
        if (this.drain(wrapper, list, short)) {
          emit('liquiflow:paginate-rendered', { mode: 'balance' });
          emit('liquiflow:sections-rendered', { type: 'paginate' });
        }
        if (wrapper.__paginateDone && !wrapper.__paginateBuffer.length) button.style.display = 'none';
      } catch (error) {
        if (error.name !== 'AbortError') console.error('[liquiflow]', error.message || error);
      }
    },

    // After a deep-link restore, keep a whole number of batches visible and park
    // the remainder, so a reload lands on the same uniform grid.
    trim(wrapper, list, batch) {
      if (wrapper.__paginateDone) return; // nothing left to pull from — show all
      const foreign = this.foreignCells(list);
      const rendered = [...list.querySelectorAll(this.itemSelector)];
      const cells = rendered.length + foreign;
      const keep = Math.max(0, Math.max(batch, Math.floor(cells / batch) * batch) - foreign);
      if (rendered.length <= keep) return;
      rendered.slice(keep).forEach((item) => {
        list.removeChild(item);
        wrapper.__paginateBuffer.push(item);
      });
      wrapper.__paginateLoaded = keep;
    },

    // On load with ?page=N (a reload/deep-link), Shopify renders only page N.
    // Fetch pages 1..N-1 and prepend them so the full accumulated range shows.
    async restore(wrapper, uptoPage) {
      const list = wrapper.querySelector('[li-render-paginate="list"]');
      if (!list || uptoPage < 2) return;

      const anchor = list.firstChild; // keep page N's items last
      const earlier = [];
      for (let p = 1; p < uptoPage; p++) earlier.push(p);

      try {
        // Parallel fetch, ordered insert.
        const results = await Promise.all(earlier.map((p) => this.fetchPage(wrapper, p)));
        results.forEach(({ items }) => {
          items.forEach((item) => list.insertBefore(document.importNode(item, true), anchor));
          wrapper.__paginateLoaded += items.length;
        });
        const batch = this.batchSize(wrapper);
        if (batch) this.trim(wrapper, list, batch);
        emit('liquiflow:paginate-rendered', { mode: 'restore' });
        emit('liquiflow:sections-rendered', { type: 'paginate' });
      } catch (error) {
        if (error.name !== 'AbortError') console.error('[liquiflow]', error.message || error);
      }
    },

    // A filter/sort render swaps the wrapper's contents but keeps the node, so
    // the accumulated page and buffer state has to be dropped — otherwise the
    // next click continues from the previous result set.
    reset(wrapper) {
      const list = wrapper.querySelector('[li-render-paginate="list"]');
      wrapper.__paginatePage = 2; // a filtered response is always page 1
      wrapper.__paginateLoaded = list ? list.querySelectorAll(this.itemSelector).length : 0;
      wrapper.__paginateBuffer = [];
      wrapper.__paginateDone = false;

      const button = wrapper.querySelector('[li-render-paginate="button"]');
      if (button) button.style.removeProperty('display');

      const batch = this.batchSize(wrapper);
      if (list && batch) this.balance(wrapper, list, batch);
    },

    gotoPage(wrapper, link) {
      const { sectionId, morph: morphOn } = this.config(wrapper);
      const href = link.getAttribute('href') || link.getAttribute('li-render-paginate-value');
      if (!href) return;
      const parsed = new URL(href, window.location.origin);
      parsed.searchParams.set('section_id', sectionId);
      history.replaceState(null, '', href);
      renderSection({
        url: parsed.toString(),
        wrapperSelector: this.wrapperSelector,
        type: 'paginate',
        channel: `paginate:${sectionId}`,
        morph: morphOn,
      });
    },

    // Delegated on document so load-more and numbered links keep working after
    // any re-render (filter/sort) that replaces the button, and inside modals.
    wire() {
      if (this.wired) return;
      this.wired = true;
      const closest = (e, selector) => (e.target instanceof Element ? e.target.closest(selector) : null);

      document.addEventListener('click', (e) => {
        const button = closest(e, '[li-render-paginate="button"]');
        if (button) {
          const wrapper = button.closest(this.wrapperSelector);
          if (!wrapper) return;
          e.preventDefault(); // stop native <a>/submit navigation
          return this.loadMore(wrapper, button);
        }
        const link = closest(e, '[li-render-paginate="link"]');
        if (link) {
          const wrapper = link.closest(this.wrapperSelector);
          if (!wrapper) return;
          e.preventDefault();
          this.gotoPage(wrapper, link);
        }
      });

      // A new result set means the accumulated pages no longer apply.
      document.addEventListener('liquiflow:filter-rendered', () => {
        document.querySelectorAll(this.wrapperSelector).forEach((w) => {
          if (w.__paginateInit) this.reset(w);
        });
      });
    },

    init(wrapper) {
      this.wire();
      const list = wrapper.querySelector('[li-render-paginate="list"]');
      const { sectionId, pageParam, batch } = this.config(wrapper);
      if (!sectionId || !list) return warn('[paginate] Missing section id or list element.');
      if (wrapper.__paginateInit) return;
      wrapper.__paginateInit = true;

      // Seed page state from the URL; kept on the wrapper across re-renders.
      const currentPage = parseInt(new URLSearchParams(window.location.search).get(pageParam), 10) || 1;
      wrapper.__paginatePage = currentPage + 1;
      wrapper.__paginateLoaded = list.querySelectorAll(this.itemSelector).length;
      wrapper.__paginateBuffer = [];
      wrapper.__paginateDone = false;

      // Deep-link / reload to page N: restore the earlier pages that Shopify
      // didn't render, so the full accumulated list is shown.
      if (currentPage > 1) this.restore(wrapper, currentPage);
      else if (batch) this.balance(wrapper, list, batch);
    },
  };

  /* ================================================================== *
   *  Product module (option-based rendering for high-variant products)
   *  Renders with option value IDs (`option_values`) instead of variant
   *  IDs, and supports combined listings via option_value.product_url.
   * ================================================================== */

  const Product = {
    init(wrapper) {
      const sectionId = wrapper.getAttribute('li-render-section-id') || getSectionId(wrapper);
      const productUrl = wrapper.getAttribute('li-render-product-url') || window.location.pathname;
      const morphOn = wrapper.hasAttribute('li-render-morph') || config.morph;
      if (!sectionId) return warn('[product] Missing section id.');

      if (!wrapper.querySelector('[li-render-product-variants]')) {
        warn('[product] No li-render-product-variants map — an option combination that has no'
          + ' variant will be sent as picked, and the stale values stay selected.', wrapper);
      }

      wrapper.addEventListener('change', (e) => {
        // A <select> carries the ids on its <option>s, so match it by its own marker.
        const control = e.target.closest('[li-render-product-option-id], [li-render-product-option-select]');
        if (!control || !wrapper.contains(control)) return;
        if ((control.type === 'radio' || control.type === 'checkbox') && !control.checked) return;
        this.render(wrapper, { sectionId, productUrl, morph: morphOn, control });
      });
    },

    // The option value just picked: on a radio/checkbox the control itself, on a
    // <select> the chosen <option>.
    changedValueId(control) {
      if (!control) return null;
      if (control.tagName === 'SELECT') return control.selectedOptions[0]?.getAttribute('li-render-product-option-id') || null;
      return control.getAttribute('li-render-product-option-id');
    },

    /* --- Optional variant map ------------------------------------------
     * <script type="application/json" li-render-product-variants>
     *   { "options":  [[{ "id": "7", "name": "Blau" }, …], …],
     *     "variants": [{ "options": ["Blau", "XS"], "available": true }, …] }
     *
     * `options` lists each option's values in option order, with `id` matching
     * li-render-product-option-id; `variants` names the combinations that exist.
     * Variants the theme leaves out are unreachable — that is how a shop keeps
     * deactivated combinations out of the selectors.
     * ------------------------------------------------------------------- */
    variantMap(wrapper) {
      const node = wrapper.querySelector('[li-render-product-variants]');
      if (!node) return null;
      try {
        const raw = JSON.parse(node.textContent);
        const options = (raw.options || []).map((values) => values.map((v) => ({ id: String(v.id), name: v.name })));
        const idAt = (position, name) => options[position]?.find((v) => v.name === name)?.id;
        const variants = (raw.variants || [])
          .map((v) => ({ available: v.available !== false, ids: (v.options || []).map((name, i) => idAt(i, name)) }))
          .filter((v) => v.ids.length && v.ids.every(Boolean));
        return variants.length ? variants : null;
      } catch (error) {
        // Not warn(): this silently disables option resolution, so it has to be
        // visible without debug mode.
        console.warn('[liquiflow] [product] li-render-product-variants is not valid JSON —'
          + ' option resolution is disabled for this product.', error.message || error);
        return null;
      }
    },

    /* Keep the value the shopper just picked and re-resolve the other options to
     * a combination that exists: choosing a colour that does not come in the
     * selected size moves the size to one it does come in. Without a variant map
     * the selection is sent unchanged (previous behaviour). */
    resolveSelection(wrapper, control, selected) {
      const variants = this.variantMap(wrapper);
      const changed = this.changedValueId(control);
      if (!variants || !changed) return selected;

      // The combination exists — a sold-out one included, so the shopper stays on
      // it and sees it marked unavailable instead of being moved off it.
      const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
      if (variants.some((v) => sameSet(v.ids, selected))) return selected;

      const position = variants.find((v) => v.ids.includes(changed))?.ids.indexOf(changed);
      if (position == null || position < 0) return selected;

      let pool = variants.filter((v) => v.ids[position] === changed);
      const inStock = pool.filter((v) => v.available);
      if (inStock.length) pool = inStock;
      if (!pool.length) return selected;

      // Closest combination: the one keeping the most of the other chosen values.
      // Ties go to the product's own variant order.
      const kept = (v) => v.ids.reduce((n, id, i) => n + (i !== position && selected.includes(id) ? 1 : 0), 0);
      return pool.reduce((best, v) => (kept(v) > kept(best) ? v : best), pool[0]).ids;
    },

    collectOptionValues(wrapper) {
      const values = [];
      // Restrict to inputs: `:checked` also matches <option selected>, which the
      // select handling below covers separately (avoids duplicate ids).
      wrapper.querySelectorAll('input[li-render-product-option-id]:checked').forEach((el) => {
        values.push(el.getAttribute('li-render-product-option-id'));
      });
      wrapper.querySelectorAll('select[li-render-product-option-select]').forEach((select) => {
        const id = select.selectedOptions[0]?.getAttribute('li-render-product-option-id');
        if (id) values.push(id);
      });
      return values.filter(Boolean);
    },

    async render(wrapper, { sectionId, productUrl, morph: morphOn, control }) {
      emit('liquiflow:before-product-sections-render', { sectionId });

      const targetUrl = control?.getAttribute('li-render-product-url') || productUrl;
      const isSibling = !!control?.getAttribute('li-render-product-url') &&
        new URL(targetUrl, window.location.origin).pathname !== new URL(productUrl, window.location.origin).pathname;

      const optionValues = this.resolveSelection(wrapper, control, this.collectOptionValues(wrapper));
      const url = new URL(targetUrl, window.location.origin);
      url.searchParams.set('section_id', sectionId);
      if (optionValues.length) url.searchParams.set('option_values', optionValues.join(','));

      const signal = nextSignal(`product:${sectionId}`);
      try {
        let doc = cache.get(url.toString());
        if (!doc) {
          const response = await fetch(url.toString(), { signal });
          if (!response.ok) throw new Error(`[product] Fetch failed (${response.status})`);
          doc = parser.parseFromString(await response.text(), 'text/html');
          cache.set(url.toString(), doc);
        }

        // Whether existing nodes were kept (morph) or replaced. A sibling swap
        // rebuilds the whole section, so it never counts as a morph.
        const didMorph = morphOn && !isSibling;

        if (isSibling) {
          // Combined listings: swap the whole product section for the sibling.
          const newSection = doc.querySelector('[li-render-product="wrapper"]');
          if (newSection && wrapper.parentNode) {
            wrapper.parentNode.insertBefore(document.importNode(newSection, true), wrapper);
            wrapper.remove();
          }
        } else {
          doc.querySelectorAll('[li-render-product-replace]').forEach((newEl) => {
            const target = wrapper.querySelector(`[li-render-product-replace="${newEl.getAttribute('li-render-product-replace')}"]`);
            if (!target) return;
            if (morphOn) morph(target, newEl);
            else target.innerHTML = newEl.innerHTML;
          });
        }

        const variantId = doc.querySelector('[li-render-product-variant-id]')?.getAttribute('li-render-product-variant-id');
        if (variantId) {
          const current = new URL(window.location.href);
          current.searchParams.set('variant', variantId);
          history.replaceState(null, '', current.toString());
        }

        if (control?.id) document.getElementById(control.id)?.focus();
        syncTargets(doc);

        emit('liquiflow:sections-rendered', { url: url.toString(), type: 'product-sections', morph: didMorph });
        emit('liquiflow:product-sections-rendered', { sectionId, variantId, morph: didMorph });
      } catch (error) {
        if (error.name !== 'AbortError') console.error('[liquiflow]', error.message || error);
      }
    },
  };

  /* --- Bootstrap ---------------------------------------------------- */

  const initSection = (scope) => {
    scope.querySelectorAll('[li-render-filter="wrapper"]').forEach((w) => Filter.init(w));
    scope.querySelectorAll('[li-render-search="wrapper"]').forEach((w) => Search.init(w));
    scope.querySelectorAll('[li-render-recommended="wrapper"]').forEach((w) => Recommended.init(w));
    scope.querySelectorAll('[li-render-paginate="wrapper"]').forEach((w) => Pagination.init(w));
    scope.querySelectorAll('[li-render-product="wrapper"]').forEach((w) => Product.init(w));
  };

  const boot = () => initSection(document);

  const liquiflowRenderer = {
    version: VERSION,
    config,
    state: { filters: {} },
    cache,
    instances: [],
    render: renderSection,
    refresh: boot,
    product: Product,
    pagination: Pagination,
    _internal: { morph, debounce, getSectionId, nextSignal },
  };

  window.liquiflowRenderer = liquiflowRenderer;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Re-initialise a section's wrappers when re-rendered in the Theme Editor.
  document.addEventListener('shopify:section:load', (e) => initSection(e.target));
})();
