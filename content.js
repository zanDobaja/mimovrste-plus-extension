/**
 * Mimovrste+ (Napredno razvrščanje in filtri)
 * Content Script — popolnoma naravna integracija v Mimovrste.com DOM
 */

(function () {
  'use strict';

  // Privzete nastavitve razširitve
  const DEFAULT_SETTINGS = {
    enableSortReviews: true,       // Največ ocen
    enableSortRating: true,        // Najbolje ocenjeno
    enableSortDiscountPct: true,   // Največji popust (%)
    enableSortDiscountEur: false,  // Največji prihranek (€)
    enableSidebarFilters: true,    // Dodatni filtri v levem stolpcu
    maxPagesToFetch: 5             // Koliko strani kategorije naj samodejno preišče pri razvrščanju
  };

  let settings = { ...DEFAULT_SETTINGS };

  // Trenutno stanje razvrščanja in filtrov na strani
  let state = {
    activeSort: null, // null | 'reviews_desc' | 'rating_desc' | 'discount_pct' | 'discount_eur'
    filters: {
      onlyWithReviews: false,
      minRating4: false,
      onlyDiscounted: false,
      onlyMimovrsteDirect: false
    },
    sidebarCollapsed: false,
    lastUrlKey: '',
    fetchedPages: new Set(),
    isFetchingPages: false,
    fetchedCount: 0,
    totalTargetPages: 1,
    totalCategoryItems: null,
    originalCountText: ''
  };

  // Definicija dodatnih možnosti razvrščanja
  const CUSTOM_SORTS = [
    {
      id: 'reviews_desc',
      label: 'Največ ocen',
      settingKey: 'enableSortReviews',
      title: 'Razvrsti izdelke po največjem številu ocen kupcev'
    },
    {
      id: 'rating_desc',
      label: 'Najbolje ocenjeno',
      settingKey: 'enableSortRating',
      title: 'Razvrsti izdelke po najvišji oceni in številu mnenj'
    },
    {
      id: 'discount_pct',
      label: 'Največji popust',
      settingKey: 'enableSortDiscountPct',
      title: 'Razvrsti izdelke po največjem odstotku znižanja (%)'
    },
    {
      id: 'discount_eur',
      label: 'Največji prihranek',
      settingKey: 'enableSortDiscountEur',
      title: 'Razvrsti izdelke po največjem prihranku v €'
    }
  ];

  // Definicija dodatnih filtrov v stranski vrstici
  const CUSTOM_FILTERS = [
    {
      id: 'onlyWithReviews',
      label: 'Samo ocenjeni izdelki',
      matchFn: (metrics) => metrics.reviewCount > 0
    },
    {
      id: 'minRating4',
      label: 'Ocena 4★ ali več',
      matchFn: (metrics) => metrics.reviewCount > 0 && metrics.starRating >= 4
    },
    {
      id: 'onlyDiscounted',
      label: 'Samo znižani izdelki',
      matchFn: (metrics) => metrics.discountEur > 0.01 || metrics.discountPct > 0.1
    },
    {
      id: 'onlyMimovrsteDirect',
      label: 'Samo Mimovrste (brez partnerjev)',
      matchFn: (metrics) => !metrics.isPartner
    }
  ];

  /**
   * Naloži nastavitve iz chrome.storage.sync
   */
  function loadSettings(callback) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
        settings = { ...DEFAULT_SETTINGS, ...stored };
        if (callback) callback();
      });
    } else {
      if (callback) callback();
    }
  }

  // Poslušaj spremembe nastavitev iz popup okna
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      for (const key of Object.keys(changes)) {
        settings[key] = changes[key].newValue;
      }
      refreshUI();
    });
  }

  /**
   * Ustvari ključ trenutnega URL-ja (brez pagination parametra),
   * da vemo, kdaj uporabnik zamenja kategorijo ali osnovni filter.
   */
  function getUrlKey() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('pagination');
      return u.pathname + '?' + u.searchParams.toString();
    } catch (e) {
      return window.location.href;
    }
  }

  /**
   * Poišče glavni vsebnik z izdelki na strani kategorije ali iskanja.
   */
  function getProductContainer() {
    const container = document.querySelector(
      '.category-products-wrap .category-products, .category-products-wrap .category-products-wide, .category-products, .category-products-wide'
    );
    if (container) return container;

    const firstCard = document.querySelector('[data-scroll-product-id]');
    return firstCard ? firstCard.parentElement : null;
  }

  /**
   * Vrne vse kartice izdelkov v vsebniku.
   */
  function getProductCards(container) {
    const target = container || getProductContainer();
    if (!target) return [];
    const children = Array.from(target.children).filter((el) => {
      return (
        el.hasAttribute('data-scroll-product-id') ||
        el.querySelector('[data-scroll-product-id]') ||
        el.classList.contains('pbcr') ||
        el.classList.contains('pbcrw') ||
        el.classList.contains('category-products__wishlist')
      );
    });
    return children;
  }

  /**
   * Pretvori slovenski zapis cene (npr. "1.249,90 €" ali "Prihranite 15,50 €") v število.
   */
  function parsePriceText(text) {
    if (!text) return 0;
    const match = text.replace(/\./g, '').match(/(\d+(?:,\d+)?)/);
    if (!match) return 0;
    const val = parseFloat(match[1].replace(',', '.'));
    return isNaN(val) ? 0 : val;
  }

  /**
   * Izlušči vse podatke o izdelku iz DOM kartice (število ocen, zvezdice, cena, popust, prodajalec).
   */
  function extractCardMetrics(card, index) {
    if (!card.hasAttribute('data-mvplus-orig-index')) {
      card.setAttribute('data-mvplus-orig-index', String(index));
    }
    const origIndex = parseInt(card.getAttribute('data-mvplus-orig-index') || String(index), 10);

    const productId =
      card.getAttribute('data-scroll-product-id') ||
      card.querySelector('[data-scroll-product-id]')?.getAttribute('data-scroll-product-id') ||
      card.querySelector('[product-id]')?.getAttribute('product-id') ||
      '';

    // 1. Število ocen (npr. "124x")
    const ratingCountEl = card.querySelector('[data-testid="rating-count"], .rating-wrapper__count');
    let reviewCount = 0;
    if (ratingCountEl) {
      const digits = (ratingCountEl.textContent || '').replace(/[^\d]/g, '');
      reviewCount = digits ? parseInt(digits, 10) : 0;
    }

    // 2. Število zvezdic (0 do 5)
    let starRating = 0;
    if (reviewCount > 0) {
      const activeStars = card.querySelectorAll('.rating__star__icon--active').length;
      starRating = activeStars > 0 ? activeStars : 0;
    }

    // Utežena ocena za pametno razvrščanje "Najbolje ocenjeno"
    // Izdelki z več ocenami pri isti oceni zvezdic imajo prednost
    const weightedRating =
      reviewCount > 0
        ? starRating + Math.min(0.99, Math.log10(reviewCount + 1) / 4)
        : 0;

    // 3. Trenutna cena
    let price = 0;
    const priceEl = card.querySelector('[data-sel="product-box-price"], .pb-price__price, .pbcrw__price');
    if (priceEl) {
      // Vzamemo prvo značko <span> ali tekstovno vozlišče, da ne vključimo značke "Prihranite X €"
      const firstSpan = priceEl.querySelector('span');
      const rawPriceText = firstSpan ? firstSpan.textContent : priceEl.childNodes[0]?.textContent || priceEl.textContent;
      price = parsePriceText(rawPriceText);
    }

    // 4. Stara cena in popust
    let oldPrice = 0;
    const oldPriceEl = card.querySelector('.pb-price__price-old, .pbcrw__price-old');
    if (oldPriceEl) {
      oldPrice = parsePriceText(oldPriceEl.textContent);
    }

    let discountEur = 0;
    let discountPct = 0;
    const badgeEl = card.querySelector('[data-testid="product-box-discount-badge"], .pb-price__saveup, .pbcrw__saveup');
    const badgeText = badgeEl ? badgeEl.textContent || '' : '';

    if (oldPrice > price && price > 0) {
      discountEur = Math.max(0, oldPrice - price);
      discountPct = (discountEur / oldPrice) * 100;
    } else if (badgeText) {
      if (badgeText.includes('%')) {
        discountPct = parsePriceText(badgeText);
        if (price > 0 && discountPct > 0 && discountPct < 100) {
          oldPrice = price / (1 - discountPct / 100);
          discountEur = oldPrice - price;
        }
      } else {
        discountEur = parsePriceText(badgeText);
        if (price > 0 && discountEur > 0) {
          oldPrice = price + discountEur;
          discountPct = (discountEur / oldPrice) * 100;
        }
      }
    }

    // 5. Ali prodaja Marketplace partner ali neposredno Mimovrste
    const isPartner = Boolean(
      card.querySelector('[data-testid="partner-link"], .marketplace-partner__link, .marketplace-partner')
    );

    return {
      card,
      productId,
      origIndex,
      reviewCount,
      starRating,
      weightedRating,
      price,
      oldPrice,
      discountEur,
      discountPct,
      isPartner
    };
  }

  /**
   * Uredi in filtrira vse kartice v vsebniku glede na izbrano razvrščanje in filtre.
   */
  function applySortAndFilters() {
    const container = getProductContainer();
    if (!container) return;

    const cards = getProductCards(container);
    if (cards.length === 0) return;

    const metricsList = cards.map((card, idx) => extractCardMetrics(card, idx));

    // Posodobi števce v stranskih filtrih
    updateFilterCounts(metricsList);

    // 1. Filtriraj kartice
    const activeFilterFns = CUSTOM_FILTERS.filter((f) => state.filters[f.id]).map((f) => f.matchFn);
    let visibleCount = 0;

    for (const item of metricsList) {
      const passesAll = activeFilterFns.every((fn) => fn(item));
      if (passesAll) {
        item.card.classList.remove('mvplus-hidden-card');
        visibleCount++;
      } else {
        item.card.classList.add('mvplus-hidden-card');
      }
    }

    // 2. Razvrsti kartice
    if (state.activeSort) {
      metricsList.sort((a, b) => {
        switch (state.activeSort) {
          case 'reviews_desc':
            if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount;
            if (b.starRating !== a.starRating) return b.starRating - a.starRating;
            return a.origIndex - b.origIndex;

          case 'rating_desc':
            if (b.weightedRating !== a.weightedRating) return b.weightedRating - a.weightedRating;
            if (b.reviewCount !== a.reviewCount) return b.reviewCount - a.reviewCount;
            return a.origIndex - b.origIndex;

          case 'discount_pct':
            if (Math.abs(b.discountPct - a.discountPct) > 0.05) return b.discountPct - a.discountPct;
            if (Math.abs(b.discountEur - a.discountEur) > 0.05) return b.discountEur - a.discountEur;
            return a.origIndex - b.origIndex;

          case 'discount_eur':
            if (Math.abs(b.discountEur - a.discountEur) > 0.05) return b.discountEur - a.discountEur;
            if (Math.abs(b.discountPct - a.discountPct) > 0.05) return b.discountPct - a.discountPct;
            return a.origIndex - b.origIndex;

          default:
            return a.origIndex - b.origIndex;
        }
      });

      const frag = document.createDocumentFragment();
      for (const item of metricsList) {
        frag.appendChild(item.card);
      }
      container.appendChild(frag);
    }

    updateProductCountDisplay(metricsList.length, visibleCount);
  }

  /**
   * Prilagodi prikaz števila artiklov v desnem kotu vrstice za razvrščanje,
   * ter po potrebi ponudi gumb za nalaganje dodatnih strani.
   */
  function updateProductCountDisplay(loadedCount, visibleCount) {
    const countEl = document.querySelector('[data-sel="productCountNumber"], .sort__count-text');
    if (!countEl) return;

    // Shrani izvirno število vseh artiklov v kategoriji (npr. "206 artiklov")
    if (!state.originalCountText || !countEl.hasAttribute('data-mvplus-modified')) {
      const rawText = countEl.textContent ? countEl.textContent.trim() : '';
      if (rawText && !rawText.includes('(')) {
        state.originalCountText = rawText;
        const m = rawText.replace(/\./g, '').match(/(\d+)/);
        if (m) {
          state.totalCategoryItems = parseInt(m[1], 10);
        }
      }
    }

    const anyCustomActive =
      Boolean(state.activeSort) || Object.values(state.filters).some(Boolean);

    if (!anyCustomActive && !state.isFetchingPages) {
      if (state.originalCountText && countEl.hasAttribute('data-mvplus-modified')) {
        countEl.textContent = state.originalCountText;
        countEl.removeAttribute('data-mvplus-modified');
      }
      return;
    }

    countEl.setAttribute('data-mvplus-modified', 'true');
    const baseText = state.originalCountText || `${loadedCount} artiklov`;

    if (state.isFetchingPages) {
      countEl.innerHTML = `${baseText} <span class="mvplus-status-note">(stran ${state.fetchedCount}/${state.totalTargetPages}...)</span>`;
      return;
    }

    const anyFilterActive = Object.values(state.filters).some(Boolean);
    let infoHtml = baseText;

    if (anyFilterActive) {
      infoHtml = `${visibleCount} od ${loadedCount} artiklov`;
    } else if (state.fetchedPages.size > 1 && state.totalCategoryItems && loadedCount < state.totalCategoryItems) {
      infoHtml = `${ baseText } <span class="mvplus-status-note">(${loadedCount} pregledanih)</span>`;
    }

    // Če obstaja še več strani v kategoriji, dodaj diskretno povezavo za nalaganje naslednjih strani
    if (state.totalCategoryItems && loadedCount < state.totalCategoryItems) {
      infoHtml += ` <a class="mvplus-load-more-link" title="Preišči še naslednje strani kategorije za popolno razvrščanje">+ več strani</a>`;
    }

    countEl.innerHTML = infoHtml;

    const loadMoreBtn = countEl.querySelector('.mvplus-load-more-link');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fetchAdditionalPages(5, true);
      });
    }
  }

  /**
   * Normalizira SSR kartico iz fetch() zahteve, da se 100 % ujema s hidratizirano Nuxt kartico.
   */
  function normalizeFetchedCard(rawCard, referenceCard) {
    const productId =
      rawCard.getAttribute('data-scroll-product-id') ||
      rawCard.querySelector('[data-scroll-product-id]')?.getAttribute('data-scroll-product-id') ||
      rawCard.id ||
      '';

    // Odstrani začasno SSR min-height omejitev
    if (rawCard.style && rawCard.style.minHeight) {
      rawCard.style.minHeight = '';
    }
    rawCard.querySelectorAll('[style*="min-height"]').forEach((el) => {
      el.style.minHeight = '';
    });

    // Če obstoječe kartice na strani uporabljajo zunanji ovoj .category-products__wishlist
    let finalCard = rawCard;
    if (
      referenceCard &&
      referenceCard.classList.contains('category-products__wishlist') &&
      !rawCard.classList.contains('category-products__wishlist')
    ) {
      const hasInnerCard = Boolean(rawCard.querySelector('.pbcr, .pbcrw'));
      if (hasInnerCard) {
        rawCard.className = referenceCard.className;
        rawCard.removeAttribute('id');
        finalCard = rawCard;
      } else {
        const wrapper = document.createElement('div');
        wrapper.className = referenceCard.className;
        if (productId) {
          wrapper.setAttribute('data-scroll-product-id', productId);
        }
        rawCard.removeAttribute('id');
        wrapper.appendChild(rawCard);
        finalCard = wrapper;
      }
    }

    finalCard.setAttribute('data-mvplus-fetched', 'true');

    // Omogoči delovanje gumba "V košarico" tudi na karticah z drugih strani
    const addToCartBtn = finalCard.querySelector('[data-sel="add-to-cart-button-main"], .add-to-cart-list');
    const productLink = finalCard.querySelector('a[href*="/"]');
    if (addToCartBtn && productLink) {
      addToCartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = productLink.getAttribute('href');
      });
    }

    return finalCard;
  }

  /**
   * V ozadju naloži dodatne strani kategorije (prek SSR HTML),
   * da razvrščanje po številu ocen / popustu zajame širši nabor izdelkov.
   */
  async function fetchAdditionalPages(extraPagesCount, forceMore = false) {
    if (state.isFetchingPages) return;

    const maxPages = forceMore
      ? state.fetchedPages.size + extraPagesCount
      : Number(settings.maxPagesToFetch) || 1;

    if (maxPages <= 1) return;

    const container = getProductContainer();
    if (!container) return;

    const currentCards = getProductCards(container);
    if (currentCards.length === 0) return;

    // Ugotovi trenutno stran iz URL-ja
    const currentUrl = new URL(window.location.href);
    const currentPage = parseInt(currentUrl.searchParams.get('pagination') || '1', 10) || 1;
    state.fetchedPages.add(currentPage);

    // Izračunaj približno število strani v kategoriji
    const countEl = document.querySelector('[data-sel="productCountNumber"], .sort__count-text');
    if (countEl && !state.totalCategoryItems) {
      const m = (countEl.textContent || '').replace(/\./g, '').match(/(\d+)/);
      if (m) state.totalCategoryItems = parseInt(m[1], 10);
    }

    const perPage = Math.max(24, currentCards.length);
    const estimatedTotalPages = state.totalCategoryItems
      ? Math.ceil(state.totalCategoryItems / perPage)
      : maxPages;

    const targetMaxPage = Math.min(maxPages, estimatedTotalPages);
    const pagesToFetch = [];

    for (let p = 1; p <= targetMaxPage; p++) {
      if (!state.fetchedPages.has(p)) {
        pagesToFetch.push(p);
      }
    }

    if (pagesToFetch.length === 0) return;

    state.isFetchingPages = true;
    state.fetchedCount = state.fetchedPages.size;
    state.totalTargetPages = state.fetchedPages.size + pagesToFetch.length;
    updateProductCountDisplay(currentCards.length, currentCards.length);

    const urlSnapshot = getUrlKey();
    const existingIds = new Set(
      currentCards
        .map((c) => extractCardMetrics(c, 0).productId)
        .filter(Boolean)
    );
    const referenceCard = currentCards[0];

    try {
      // Naloži strani zaporedno v manjših skupinah (po 2 hkrati), da je prijazno do strežnika
      const batchSize = 2;
      for (let i = 0; i < pagesToFetch.length; i += batchSize) {
        if (getUrlKey() !== urlSnapshot) break;

        const batch = pagesToFetch.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map(async (pageNum) => {
            try {
              const pageUrl = new URL(window.location.href);
              if (pageNum === 1) {
                pageUrl.searchParams.delete('pagination');
              } else {
                pageUrl.searchParams.set('pagination', String(pageNum));
              }
              const resp = await fetch(pageUrl.toString(), {
                credentials: 'same-origin',
                headers: { Accept: 'text/html' }
              });
              if (!resp.ok) return { pageNum, html: null };
              const html = await resp.text();
              return { pageNum, html };
            } catch (err) {
              return { pageNum, html: null };
            }
          })
        );

        if (getUrlKey() !== urlSnapshot) break;

        const parser = new DOMParser();
        let addedAny = false;

        for (const { pageNum, html } of results) {
          state.fetchedPages.add(pageNum);
          state.fetchedCount++;
          if (!html) continue;

          const doc = parser.parseFromString(html, 'text/html');
          const fetchedContainer = doc.querySelector(
            '.category-products-wrap .category-products, .category-products-wrap .category-products-wide, .category-products, .category-products-wide'
          );
          if (!fetchedContainer) continue;

          const rawCards = Array.from(fetchedContainer.children).filter(
            (el) =>
              el.hasAttribute('data-scroll-product-id') ||
              el.querySelector('[data-scroll-product-id]') ||
              el.classList.contains('pbcr') ||
              el.classList.contains('pbcrw')
          );

          for (const rawCard of rawCards) {
            const pid =
              rawCard.getAttribute('data-scroll-product-id') ||
              rawCard.querySelector('[data-scroll-product-id]')?.getAttribute('data-scroll-product-id') ||
              rawCard.id ||
              '';
            if (pid && existingIds.has(pid)) continue;
            if (pid) existingIds.add(pid);

            const normalized = normalizeFetchedCard(rawCard, referenceCard);
            normalized.setAttribute(
              'data-mvplus-orig-index',
              String(container.children.length)
            );
            container.appendChild(normalized);
            addedAny = true;
          }
        }

        if (addedAny) {
          applySortAndFilters();
        } else {
          updateProductCountDisplay(getProductCards(container).length, getProductCards(container).length);
        }
      }
    } finally {
      state.isFetchingPages = false;
      applySortAndFilters();
    }
  }

  /**
   * Aktivira izbrani Mimovrste+ način razvrščanja.
   */
  function selectCustomSort(sortId) {
    state.activeSort = sortId;
    syncSortTabsVisualState();
    applySortAndFilters();
    fetchAdditionalPages(Number(settings.maxPagesToFetch) || 5, false);
  }

  /**
   * Ko uporabnik klikne na enega od izvornih Mimovrste zavihkov (npr. Priporočamo, Najnižji ceni),
   * ponastavi naše razvrščanje in odstrani priložene kartice z drugih strani, da Nuxt prevzame nadzor.
   */
  function handleNativeSortClick() {
    if (!state.activeSort) return;
    state.activeSort = null;

    // Odstrani kartice, ki so bile dodane z drugih strani, da Nuxt paginacija ostane čista
    document.querySelectorAll('[data-mvplus-fetched="true"]').forEach((el) => el.remove());

    // Povrni prvotni vrstni red trenutne strani
    const container = getProductContainer();
    if (container) {
      const cards = getProductCards(container);
      cards.sort((a, b) => {
        const ia = parseInt(a.getAttribute('data-mvplus-orig-index') || '0', 10);
        const ib = parseInt(b.getAttribute('data-mvplus-orig-index') || '0', 10);
        return ia - ib;
      });
      const frag = document.createDocumentFragment();
      cards.forEach((c) => frag.appendChild(c));
      container.appendChild(frag);
    }

    syncSortTabsVisualState();
    applySortAndFilters();
  }

  /**
   * Posodobi videz aktivnega zavihka v zgornji vrstici (.sort__wrap) in mobilnem oknu (.psm).
   */
  function syncSortTabsVisualState() {
    const sortWrap = document.querySelector('.sort-header__desktop .sort__wrap, .sort__wrap');
    if (sortWrap) {
      if (state.activeSort) {
        sortWrap.classList.add('mvplus-custom-sort-active');
      } else {
        sortWrap.classList.remove('mvplus-custom-sort-active');
      }

      sortWrap.querySelectorAll('[data-mvplus-sort]').forEach((btn) => {
        const isCurrent = btn.getAttribute('data-mvplus-sort') === state.activeSort;
        if (isCurrent) {
          btn.classList.add('sort__item__button--active');
          btn.setAttribute('data-mvplus-active', 'true');
        } else {
          btn.classList.remove('sort__item__button--active');
          btn.removeAttribute('data-mvplus-active');
        }
      });
    }

    // Mobilni modal (.psm)
    const mobilePsm = document.querySelector('.psm');
    if (mobilePsm) {
      if (state.activeSort) {
        mobilePsm.classList.add('mvplus-custom-sort-active');
      } else {
        mobilePsm.classList.remove('mvplus-custom-sort-active');
      }

      mobilePsm.querySelectorAll('[data-mvplus-sort]').forEach((item) => {
        const isCurrent = item.getAttribute('data-mvplus-sort') === state.activeSort;
        if (isCurrent) {
          item.classList.add('psm__item--active');
          item.setAttribute('data-mvplus-active', 'true');
        } else {
          item.classList.remove('psm__item--active');
          item.removeAttribute('data-mvplus-active');
        }
      });
    }
  }

  /**
   * Vstavi dodatne zavihke za razvrščanje v zgornjo vrstico (.sort__wrap) in mobilni meni (.psm).
   */
  function injectSortTabs() {
    const sortWrap = document.querySelector('.sort-header__desktop .sort__wrap, .sort__wrap');
    if (sortWrap) {
      // Pripni poslušalce na izvorne Mimovrste gumbe za razvrščanje
      sortWrap.querySelectorAll('.sort__item__button:not([data-mvplus-sort])').forEach((nativeBtn) => {
        if (!nativeBtn.hasAttribute('data-mvplus-listener')) {
          nativeBtn.setAttribute('data-mvplus-listener', 'true');
          nativeBtn.addEventListener('click', () => {
            handleNativeSortClick();
          });
        }
      });

      // Odstrani morebitne stare gumbe, če so se spremenile nastavitve
      sortWrap.querySelectorAll('.mvplus-sort-item').forEach((el) => el.remove());

      for (const sortDef of CUSTOM_SORTS) {
        if (!settings[sortDef.settingKey]) continue;

        const li = document.createElement('li');
        li.className = 'sort__item mvplus-sort-item';

        const a = document.createElement('a');
        a.className = 'sort__item__button';
        a.setAttribute('data-testid', 'button');
        a.setAttribute('data-mvplus-sort', sortDef.id);
        a.setAttribute('title', sortDef.title);
        a.textContent = sortDef.label;

        if (state.activeSort === sortDef.id) {
          a.classList.add('sort__item__button--active');
          a.setAttribute('data-mvplus-active', 'true');
        }

        a.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectCustomSort(sortDef.id);
        });

        li.appendChild(a);
        sortWrap.appendChild(li);
      }

      syncSortTabsVisualState();
    }

    // Mobilni meni (.psm), če je odprt
    const mobilePsm = document.querySelector('.psm');
    if (mobilePsm) {
      mobilePsm.querySelectorAll('.psm__item:not([data-mvplus-sort])').forEach((nativeItem) => {
        if (!nativeItem.hasAttribute('data-mvplus-listener')) {
          nativeItem.setAttribute('data-mvplus-listener', 'true');
          nativeItem.addEventListener('click', () => {
            handleNativeSortClick();
          });
        }
      });

      mobilePsm.querySelectorAll('.mvplus-psm-item').forEach((el) => el.remove());

      for (const sortDef of CUSTOM_SORTS) {
        if (!settings[sortDef.settingKey]) continue;

        const item = document.createElement('div');
        item.className = 'psm__item mvplus-psm-item';
        item.setAttribute('data-mvplus-sort', sortDef.id);
        if (state.activeSort === sortDef.id) {
          item.classList.add('psm__item--active');
          item.setAttribute('data-mvplus-active', 'true');
        }

        const titleDiv = document.createElement('div');
        titleDiv.className = 'psm__item-title font-big';
        titleDiv.textContent = sortDef.label;
        item.appendChild(titleDiv);

        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          selectCustomSort(sortDef.id);
        });

        mobilePsm.appendChild(item);
      }
    }
  }

  /**
   * Vstavi naravni sklop filtrov ("Ocene in ponudba") v levi stolpec s filtri (.product-filter).
   */
  function injectSidebarFilters() {
    const existingBlock = document.querySelector('.mvplus-sidebar-filter');
    if (!settings.enableSidebarFilters) {
      if (existingBlock) existingBlock.remove();
      return;
    }

    const filterSidebar = document.querySelector(
      '.product-filter.product-filter__redesign, .product-filter, .products-filter__redesign .product-filter-wrap'
    );
    if (!filterSidebar) return;

    if (existingBlock) return; // Že vstavljeno

    const wrapper = document.createElement('div');
    wrapper.className = 'product-filter__item mvplus-sidebar-filter';
    if (state.sidebarCollapsed) {
      wrapper.classList.add('mvplus-collapsed');
    }

    const checkboxesHtml = CUSTOM_FILTERS.map((f) => {
      const checkedAttr = state.filters[f.id] ? 'checked' : '';
      return `
        <label class="checkbox checkbox-group__item checkbox--redesign" data-mvplus-filter-label="${f.id}">
          <input type="checkbox" data-mvplus-filter="${f.id}" ${checkedAttr}>
          <span class="checkbox__box"></span>
          <div class="checkbox__content-wrapper">
            <span class="checkbox__content">
              <span>${f.label}</span>
            </span>
            <span class="checkbox__count-redesign" data-mvplus-filter-count="${f.id}">
              (0)
            </span>
          </div>
        </label>
      `;
    }).join('');

    wrapper.innerHTML = `
      <div data-testid="drop-down" class="drop-down">
        <div data-testid="drop-down-trigger" class="drop-down__trigger">
          <div>
            <span class="product-filter__item__title-wrapper">
              <h6 class="product-filter__item__title product-filter__item__title--open">
                Ocene in ponudba
              </h6>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -3 11 12" data-iconname="arrow1313className" class="icon product-filter__item__icon-arrow product-filter__item__icon-arrow--expanded" style="height: 13px; width: 13px;">
                <path fill="currentColor" d="M5.532 6.268L.943 1.679A.811.811 0 012.09.532l4.016 4.015L10.12.532a.811.811 0 111.147 1.147L6.679 6.268a.811.811 0 01-1.147 0z"></path>
              </svg>
            </span>
          </div>
        </div>
        <div data-testid="drop-down-drawer" class="drop-down__drawer">
          <div class="product-filter__list">
            <div class="product-filter__list__content product-filter__list__content--redesign">
              <div class="checkbox-group">
                ${checkboxesHtml}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Vstavi na vrh seznama filtrov v levi vrstici
    filterSidebar.insertBefore(wrapper, filterSidebar.firstChild);

    // Harmonika (odpiranje/zapiranje sklopa)
    const trigger = wrapper.querySelector('.drop-down__trigger');
    if (trigger) {
      trigger.addEventListener('click', () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        wrapper.classList.toggle('mvplus-collapsed', state.sidebarCollapsed);
      });
    }

    // Poslušalci za potrditvena polja
    wrapper.querySelectorAll('input[data-mvplus-filter]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const filterId = e.target.getAttribute('data-mvplus-filter');
        state.filters[filterId] = Boolean(e.target.checked);
        applySortAndFilters();
        if (state.filters[filterId]) {
          fetchAdditionalPages(Number(settings.maxPagesToFetch) || 5, false);
        }
      });
    });

    // Izračunaj začetne števce
    const container = getProductContainer();
    if (container) {
      const cards = getProductCards(container);
      const metricsList = cards.map((c, idx) => extractCardMetrics(c, idx));
      updateFilterCounts(metricsList);
    }
  }

  /**
   * Posodobi število ujemajočih izdelkov "(N)" ob vsakem filtru v stranski vrstici.
   */
  function updateFilterCounts(metricsList) {
    for (const f of CUSTOM_FILTERS) {
      const countSpan = document.querySelector(`[data-mvplus-filter-count="${f.id}"]`);
      if (!countSpan) continue;
      const count = metricsList.filter((m) => f.matchFn(m)).length;
      countSpan.textContent = `(${count})`;
    }
  }

  /**
   * Preveri, ali se je spremenil URL (kategorija ali osnovni filter), in ponastavi stanje strani.
   */
  function checkNavigationReset() {
    const currentKey = getUrlKey();
    if (state.lastUrlKey && state.lastUrlKey !== currentKey) {
      state.fetchedPages.clear();
      state.isFetchingPages = false;
      state.totalCategoryItems = null;
      state.originalCountText = '';
      // Če uporabnik zamenja stran ali filter, ohranimo izbrane stranske filtre in ponovno uveljavimo aktivno razvrščanje
    }
    state.lastUrlKey = currentKey;
  }

  /**
   * Osveži vse komponente vmesnika na strani.
   */
  function refreshUI() {
    checkNavigationReset();

    const sortWrap = document.querySelector('.sort-header__desktop .sort__wrap, .sort__wrap');
    if (sortWrap && !sortWrap.querySelector('.mvplus-sort-item')) {
      injectSortTabs();
    } else if (sortWrap) {
      // Preveri, ali število gumbov ustreza nastavitvam
      const expectedCount = CUSTOM_SORTS.filter((s) => settings[s.settingKey]).length;
      const currentCount = sortWrap.querySelectorAll('.mvplus-sort-item').length;
      if (expectedCount !== currentCount) {
        injectSortTabs();
      } else {
        syncSortTabsVisualState();
      }
    }

    const mobilePsm = document.querySelector('.psm');
    if (mobilePsm && !mobilePsm.querySelector('.mvplus-psm-item')) {
      injectSortTabs();
    }

    injectSidebarFilters();

    const container = getProductContainer();
    if (container) {
      const cards = getProductCards(container);
      const metricsList = cards.map((c, idx) => extractCardMetrics(c, idx));
      updateFilterCounts(metricsList);

      if (state.activeSort || Object.values(state.filters).some(Boolean)) {
        applySortAndFilters();
      }
    }
  }

  // Debounce za MutationObserver, da ne obremenjujemo brskalnika med Nuxt osveževanjem
  let debounceTimer = null;
  function scheduleRefresh() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      refreshUI();
    }, 120);
  }

  // Zaženi ob nalaganju
  loadSettings(() => {
    refreshUI();

    const observer = new MutationObserver((mutations) => {
      let shouldUpdate = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) {
              if (
                node.classList?.contains('mvplus-sort-item') ||
                node.classList?.contains('mvplus-psm-item') ||
                node.classList?.contains('mvplus-sidebar-filter') ||
                node.hasAttribute?.('data-mvplus-fetched')
              ) {
                continue;
              }
              shouldUpdate = true;
              break;
            }
          }
        }
        if (shouldUpdate) break;
      }
      if (shouldUpdate) {
        scheduleRefresh();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  });
})();
