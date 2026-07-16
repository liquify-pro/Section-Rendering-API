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

  const VERSION = '2.0.0';

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
    init(wrapper, index) {
      const sectionId = wrapper.getAttribute('li-render-section-id') || getSectionId(wrapper);
      const list = wrapper.querySelector('[li-render-paginate="list"]');
      const button = wrapper.querySelector('[li-render-paginate="button"]');
      const countDisplay = wrapper.querySelector('[li-render-paginate="count"]');
      const pageParam = wrapper.getAttribute('li-render-paginate-page-param') || 'page';
      const morphOn = wrapper.hasAttribute('li-render-morph') || config.morph;

      if (!sectionId || !list) return warn('[paginate] Missing section id or list element.');

      const wrapperSelector = '[li-render-paginate="wrapper"]';
      const itemSelector = '[li-render-paginate="item"]';

      const updateCount = (loaded, total) => {
        if (!countDisplay) return;
        const template = countDisplay.getAttribute('li-render-paginate-count-text') || countDisplay.textContent;
        countDisplay.textContent = template.replace('{loaded}', loaded).replace('{total}', total);
      };

      // Load-more (append) mode.
      if (button) {
        let nextPage = (parseInt(new URLSearchParams(window.location.search).get(pageParam), 10) || 1) + 1;
        let loaded = list.querySelectorAll(itemSelector).length;

        button.addEventListener('click', async () => {
          const params = new URLSearchParams(window.location.search);
          params.set('section_id', sectionId);
          params.set(pageParam, nextPage);
          const url = `${window.location.pathname}?${params}`;

          emit('liquiflow:before-render', { url, type: 'paginate' });
          emit('liquiflow:paginate-before-render', { url });

          const busyLabel = button.getAttribute('li-render-paginate-loading-text');
          const idleLabel = button.textContent;
          button.disabled = true;
          if (busyLabel) button.textContent = busyLabel;

          try {
            let doc = cache.get(url);
            if (!doc) {
              const response = await fetch(url, { signal: nextSignal(`paginate:${sectionId}`) });
              if (!response.ok) throw new Error(`[paginate] Fetch failed (${response.status})`);
              doc = parser.parseFromString(await response.text(), 'text/html');
              cache.set(url, doc);
            }

            const newWrapper = doc.querySelectorAll(wrapperSelector)[index] || doc.querySelector(wrapperSelector);
            const newItems = newWrapper ? newWrapper.querySelectorAll(itemSelector) : [];

            if (newItems.length) {
              newItems.forEach((item) => list.appendChild(document.importNode(item, true)));
              loaded += newItems.length;
              updateCount(loaded, newWrapper.querySelector('[li-render-paginate="total"]')?.value);
              nextPage += 1;
              button.disabled = false;
              if (busyLabel) button.textContent = idleLabel;

              // Liquid only renders the button while a next page exists.
              if (!newWrapper.querySelector('[li-render-paginate="button"]')) button.style.display = 'none';

              emit('liquiflow:paginate-rendered', { url, mode: 'load-more' });
              emit('liquiflow:sections-rendered', { url, type: 'paginate' });
            } else {
              button.style.display = 'none';
            }
          } catch (error) {
            if (error.name !== 'AbortError') console.error('[liquiflow]', error.message || error);
            button.disabled = false;
            if (busyLabel) button.textContent = idleLabel;
          }
        });
      }

      // Numbered pagination (replace) mode.
      wrapper.addEventListener('click', (e) => {
        const link = e.target.closest('[li-render-paginate="link"]');
        if (!link || !wrapper.contains(link)) return;
        e.preventDefault();
        const href = link.getAttribute('href') || link.getAttribute('li-render-paginate-value');
        if (!href) return;
        const parsed = new URL(href, window.location.origin);
        parsed.searchParams.set('section_id', sectionId);
        history.replaceState(null, '', href);
        renderSection({
          url: parsed.toString(),
          wrapperSelector,
          type: 'paginate',
          channel: `paginate:${sectionId}`,
          morph: morphOn,
        });
      });
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

      wrapper.addEventListener('change', (e) => {
        const control = e.target.closest('[li-render-product-option-id]');
        if (!control || !wrapper.contains(control)) return;
        if ((control.type === 'radio' || control.type === 'checkbox') && !control.checked) return;
        this.render(wrapper, { sectionId, productUrl, morph: morphOn, control });
      });
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

      const optionValues = this.collectOptionValues(wrapper);
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
    scope.querySelectorAll('[li-render-paginate="wrapper"]').forEach((w, i) => Pagination.init(w, i));
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
    _internal: { morph, debounce, getSectionId, nextSignal },
  };

  window.liquiflowRenderer = liquiflowRenderer;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Re-initialise a section's wrappers when re-rendered in the Theme Editor.
  document.addEventListener('shopify:section:load', (e) => initSection(e.target));
})();
