document.addEventListener('DOMContentLoaded', () => {
  const filterWrapper = document.querySelectorAll('[li-render="filter-wrapper"]');
  const recWrapper = document.querySelectorAll('[li-render="recommendations-wrapper"]')
  const customWrapper = document.querySelectorAll('[li-render="custom-wrapper"]')
  const searchWrapper = document.querySelectorAll('[li-render="predictive-search-wrapper"]')

  let filterQuery = new URLSearchParams(window.location.search);
  let abortController = new AbortController();
  const abortSignal = abortController.signal;

  const createSearchQuery = (wrapper) => {
    const paramMap = {
      'li-render-rt': 'resources[type]',
      'li-render-rl': 'resources[limit]',
      'li-render-rls': 'resources[limit_scope]',
      'li-render-roup': 'resources[options][unavailable_products]',
      'li-render-rof': 'resources[options][fields]'
    };

    let searchQuery = new URLSearchParams();

    Object.entries(paramMap).forEach(([attr, param]) => {
      const value = wrapper.getAttribute(attr);
      if (value !== null) {
        searchQuery.append(param, value);
      }
    });

    return searchQuery;
  };

  const debounce = (callback, wait) => {
    let timeoutId = null;
    return (...args) => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        callback(...args);
      }, wait);
    };
  }

  const getSectionId = (element) => {
    const completeId = element.closest('section')?.id || element.closest('.shopify-section')?.id
    const realId = completeId?.match(/shopify-section-(.+)/) || ''

    if (realId === '') console.warn('[liquify][getSectionId] Could not get section id')

    return realId[1]
  }

  const setCheckboxFilter = () => {
    document.querySelectorAll('[li-render="filter"]').forEach(element => {
      const param = element.getAttribute('li-render-param-name')
      const value = element.getAttribute('li-render-value')
      const customCheckbox = element.parentElement.querySelector('div')

      if (!param || !value) return

      if (filterQuery.has(param, value)) {
        element.checked = true
        if (customCheckbox) {
          customCheckbox.classList.add('w--redirected-checked')
        }
      } else {
        element.checked = false
        if (customCheckbox) {
          customCheckbox.classList.remove('w--redirected-checked')
        }
      }
    })
  }

  const setPriceFilter = () => {
    if (filterQuery.has('filter.v.price.gte')) {
      document.querySelectorAll('[li-render="price-min"]').forEach(element => {
        element.value = filterQuery.get('filter.v.price.gte')
      })
    }

    if (filterQuery.has('filter.v.price.lte')) {
      document.querySelectorAll('[li-render="price-max"]').forEach(element => {
        element.value = filterQuery.get('filter.v.price.lte')
      })
    }
  }


  const renderSection = async (fetchUrl, wrapper, target = null, type = '') => {
    try {
      if (abortController) {
        abortController.abort();
      }

      abortController = new AbortController();

      const response = await fetch(fetchUrl, { abortSignal });

      if (!response.ok) {
        throw new Error(`[liquify][renderSection] Error fetching section, response status: ${response.status}`);
      }

      let newHtml;
      try {
        newHtml = await response.text();
      } catch (error) {
        throw new Error('[liquify][renderSection] Failed to parse response text.');
      }

      const parser = new DOMParser();
      let newDocument;
      try {
        newDocument = parser.parseFromString(newHtml, 'text/html');
      } catch (error) {
        throw new Error('[liquify][renderSection] Failed to parse HTML content.');
      }

      const newElements = target ? newDocument.querySelectorAll(target) : newDocument.querySelectorAll(wrapper);

      if (newElements.length > 0) {
        const currentElements = target ? document.querySelectorAll(target) : document.querySelectorAll(wrapper);

        if (currentElements.length === newElements.length) {
          currentElements.forEach((currentElement, index) => {
            currentElement.innerHTML = newElements[index].innerHTML;
          });

          if (!target) initializeFilters();
          setCheckboxFilter();
          setPriceFilter();

          if (target) {
            // Custom render handling
            newDocument.querySelectorAll('[li-render-custom-source]').forEach(element => {
              const value = element.value
              const customName = element.getAttribute('li-render-custom-source')
              const customTarget = document.querySelectorAll(`[li-render-custom-target="${customName}"]`)

              if (!value || customTarget.length === 0) {
                console.log('[liquify][renderSection] If you want to show the li-render-custom value, you have to add a value to the element and also create a target and mark it with li-render-custom-target="TARGET_NAME". The target name must match the li-render-custom name.')
                return
              }

              customTarget.forEach(target => {
                target.textContent = value
              })
            })

            // Set active filter states or disable all inactive filters and show the filter count
            newDocument.querySelectorAll('[li-render="filter"]').forEach(element => {
              const param = element.getAttribute('li-render-param-name')
              const value = element.getAttribute('li-render-value')
              const countSource = element.getAttribute('li-render-count')
              const countNumber = parseInt(countSource, 10)

              if (!param || !value || !countSource) {
                console.log(`[liquify][renderSection] If you want to show the counts, please add the following attributes to the li-render="filter" element: 
                  li-render-count="{{ filter_value.count }}", li-render-value="{{ filter_value.value }}", li-render-param-name="{{ filter_value.param_name }}".`)
                return
              }

              document.querySelectorAll(`[li-render-param-name="${param}"][li-render-value="${value}"]`).forEach(filterElement => {
                const countTarget = filterElement.parentElement.querySelector('[li-render="count-value"]')
                countNumber === 0 ? filterElement.classList.add('is-disabled') : filterElement.classList.remove('is-disabled')
                if (countTarget) countTarget.textContent = countNumber
              })
            })
          }

          document.dispatchEvent(new CustomEvent('liquify:sections-rendered', {
            bubbles: true,
            cancelable: false
          }));

          if (type) {
            document.dispatchEvent(new CustomEvent(`liquify:${type}-rendered`, {
              bubbles: true,
              cancelable: false
            }));
          }

        } else {
          console.warn('[liquify][renderSection] Mismatch in element count between current and new content.');
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('[liquify][renderSection] Request was aborted.');
      } else {
        console.error(error.message);
      }
    }
  };


  searchWrapper.forEach((wrapper) => {
    const input = wrapper.querySelector('[li-render="predictive-search-input"]');
    const sectionId = getSectionId(wrapper)
    const searchQuery = createSearchQuery(wrapper)

    if (input) {
      input.addEventListener(
        'input',
        debounce(() => {
          const searchTerm = input.value.trim();
          let searchUrl = window.Shopify.routes.root + 'search/suggest'
          searchQuery.size === 0 ? searchUrl += `?q=${searchTerm}&section_id=${sectionId}` : searchUrl += `?q=${searchTerm}&section_id=${sectionId}&${searchQuery}`

          if (searchTerm) {
            renderSection(searchUrl, '[li-render="predictive-search-wrapper"]', '[li-render="predictive-search-target"]', 'predictive-search')
          };
          console.log('[liquify][searchWrapper] Search path:', searchUrl)
        }, 300)
      );
    }
  });



  const initializeFilters = () => {
    filterWrapper.forEach((wrapper) => {
      const submitButtons = wrapper.querySelectorAll('[li-render="submit-button"]')
      const filterTarget = wrapper.querySelector('[li-render="filter-target"]')
      const sectionId = getSectionId(wrapper)

      const handleTarget = (completeFilterQuery) => {
        console.log('[liquify][filterWrapper] Filter path:', completeFilterQuery)
        history.replaceState(null, '', window.location.pathname + (filterQuery.size > 0 ? '?' + filterQuery : ''));
        filterTarget ? renderSection(completeFilterQuery, '[li-render="filter-wrapper"]', '[li-render="filter-target"]', 'filter') : renderSection(completeFilterQuery, '[li-render="filter-wrapper"]', undefined, 'filter')
      }

      const getQueryParam = (param = '', value = '', render = false, uniqueValue = false, priceRemove = false) => {
        if (filterQuery.has(param) && uniqueValue === true && priceRemove === false) {
          filterQuery.set(param, value)
        } else if ((filterQuery.has(param, value) && uniqueValue === false) || priceRemove === true) {
          value === '' ? filterQuery.delete(param) : filterQuery.delete(param, value)
        } else {
          filterQuery.append(param, value)
        }

        if (filterQuery.has('page')) {
          filterQuery.delete('page')
        }

        completeFilterQuery = filterQuery.size > 0 ? '?section_id=' + sectionId + '&' + filterQuery : ''

        if (submitButtons.length === 0 || render === true) {
          handleTarget(completeFilterQuery)
          return;
        }
      };

      if (submitButtons.length > 0) {
        submitButtons.forEach(button => {
          button.addEventListener('click', (e) => {
            e.preventDefault();
            handleTarget(completeFilterQuery)
          });
        })
      }

      wrapper
        .querySelectorAll('[li-render="filter"]')
        .forEach((element) => {
          const trigger = element.getAttribute('li-render-tigger') || "change"
          element.addEventListener(trigger, (e) => {
            const param = element.getAttribute('li-render-param-name')
            const value = element.getAttribute('li-render-value')
            getQueryParam(param, value);
          });
        });

      wrapper
        .querySelectorAll('[li-render="sort-select"]')
        .forEach((element) => {
          element.addEventListener("change", (e) => {
            getQueryParam('sort_by', element.value, true, true);
          });
        });

      wrapper
        .querySelectorAll('[li-render="sort-radio"]')
        .forEach((element) => {
          element.addEventListener("change", (e) => {
            const value = element.getAttribute('li-render-value')
            getQueryParam('sort_by', value, true, true);
          });
        });

      wrapper
        .querySelectorAll('[li-render="filter-remove"]')
        .forEach((element) => {
          element.addEventListener("click", (e) => {
            const removeFilter = element.getAttribute('li-render-value')
            renderSection(removeFilter, '[li-render="filter-wrapper"]', undefined, 'filter');
            history.replaceState(null, '', removeFilter);
          });
        });


      wrapper.querySelectorAll('[li-render="filter-search"]').forEach(element => {
        const form = element.closest('form')
        const searchQuery = createSearchQuery(wrapper)
        let inputValue = element.value

        element.addEventListener('input',
          debounce(() => {
            inputValue = element.value

            if (window.location.pathname === '/search') {
              getQueryParam('q', inputValue, undefined, true);
            }

            console.log('[liquify][filterWrapper] Search input value:', inputValue)
          }, 300)
        )

        if (inputValue !== '' && window.location.pathname !== '/search' && form) {
          form.addEventListener('submit', (e) => {
            e.preventDefault()
            form.action = `/search?${searchQuery}&q=${inputValue}`
            form.submit()
          })
        }
      })

      wrapper
        .querySelectorAll('[li-render="clear-all"]')
        .forEach((element) => {
          element.addEventListener('click', (e) => {
            const value = element.getAttribute('li-render-value')

            if (!value) {
              console.warn(`[liquify][filterWrapper] Unable to clear all filters because of one missing attribute.
                Please add the attribute li-render-value="{{ routes.search_url }}" on search pages or li-render-value="{{ collection.url }}" on collection pages to the li-render="clear-all" button`)
              return
            }

            filterQuery = new URLSearchParams()
            history.replaceState(null, '', window.location.pathname);
            renderSection(value, '[li-render="filter-wrapper"]', undefined, 'filter')
          });
        });

      wrapper.querySelectorAll('[li-render="price-min"]').forEach(element => {
        element.addEventListener('blur', () => {
          if (element.value.length === 0) {
            getQueryParam('filter.v.price.gte', element.value, false, true, true);
            return
          }
          getQueryParam('filter.v.price.gte', element.value, false, true)
        })
      })

      wrapper.querySelectorAll('[li-render="price-max"]').forEach(element => {
        element.addEventListener('blur', () => {
          if (element.value.length === 0) {
            getQueryParam('filter.v.price.lte', element.value, false, true, true);
            return
          }
          getQueryParam('filter.v.price.lte', element.value, false, true)
        })
      })
    })
  };


  recWrapper.forEach((wrapper) => {
    const path = wrapper.getAttribute('li-render-path')
    const sectionId = getSectionId(wrapper) || ''
    const productId = wrapper.getAttribute('li-render-product-id')
    const limit = wrapper.getAttribute('li-render-limit') || 4;
    const intent = wrapper.getAttribute('li-render-intent') || 'related';

    if (sectionId === '') {
      console.warn(
        '[liquify][recWrapper] Unable to render product recommendations because of missing section ID'
      )
      return
    }

    if (path === '' || !path) {
      console.warn(
        '[liquify][recWrapper] Unable to render product recommendations because of missing path. Please add the attribute li-render-path="{{ routes.product_recommendations_url }}" to the li-render="recommendations-wrapper" element'
      )
      return
    }

    if (productId === '' || !productId) {
      console.warn(
        '[liquify][recWrapper] Unable to render product recommendations because of missing product ID. Please add the attribute li-render-product-id="{{ product.id }}" to the li-render="recommendations-wrapper" element'
      )
      return
    }

    let recQuery = new URLSearchParams()
    recQuery.append('section_id', sectionId)
    recQuery.append('product_id', productId)
    recQuery.append('limit', limit)
    recQuery.append('intent', intent)

    const fetchUrl = `${path}?${recQuery}`;
    renderSection(fetchUrl, '[li-render="recommendations-wrapper"]', undefined, 'recommendations');
    console.log('[liquify][recWrapper] Recommendations Path:', fetchUrl)
  });



  customWrapper.forEach(wrapper => {
    const target = wrapper.querySelector('[li-render="custom-target"]')
    let currentSearchParams = new URLSearchParams(window.location.search)

    const initializeCustomTrigger = () => {
      wrapper.querySelectorAll('[li-render-trigger]').forEach(element => {
        const triggerEvent = element.getAttribute('li-render-trigger')
        const value = element.getAttribute('li-render-value')
        let newSerchParams = new URLSearchParams(value)

        element.addEventListener(triggerEvent, (e) => {
          console.log('[liquify][customWrapper] Custom Path:', value)
          target ? renderSection(value, '[li-render="custom-wrapper"]', '[li-render="custom-target"]', 'custom') : renderSection(value, '[li-render="custom-wrapper"]', undefined, 'custom')

          if (newSerchParams.has('variant')) {
            const variantId = newSerchParams.get('variant')
            currentSearchParams.set('variant', variantId)
            history.replaceState(null, null, "?" + currentSearchParams.toString());
          }
        })
      })
    }

    if (wrapper.getAttribute('li-render-re-init')) {
      document.addEventListener('liquify:custom-rendered', (e) => {
        initializeCustomTrigger()
      })
    }

    initializeCustomTrigger()
  })


  initializeFilters();
  setPriceFilter();
  setCheckboxFilter();
});


document.addEventListener("liquify:filter-rendered", () => {
  console.log("[liquify][renderSection] Filter event fired")
})

document.addEventListener("liquify:custom-rendered", () => {
  console.log("[liquify][renderSection] Custom event fired")
})

document.addEventListener("liquify:predictive-search-rendered", () => {
  console.log("[liquify][renderSection] Predictive search event fired")
})

document.addEventListener("liquify:recommendations-rendered", () => {
  console.log("[liquify][renderSection] Recommendations event fired")
})

