const RESULTS_PER_PAGE = 24;
const SITE_TITLE = "Old English Room";
const PIN_STORAGE_KEY = "old-english-room:pinned-passages";
const appElement = document.querySelector("#app");

const state = {
  catalog: null,
  coverage: null,
  manifests: new Map(),
  chunks: new Map(),
  searchIndex: null,
  searchIndexPromise: null,
  renderId: 0,
  currentReader: null,
  pendingAnchor: null,
  pinnedPassages: [],
  pinTrayOpen: false,
};

let highlightInputTimer = 0;

bootstrap();

async function bootstrap() {
  bindEvents();
  state.pinnedPassages = loadPinnedPassages();

  try {
    const [coverage, catalog] = await Promise.all([
      fetchJson("./data/coverage.json"),
      fetchJson("./data/catalog.json"),
    ]);

    state.coverage = coverage;
    state.catalog = catalog;
    await render();
  } catch (error) {
    renderFatal(error);
  }
}

function bindEvents() {
  window.addEventListener("popstate", () => {
    render().catch(renderFatal);
  });

  document.addEventListener("input", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.matches("[data-route-input='highlight']")) {
      window.clearTimeout(highlightInputTimer);
      highlightInputTimer = window.setTimeout(() => {
        updateRoute(
          {
            highlight: target.value,
          },
          { replace: true },
        );
      }, 150);
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form instanceof HTMLFormElement && form.matches("[data-reader-search-form]")) {
      event.preventDefault();
      const formData = new FormData(form);
      const query = String(formData.get("highlight") ?? "").trim();
      const workSlug = String(form.getAttribute("data-work-slug") ?? "").trim();
      const route = getRoute();

      if (!workSlug) {
        return;
      }

      if (!query) {
        updateRoute(
          {
            highlight: null,
          },
          { replace: false },
        );
        return;
      }

      const manifest = await loadManifest(workSlug);
      const targetChunkSlug = await findFirstMatchingChunkSlug(manifest, query);

      updateRoute(
        {
          work: workSlug,
          chunk: targetChunkSlug ?? route.chunk ?? manifest.defaultChunkSlug,
          highlight: query,
        },
        { replace: false },
      );
      return;
    }

    if (!(form instanceof HTMLFormElement) || !form.matches("[data-search-form]")) {
      return;
    }

    event.preventDefault();
    const formData = new FormData(form);
    const query = String(formData.get("q") ?? "").trim();

    updateRoute(
      {
        q: query || null,
        page: 1,
      },
      { replace: false },
    );
  });

  document.addEventListener("change", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target instanceof HTMLSelectElement) {
      if (target.matches("[data-route-input='genre']")) {
        updateRoute({ genre: target.value, author: null, page: 1 }, { replace: true });
        return;
      }

      if (target.matches("[data-route-input='author']")) {
        updateRoute({ author: target.value || null, page: 1 }, { replace: true });
        return;
      }

      if (target.matches("[data-route-input='sort']")) {
        updateRoute({ sort: target.value, page: 1 }, { replace: true });
      }
    }

    if (target instanceof HTMLInputElement && target.type === "checkbox" && target.matches("[data-route-input='translated']")) {
      updateRoute({ translated: target.checked ? "1" : null, page: 1 }, { replace: true });
      return;
    }

    if (target instanceof HTMLInputElement && target.type === "checkbox" && target.matches("[data-route-input='complete']")) {
      updateRoute({ complete: target.checked ? "1" : null, page: 1 }, { replace: true });
    }
  });

  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-action]") : null;

    if (!button) {
      return;
    }

    const action = button.getAttribute("data-action");

    if (action === "clear-filters") {
      event.preventDefault();
      updateRoute(
        {
          q: null,
          genre: null,
          author: null,
          sort: null,
          translated: null,
          complete: null,
          page: null,
          tab: null,
        },
        { replace: false },
      );
      return;
    }

    if (action === "clear-highlight") {
      event.preventDefault();
      updateRoute({ highlight: null }, { replace: true });
      return;
    }

    if (action === "toggle-pin-tray") {
      event.preventDefault();
      state.pinTrayOpen = !state.pinTrayOpen;
      render().catch(renderFatal);
      return;
    }

    if (action === "close-pin-tray") {
      event.preventDefault();
      state.pinTrayOpen = false;
      render().catch(renderFatal);
      return;
    }

    if (action === "clear-pinned-passages") {
      event.preventDefault();
      state.pinnedPassages = [];
      savePinnedPassages(state.pinnedPassages);
      render().catch(renderFatal);
      return;
    }

    if (action === "toggle-pin-passage") {
      event.preventDefault();
      const passageId = String(button.getAttribute("data-passage-id") ?? "").trim();

      if (!passageId) {
        return;
      }

      const nextState = togglePinnedPassage(passageId);

      if (nextState.changed && isMobileViewport()) {
        state.pinTrayOpen = nextState.pinned;
      }

      render().catch(renderFatal);
      return;
    }

    if (action === "remove-pinned-passage") {
      event.preventDefault();
      const passageId = String(button.getAttribute("data-passage-id") ?? "").trim();

      if (!passageId) {
        return;
      }

      removePinnedPassage(passageId);
      render().catch(renderFatal);
      return;
    }

    if (action === "jump-pinned-passage") {
      event.preventDefault();
      const passageId = String(button.getAttribute("data-passage-id") ?? "").trim();
      const record = state.pinnedPassages.find((entry) => entry.id === passageId);
      const route = getRoute();

      if (!record) {
        return;
      }

      state.pendingAnchor = record.anchor;
      state.pinTrayOpen = false;

      if (route.work === record.workSlug && route.chunk === record.chunkSlug) {
        render().catch(renderFatal);
        return;
      }

      updateRoute(
        {
          work: record.workSlug,
          chunk: record.chunkSlug,
        },
        { replace: false },
      );
      return;
    }

    if (action === "open-passages") {
      event.preventDefault();
      updateRoute({ tab: "passages", page: 1 }, { replace: false });
      return;
    }
  });
}

async function render() {
  if (!state.catalog || !state.coverage) {
    return;
  }

  const route = getRoute();
  const requestId = ++state.renderId;

  if (route.work) {
    state.currentReader = null;
    appElement.innerHTML = renderReaderLoading(route);

    try {
      const manifest = await loadManifest(route.work);

      if (requestId !== state.renderId) {
        return;
      }

      if (manifest.status === "placeholder" || !manifest.defaultChunkSlug) {
        document.title = `${manifest.title} | ${SITE_TITLE}`;
        state.currentReader = null;
        appElement.innerHTML = renderPlaceholder(manifest, route);
        runPostRender(route);
        return;
      }

      const resolvedChunkSlug = route.chunk || manifest.defaultChunkSlug;
      const chunk = await loadChunk(route.work, resolvedChunkSlug);

      if (requestId !== state.renderId) {
        return;
      }

      document.title = `${manifest.title} | ${SITE_TITLE}`;
      state.currentReader = buildCurrentReaderState(manifest, chunk);
      appElement.innerHTML = renderReader(manifest, chunk, route);
      runPostRender(route);
      return;
    } catch (error) {
      if (requestId !== state.renderId) {
        return;
      }

      document.title = `Reader Error | ${SITE_TITLE}`;
      state.currentReader = null;
      appElement.innerHTML = renderReaderError(error, route);
      runPostRender(route);
      return;
    }
  }

  state.currentReader = null;
  state.pinTrayOpen = false;

  const catalogView = buildCatalogViewModel(route);
  let passageState = {
    status: "idle",
    results: [],
    message: "",
  };

  if (route.tab === "passages") {
    if (route.q.trim().length < 2) {
      passageState = {
        status: "empty",
        results: [],
        message: "Enter at least two characters to search the generated Old English reader corpus.",
      };
    } else {
      appElement.innerHTML = renderCatalog(catalogView, route, {
        status: "loading",
        results: [],
        message: "",
      });
      runPostRender(route);

      try {
        passageState = {
          status: "ready",
          results: await searchPassages(route.q, route),
          message: "",
        };
      } catch (error) {
        passageState = {
          status: "error",
          results: [],
          message: error instanceof Error ? error.message : "Passage search failed.",
        };
      }
    }
  }

  if (requestId !== state.renderId) {
    return;
  }

  document.title = SITE_TITLE;
  appElement.innerHTML = renderCatalog(catalogView, route, passageState);
  runPostRender(route);
}

function buildCatalogViewModel(route) {
  const authorOptions = buildAuthorOptions(state.catalog.entries, route.genre);
  const selectedAuthor = authorOptions.includes(route.author) ? route.author : "";
  const filtered = filterCatalogEntries(state.catalog.entries, route, {
    author: selectedAuthor,
    includeQuery: true,
  });

  const sorted = [...filtered].sort((left, right) => compareEntries(left, right, route.sort));
  const totalPages = Math.max(1, Math.ceil(sorted.length / RESULTS_PER_PAGE));
  const page = Math.min(route.page, totalPages);
  const startIndex = (page - 1) * RESULTS_PER_PAGE;

  return {
    authorOptions,
    selectedAuthor,
    filteredCount: sorted.length,
    page,
    totalPages,
    results: sorted.slice(startIndex, startIndex + RESULTS_PER_PAGE),
  };
}

function filterCatalogEntries(entries, route, options = {}) {
  const selectedAuthor = options.author ?? route.author ?? "";
  const includeQuery = options.includeQuery ?? true;

  return entries.filter((entry) => {
    if (!matchesGenre(entry.genre, route.genre)) {
      return false;
    }

    if (selectedAuthor && entry.authorDisplay !== selectedAuthor) {
      return false;
    }

    if (route.complete && entry.status !== "ready") {
      return false;
    }

    if (route.translated && entry.readyChunkCount === 0) {
      return false;
    }

    if (route.translated && !entry.hasTranslation) {
      return false;
    }

    if (includeQuery && route.q) {
      const haystack = entry.searchText || normalizeForSearch(`${entry.authorDisplay} ${entry.title} ${entry.summary}`);

      if (!route.terms.every((term) => haystack.includes(term))) {
        return false;
      }
    }

    return true;
  });
}

async function searchPassages(query, route) {
  const payload = await loadSearchIndex();
  const authorOptions = buildAuthorOptions(state.catalog.entries, route.genre);
  const selectedAuthor = authorOptions.includes(route.author) ? route.author : "";
  const allowedSlugs = new Set(
    filterCatalogEntries(state.catalog.entries, route, {
      author: selectedAuthor,
      includeQuery: false,
    }).map((entry) => entry.slug),
  );
  const rawTerms = query
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 1);
  const terms = normalizeForSearch(query)
    .split(/\s+/)
    .filter((value) => value.length > 1);

  if (!terms.length) {
    return [];
  }

  const results = [];

  for (const record of payload.records) {
    if (!allowedSlugs.has(record.workSlug)) {
      continue;
    }

    if (!terms.every((term) => record._search.includes(term))) {
      continue;
    }

    const titleKey = normalizeForSearch(`${record.authorDisplay} ${record.title}`);
    const chunkKey = normalizeForSearch(`${record.partTitle} ${record.label}`);

    let score = 0;

    for (const term of terms) {
      if (titleKey.includes(term)) {
        score += 20;
      }

      if (chunkKey.includes(term)) {
        score += 10;
      }

      if (record._search.includes(term)) {
        score += 4;
      }
    }

    results.push({
      ...record,
      score,
      snippet: buildSnippet(record.english, rawTerms) || record.preview,
    });
  }

  return results
    .sort((left, right) => right.score - left.score || left.authorDisplay.localeCompare(right.authorDisplay))
    .slice(0, 40);
}

async function loadSearchIndex() {
  if (state.searchIndex) {
    return state.searchIndex;
  }

  if (!state.searchIndexPromise) {
    state.searchIndexPromise = fetchJson("./data/search-index.json").then((payload) => {
      state.searchIndex = {
        ...payload,
        records: payload.records.map((record) => ({
          ...record,
          _search: normalizeForSearch(
            `${record.authorDisplay} ${record.title} ${record.partTitle} ${record.label} ${record.english}`,
          ),
        })),
      };

      return state.searchIndex;
    });
  }

  return state.searchIndexPromise;
}

async function loadManifest(slug) {
  if (!state.manifests.has(slug)) {
    state.manifests.set(slug, fetchJson(`./data/volumes/${encodeURIComponent(slug)}/manifest.json`));
  }

  return state.manifests.get(slug);
}

async function loadChunk(slug, chunkSlug) {
  const cacheKey = `${slug}::${chunkSlug}`;

  if (!state.chunks.has(cacheKey)) {
    state.chunks.set(
      cacheKey,
      fetchJson(`./data/volumes/${encodeURIComponent(slug)}/chunks/${encodeURIComponent(chunkSlug)}.json`),
    );
  }

  return state.chunks.get(cacheKey);
}

async function findFirstMatchingChunkSlug(manifest, query) {
  const needle = normalizeForSearch(query);

  if (!needle) {
    return manifest.defaultChunkSlug;
  }

  for (const chunkRef of manifest.chunks) {
    const chunk = await loadChunk(manifest.slug, chunkRef.slug);

    if (chunkContainsHighlight(chunk, needle)) {
      return chunkRef.slug;
    }
  }

  return manifest.defaultChunkSlug;
}

function chunkContainsHighlight(chunk, needle) {
  for (const section of chunk.sections) {
    const haystack = normalizeForSearch(`${section.original} ${section.translation}`);

    if (haystack.includes(needle)) {
      return true;
    }
  }

  return false;
}

function renderCatalog(viewModel, route, passageState) {
  const resultsLabel =
    route.tab === "passages"
      ? `${passageState.results.length} passage hit${passageState.results.length === 1 ? "" : "s"}`
      : `${viewModel.filteredCount} volume${viewModel.filteredCount === 1 ? "" : "s"}`;

  return `
    <section class="workspace">
      <aside class="control-rail">
        <label class="field">
          <span>Genre</span>
          <select data-route-input="genre">
            ${renderSelectOption("all", route.genre, "Both")}
            ${renderSelectOption("prose", route.genre, "Prose")}
            ${renderSelectOption("verse", route.genre, "Verse")}
          </select>
        </label>

        <label class="field">
          <span>Author</span>
          <select data-route-input="author">
            ${renderSelectOption("", viewModel.selectedAuthor, "All authors")}
            ${viewModel.authorOptions
              .map((author) => renderSelectOption(author, viewModel.selectedAuthor, author))
              .join("")}
          </select>
        </label>

        <label class="field">
          <span>Sort</span>
          <select data-route-input="sort">
            ${renderSelectOption("shelf", route.sort, "Library shelf")}
            ${renderSelectOption("author", route.sort, "Author")}
            ${renderSelectOption("title", route.sort, "Title")}
            ${renderSelectOption("activity", route.sort, "Most readable")}
          </select>
        </label>

        <label class="toggle-field">
          <input type="checkbox" data-route-input="complete" ${route.complete ? "checked" : ""} />
          <span>Complete texts only</span>
        </label>

        <label class="toggle-field">
          <input type="checkbox" data-route-input="translated" ${route.translated ? "checked" : ""} />
          <span>Only texts with English translations</span>
        </label>

        <div class="rail-legend">
          <div><span class="legend-swatch tone-prose"></span>Prose shelf</div>
          <div><span class="legend-swatch tone-verse"></span>Verse shelf</div>
          <div><span class="legend-swatch tone-both"></span>Cross-genre shelf</div>
        </div>

        <button class="quiet-button" data-action="clear-filters" type="button">Clear filters</button>
      </aside>

      <section class="stage">
        <div class="stage-head">
          <form class="search-form" data-search-form>
            <label class="search-field">
              <span class="eyebrow">Search</span>
              <input
                type="search"
                name="q"
                placeholder="Beowulf, Alfred, Chronicle, exile..."
                value="${escapeHtml(route.q)}"
                data-route-input="q"
              />
            </label>
            <button class="search-submit" type="submit">
              ${route.tab === "passages" ? "Search passages" : "Search shelves"}
            </button>
          </form>

          <div class="segment-control" role="tablist" aria-label="Search mode">
            <a class="${route.tab === "catalog" ? "is-active" : ""}" href="${escapeHtml(createHref({ tab: null, page: 1 }))}" role="tab">
              Shelf browse
            </a>
            <a class="${route.tab === "passages" ? "is-active" : ""}" href="${escapeHtml(createHref({ tab: "passages", page: 1 }))}" role="tab">
              Passage search
            </a>
          </div>
        </div>

        <div class="results-bar">
          <div>
            <p class="eyebrow">${route.tab === "passages" ? "Passage Search" : "Shelf Results"}</p>
            <h3>${resultsLabel}</h3>
          </div>
        </div>

        ${
          route.tab === "passages"
            ? renderPassageResults(route, passageState)
            : renderCatalogResults(viewModel, route)
        }
      </section>
    </section>

    <footer class="footer-note">
      Built from public-domain source texts and local static data for direct upload to Hostinger.
    </footer>
  `;
}

function renderCatalogResults(viewModel, route) {
  if (!viewModel.results.length) {
    return `
      <section class="empty-panel">
        <p class="eyebrow">No Match</p>
        <h3>Nothing on this shelf fits the current filters.</h3>
        <p>Try a broader search, or clear the active filters.</p>
      </section>
    `;
  }

  return `
    <section class="volume-list">
      ${viewModel.results.map((entry) => renderVolumeRow(entry, route)).join("")}
    </section>
    ${renderPagination(route, viewModel.page, viewModel.totalPages)}
  `;
}

function renderPassageResults(route, passageState) {
  if (passageState.status === "loading") {
    return `
      <section class="empty-panel">
        <p class="eyebrow">Searching</p>
        <h3>Scanning the generated reader corpus.</h3>
        <p>This search is local and static, so the results will be ready in a moment.</p>
      </section>
    `;
  }

  if (passageState.status === "error") {
    return `
      <section class="empty-panel">
        <p class="eyebrow">Search Error</p>
        <h3>The passage index could not be opened.</h3>
        <p>${escapeHtml(passageState.message)}</p>
      </section>
    `;
  }

  if (passageState.status === "empty") {
    return `
      <section class="empty-panel">
        <p class="eyebrow">Passage Search</p>
        <h3>Enter a search phrase above</h3>
      </section>
    `;
  }

  if (passageState.status === "ready" && passageState.results.length === 0) {
    return `
      <section class="empty-panel">
        <p class="eyebrow">No Hit</p>
        <h3>No ready chunk matches that phrase.</h3>
        <p>Try a shorter English phrase, or switch back to shelf browse to search titles and authors.</p>
      </section>
    `;
  }

  return `
    <section class="passage-list">
      ${passageState.results.map((result) => renderPassageHit(result, route)).join("")}
    </section>
  `;
}

function renderVolumeRow(entry, route) {
  return `
    <a class="volume-row tone-${entry.genre}" href="${escapeHtml(createHref({ work: entry.slug, chunk: null, highlight: null }, route))}">
      <span class="volume-spine">${escapeHtml(genreLabel(entry.genre))}</span>
      <div class="volume-body">
        <div class="volume-topline">
          <p class="volume-author">${escapeHtml(entry.authorDisplay)}</p>
          <span class="status-badge status-${entry.status}">${escapeHtml(statusLabel(entry.status))}</span>
        </div>
        <h3>${escapeHtml(entry.title)}</h3>
        <p class="volume-summary">${escapeHtml(entry.summary)}</p>
        <div class="volume-chips">
          ${entry.contents.slice(0, 4).map((content) => `<span>${escapeHtml(content.title)}</span>`).join("")}
        </div>
      </div>
      <div class="volume-side">
        <strong>${entry.readyChunkCount}</strong>
        <span>${entry.hasTranslation ? "bilingual" : "live"} chunk${entry.readyChunkCount === 1 ? "" : "s"}</span>
      </div>
    </a>
  `;
}

function renderPassageHit(result, route) {
  return `
    <a
      class="passage-hit tone-${result.genre}"
      href="${escapeHtml(createHref({ work: result.workSlug, chunk: result.chunkSlug, highlight: route.q }, route))}"
    >
      <div class="passage-hit-top">
        <span class="mini-badge">${escapeHtml(genreLabel(result.genre))}</span>
        <span class="mini-badge">${escapeHtml(result.label)}</span>
      </div>
      <h3>${escapeHtml(result.authorDisplay)}<span> / ${escapeHtml(result.title)}</span></h3>
      <p class="passage-hit-meta">${escapeHtml(result.partTitle)} · ${result.sectionCount} section${result.sectionCount === 1 ? "" : "s"}</p>
      <p class="passage-hit-snippet">${highlightHtml(result.snippet, route.q)}</p>
    </a>
  `;
}

function renderPagination(route, page, totalPages) {
  if (totalPages <= 1) {
    return "";
  }

  const pages = [];
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, page + 2);

  for (let current = start; current <= end; current += 1) {
    pages.push(
      `<a class="${current === page ? "is-active" : ""}" href="${escapeHtml(createHref({ page: current }, route))}">${current}</a>`,
    );
  }

  return `
    <nav class="pagination" aria-label="Catalog pages">
      ${page > 1 ? `<a href="${escapeHtml(createHref({ page: page - 1 }, route))}">Previous</a>` : ""}
      ${pages.join("")}
      ${page < totalPages ? `<a href="${escapeHtml(createHref({ page: page + 1 }, route))}">Next</a>` : ""}
    </nav>
  `;
}

function renderReader(manifest, chunk, route) {
  const currentIndex = manifest.chunks.findIndex((entry) => entry.slug === chunk.chunkSlug);
  const previous = currentIndex > 0 ? manifest.chunks[currentIndex - 1] : null;
  const next = currentIndex >= 0 && currentIndex < manifest.chunks.length - 1 ? manifest.chunks[currentIndex + 1] : null;
  const pinnedCount = state.pinnedPassages.length;

  return `
    ${renderPinnedTray()}

    <div class="reader-minibar">
      <a class="back-link back-link-compact" href="${escapeHtml(createHref({ work: null, chunk: null, highlight: null }, route))}">
        Back to the library
      </a>
      <div class="reader-minibar-actions">
        <button
          class="quiet-button back-link-compact reader-pin-toggle"
          type="button"
          data-action="toggle-pin-tray"
          aria-haspopup="dialog"
          aria-controls="pinned-passage-tray"
          aria-expanded="${state.pinTrayOpen ? "true" : "false"}"
        >
          ${renderPinIcon()}
          <span>Pinned${pinnedCount ? ` (${pinnedCount})` : ""}</span>
        </button>
      </div>
    </div>

    <section class="reader-layout">
      <aside class="reader-rail">
        <form class="reader-search-form" data-reader-search-form data-work-slug="${escapeHtml(manifest.slug)}">
          <label class="field reader-search-field">
            <span>Search in this text</span>
            <input
              type="search"
              name="highlight"
              value="${escapeHtml(route.highlight)}"
              placeholder="Find a word or phrase..."
            />
          </label>
          <div class="reader-search-actions">
            <button class="quiet-button reader-search-button" type="submit">Find in text</button>
            ${
              route.highlight
                ? `<button class="quiet-button reader-search-button" data-action="clear-highlight" type="button">Clear in-text search</button>`
                : ""
            }
          </div>
        </form>

        <div class="reader-rail-block">
          <p class="eyebrow">Table of Contents</p>
          <div class="reader-link-list">
            ${manifest.chunks.map((entry) => renderChunkLink(manifest, entry, chunk.chunkSlug, route)).join("")}
          </div>
        </div>

        <div class="reader-rail-block">
          <p class="eyebrow">Volume Contents</p>
          <div class="reader-content-list">
            ${manifest.contents.map((entry) => renderContentLink(manifest, entry, chunk.chunkSlug, route)).join("")}
          </div>
        </div>
      </aside>

      <section class="reader-stage">
        ${
          manifest.status === "partial"
            ? `
              <div class="reader-banner">
                This volume is only partially live. The chunk below is ready to read, while the remaining contents stay listed until their bilingual pair is aligned.
              </div>
            `
            : ""
        }
        ${
          !manifest.hasTranslation
            ? `
              <div class="reader-banner reader-banner-original-only">
                This reader currently contains the Old English original only. The English translation is still pending.
              </div>
            `
            : ""
        }

        <div class="reader-topline">
          <div>
            <p class="eyebrow">${escapeHtml(genreLabel(manifest.genre))} shelf</p>
            <h2>${escapeHtml(chunk.label)}</h2>
          </div>
          <p class="reader-topline-note">${escapeHtml(chunk.partTitle)}</p>
        </div>

        <div class="parallel-flow">
          ${chunk.sections.map((section, index) => renderSection(section, index, chunk.originalLang, route.highlight, manifest, chunk)).join("")}
        </div>

        <footer class="reader-footer">
          <div class="reader-footer-copy">
            <p class="eyebrow">Source Texts</p>
            <div class="reader-footer-links">
              <a href="${escapeHtml(chunk.citations.original.url)}" target="_blank" rel="noreferrer">
                ${escapeHtml(chunk.citations.original.label)}
              </a>
              ${
                chunk.citations.translation?.url
                  ? `
                    <a href="${escapeHtml(chunk.citations.translation.url)}" target="_blank" rel="noreferrer">
                      ${escapeHtml(chunk.citations.translation.label)}
                    </a>
                  `
                  : `<span class="reader-footer-note">English translation pending</span>`
              }
            </div>
          </div>

          <div class="reader-nav">
            ${
              previous
                ? `<a href="${escapeHtml(createHref({ work: manifest.slug, chunk: previous.slug }, route))}">Previous</a>`
                : `<span class="is-disabled">Previous</span>`
            }
            ${
              next
                ? `<a href="${escapeHtml(createHref({ work: manifest.slug, chunk: next.slug }, route))}">Next</a>`
                : `<span class="is-disabled">Next</span>`
            }
          </div>
        </footer>
      </section>
    </section>
  `;
}

function renderSection(section, index, originalLang, highlight, manifest, chunk) {
  const record = buildPassageRecord(manifest, chunk, section, index);
  const pinned = isPassagePinned(record.id);

  return `
    <article class="section-row reveal" id="${record.anchor}">
      <div class="section-marker">
        <span>${escapeHtml(section.label)}</span>
        <button
          class="passage-pin-button ${pinned ? "is-active" : ""}"
          type="button"
          data-action="toggle-pin-passage"
          data-passage-id="${escapeHtml(record.id)}"
          aria-pressed="${pinned ? "true" : "false"}"
        >
          ${renderPinIcon()}
          <strong>${pinned ? "Pinned" : "Pin"}</strong>
        </button>
      </div>

      <div class="section-columns">
        <section class="text-panel" lang="${originalLang}">
          ${renderPassage(section.original, highlight)}
        </section>
        <section class="text-panel text-panel-translation" lang="en">
          ${renderTranslationPanel(section.translation, highlight)}
        </section>
      </div>
    </article>
  `;
}

function renderPinnedTray() {
  const hasPins = state.pinnedPassages.length > 0;
  const visibleClass = hasPins ? "has-pins" : "is-empty";
  const mobileClass = state.pinTrayOpen ? "is-mobile-open" : "";
  const trayVisible = state.pinTrayOpen || (hasPins && !isMobileViewport());

  return `
    <div class="pin-layer ${visibleClass} ${mobileClass}">
      <button class="pin-layer-backdrop" type="button" data-action="close-pin-tray" aria-label="Close pinned passages"></button>
      <section
        class="pin-tray"
        id="pinned-passage-tray"
        aria-label="Pinned passages"
        aria-hidden="${trayVisible ? "false" : "true"}"
      >
        <div class="pin-tray-head">
          <div>
            <p class="eyebrow">Pinned Passages</p>
            <h3>${state.pinnedPassages.length} saved passage${state.pinnedPassages.length === 1 ? "" : "s"}</h3>
          </div>
          <div class="pin-tray-actions">
            ${
              state.pinnedPassages.length
                ? `<button class="quiet-button pin-tray-action" type="button" data-action="clear-pinned-passages">Clear all</button>`
                : ""
            }
            <button class="quiet-button pin-tray-action pin-tray-close" type="button" data-action="close-pin-tray">Close</button>
          </div>
        </div>

        ${
          state.pinnedPassages.length
            ? `
              <div class="pin-tray-list">
                ${state.pinnedPassages.map((record) => renderPinnedCard(record)).join("")}
              </div>
            `
            : `
              <div class="pin-tray-empty">
                <p>No passages are pinned yet. Use the pin buttons beside a section to save it here.</p>
              </div>
            `
        }
      </section>
    </div>
  `;
}

function renderPinnedCard(record) {
  return `
    <article class="pinned-card tone-${escapeHtml(record.genre)}">
      <div class="pinned-card-top">
        <div class="pinned-card-copy">
          <p class="pinned-card-meta">${escapeHtml(record.authorDisplay)} / ${escapeHtml(record.workTitle)}</p>
          <h4>${escapeHtml(record.sectionLabel)}</h4>
          <p class="pinned-card-subtitle">${escapeHtml(record.partTitle)}</p>
        </div>
        <div class="pinned-card-actions">
          <button class="quiet-button pin-card-button" type="button" data-action="jump-pinned-passage" data-passage-id="${escapeHtml(record.id)}">
            Jump to passage
          </button>
          <button class="quiet-button pin-card-button" type="button" data-action="remove-pinned-passage" data-passage-id="${escapeHtml(record.id)}">
            Remove
          </button>
        </div>
      </div>

      <div class="pinned-card-columns">
        <section class="pinned-card-panel">
          <span class="column-pill tone-${escapeHtml(record.genre)}">Old English</span>
          ${renderPassage(record.original, "")}
        </section>
        <section class="pinned-card-panel pinned-card-panel-translation">
          <span class="column-pill tone-english">Modern English</span>
          ${renderTranslationPanel(record.translation, "")}
        </section>
      </div>
    </article>
  `;
}

function renderPassage(text, highlight) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean);

  return paragraphs
    .map((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => highlightHtml(line, highlight))
        .join("<br />");

      return `<p>${lines}</p>`;
    })
    .join("");
}

function renderTranslationPanel(text, highlight) {
  if (!hasTextContent(text)) {
    return `
      <div class="text-panel-empty-state">
        <p>English translation has not been added to this text yet.</p>
      </div>
    `;
  }

  return renderPassage(text, highlight);
}

function renderChunkLink(manifest, entry, currentChunkSlug, route) {
  return `
    <a
      class="${entry.slug === currentChunkSlug ? "is-current" : ""}"
      href="${escapeHtml(createHref({ work: manifest.slug, chunk: entry.slug }, route))}"
    >
      ${escapeHtml(entry.label)}
    </a>
  `;
}

function renderContentLink(manifest, content, currentChunkSlug, route) {
  if (content.status !== "ready" || !content.chunkSlug) {
    return `
      <div class="content-pill content-pill-placeholder">
        <strong>${escapeHtml(content.title)}</strong>
        <span>${escapeHtml(content.placeholderReason || "In preparation")}</span>
      </div>
    `;
  }

  return `
    <a
      class="content-pill ${content.chunkSlug === currentChunkSlug ? "is-current" : ""}"
      href="${escapeHtml(createHref({ work: manifest.slug, chunk: content.chunkSlug }, route))}"
    >
      <strong>${escapeHtml(content.title)}</strong>
      <span>${content.sectionCount} section${content.sectionCount === 1 ? "" : "s"}</span>
    </a>
  `;
}

function renderReaderLoading(route) {
  return `
    <section class="loading-state">
      <p class="eyebrow">Opening Reader</p>
      <h1>Fetching the requested shelf mark.</h1>
      <p>The static reader manifest and chunk JSON are loading.</p>
      <a class="back-link" href="${escapeHtml(createHref({ work: null, chunk: null, highlight: null }, route))}">Back to the library</a>
    </section>
  `;
}

function renderReaderError(error, route) {
  const message = error instanceof Error ? error.message : "The reader could not be opened.";

  return `
    <section class="loading-state">
      <p class="eyebrow">Reader Error</p>
      <h1>The requested shelf could not be opened.</h1>
      <p>${escapeHtml(message)}</p>
      <a class="back-link" href="${escapeHtml(createHref({ work: null, chunk: null, highlight: null }, route))}">Back to the library</a>
    </section>
  `;
}

function renderPlaceholder(manifest, route) {
  return `
    <section class="loading-state placeholder-state">
      <p class="eyebrow">${escapeHtml(genreLabel(manifest.genre))} shelf</p>
      <h1>${escapeHtml(manifest.title)}</h1>
      <p>${escapeHtml(manifest.summary)}</p>
      <div class="placeholder-list">
        ${manifest.contents
          .map(
            (content) => `
              <div class="placeholder-item">
                <strong>${escapeHtml(content.title)}</strong>
                <p>${escapeHtml(content.placeholderReason || "This text pair has not been aligned yet.")}</p>
              </div>
            `,
          )
          .join("")}
      </div>
      <a class="back-link" href="${escapeHtml(createHref({ work: null, chunk: null }, route))}">Back to the library</a>
    </section>
  `;
}

function renderSelectOption(value, current, label) {
  return `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function buildAuthorOptions(entries, genre) {
  const filteredEntries = entries.filter((entry) => {
    return matchesGenre(entry.genre, genre);
  });

  return [...new Set(filteredEntries.map((entry) => entry.authorDisplay))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function compareEntries(left, right, sort) {
  if (sort === "author") {
    return left.authorDisplay.localeCompare(right.authorDisplay) || left.title.localeCompare(right.title);
  }

  if (sort === "title") {
    return left.title.localeCompare(right.title) || left.authorDisplay.localeCompare(right.authorDisplay);
  }

  if (sort === "activity") {
    return (
      right.readyChunkCount - left.readyChunkCount ||
      weightStatus(right.status) - weightStatus(left.status) ||
      left.authorDisplay.localeCompare(right.authorDisplay)
    );
  }

  return left.sortOrder - right.sortOrder;
}

function buildSnippet(text, rawTerms) {
  if (!text) {
    return "";
  }

  const lower = text.toLowerCase();
  const index = rawTerms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];

  if (typeof index !== "number") {
    return excerpt(text, 240);
  }

  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + 180);
  const snippet = text.slice(start, end).trim();

  return `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`;
}

function createHref(patch = {}, baseRoute = getRoute()) {
  const url = new URL(window.location.href);
  const values = {
    q: baseRoute.q,
    genre: baseRoute.genre,
    author: baseRoute.author,
    sort: baseRoute.sort,
    translated: baseRoute.translated ? "1" : null,
    complete: baseRoute.complete ? "1" : null,
    tab: baseRoute.tab === "catalog" ? null : baseRoute.tab,
    page: baseRoute.page > 1 ? String(baseRoute.page) : null,
    work: baseRoute.work,
    chunk: baseRoute.chunk,
    highlight: baseRoute.highlight,
  };

  Object.assign(values, patch);

  setQueryParam(url, "q", values.q);
  setQueryParam(url, "genre", values.genre && values.genre !== "all" ? values.genre : null);
  setQueryParam(url, "author", values.author);
  setQueryParam(url, "sort", values.sort && values.sort !== "shelf" ? values.sort : null);
  setQueryParam(url, "translated", values.translated);
  setQueryParam(url, "complete", values.complete);
  setQueryParam(url, "tab", values.tab && values.tab !== "catalog" ? values.tab : null);
  setQueryParam(url, "page", values.page && String(values.page) !== "1" ? String(values.page) : null);
  setQueryParam(url, "work", values.work);
  setQueryParam(url, "chunk", values.chunk);
  setQueryParam(url, "highlight", values.highlight);

  return `${url.pathname}${url.search}`;
}

function updateRoute(patch, options = { replace: true }) {
  const href = createHref(patch);

  if (options.replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }

  render().catch(renderFatal);
}

function getRoute() {
  const url = new URL(window.location.href);
  const q = (url.searchParams.get("q") || "").trim();

  return {
    q,
    terms: normalizeForSearch(q)
      .split(/\s+/)
      .filter(Boolean),
    genre: readAllowed(url.searchParams.get("genre") || url.searchParams.get("lang"), ["all", "prose", "verse"], "all"),
    author: (url.searchParams.get("author") || "").trim(),
    sort: readAllowed(url.searchParams.get("sort"), ["shelf", "author", "title", "activity"], "shelf"),
    translated: url.searchParams.get("translated") === "1",
    complete: url.searchParams.get("complete") === "1" || url.searchParams.get("status") === "ready",
    tab: readAllowed(url.searchParams.get("tab"), ["catalog", "passages"], "catalog"),
    page: Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1),
    work: url.searchParams.get("work") || null,
    chunk: url.searchParams.get("chunk") || null,
    highlight: (url.searchParams.get("highlight") || "").trim(),
  };
}

function runPostRender(route) {
  requestAnimationFrame(() => {
    document.querySelectorAll(".reveal").forEach((element, index) => {
      element.style.transitionDelay = `${Math.min(index * 30, 240)}ms`;
      element.classList.add("is-visible");
    });

    if (route.work && state.pendingAnchor) {
      const anchor = state.pendingAnchor;
      state.pendingAnchor = null;
      scrollToPassageAnchor(anchor);
      return;
    }

    if (route.work && route.highlight) {
      const firstMark = document.querySelector("mark");

      if (firstMark instanceof HTMLElement) {
        firstMark.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  });
}

function buildCurrentReaderState(manifest, chunk) {
  const passages = chunk.sections.map((section, index) => buildPassageRecord(manifest, chunk, section, index));
  return {
    manifest,
    chunk,
    passages,
  };
}

function buildPassageRecord(manifest, chunk, section, index) {
  const anchor = `section-${slugify(`${section.id}-${index}`)}`;
  return {
    id: slugify(`${manifest.slug}-${chunk.chunkSlug}-${section.id}-${index}`),
    anchor,
    workSlug: manifest.slug,
    workTitle: manifest.title,
    authorDisplay: manifest.authorDisplay,
    genre: manifest.genre,
    chunkSlug: chunk.chunkSlug,
    chunkLabel: chunk.label,
    partTitle: chunk.partTitle,
    sectionLabel: section.label,
    original: section.original,
    translation: section.translation,
  };
}

function isPassagePinned(passageId) {
  return state.pinnedPassages.some((entry) => entry.id === passageId);
}

function togglePinnedPassage(passageId) {
  const existing = state.pinnedPassages.find((entry) => entry.id === passageId);
  if (existing) {
    state.pinnedPassages = state.pinnedPassages.filter((entry) => entry.id !== passageId);
    savePinnedPassages(state.pinnedPassages);
    return { changed: true, pinned: false };
  }

  const context = state.currentReader;
  const record = context?.passages.find((entry) => entry.id === passageId);
  if (!record) {
    return { changed: false, pinned: false };
  }

  state.pinnedPassages = [record, ...state.pinnedPassages];
  savePinnedPassages(state.pinnedPassages);
  return { changed: true, pinned: true };
}

function removePinnedPassage(passageId) {
  state.pinnedPassages = state.pinnedPassages.filter((entry) => entry.id !== passageId);
  savePinnedPassages(state.pinnedPassages);
}

function loadPinnedPassages() {
  try {
    const raw = window.localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry) => entry && typeof entry === "object" && entry.id);
  } catch (error) {
    return [];
  }
}

function savePinnedPassages(records) {
  try {
    window.localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(records));
  } catch (error) {
    // Ignore storage failures and keep the in-memory state.
  }
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function scrollToPassageAnchor(anchor) {
  const element = document.getElementById(anchor);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function renderPinIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15.5 3.5 20.5 8.5 17 10l-2.5 5.5-1.5-1.5-3.7 3.7-1-1 3.7-3.7-1.5-1.5L16 8z"></path>
    </svg>
  `;
}

function renderFatal(error) {
  document.title = SITE_TITLE;
  appElement.innerHTML = `
    <section class="loading-state">
      <p class="eyebrow">Error</p>
      <h1>The reading room could not be prepared.</h1>
      <p>${escapeHtml(error instanceof Error ? error.message : "Unknown error.")}</p>
    </section>
  `;
}

function fetchJson(url) {
  return fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
    }

    return response.json();
  });
}

function highlightHtml(text, query) {
  if (!query) {
    return escapeHtml(text);
  }

  const pattern = query.trim();

  if (!pattern) {
    return escapeHtml(text);
  }

  const regex = new RegExp(`(${escapeRegex(pattern)})`, "ig");

  return text
    .split(regex)
    .map((part, index) => (index % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join("");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerpt(value, maxLength = 200) {
  const clean = value.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "";
  }

  if (clean.length <= maxLength) {
    return clean;
  }

  return `${clean.slice(0, maxLength).trimEnd()}...`;
}

function hasTextContent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeForSearch(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("þ", "th")
    .replaceAll("ð", "th")
    .replaceAll("æ", "ae")
    .replaceAll("ǣ", "ae")
    .replaceAll("ƿ", "w")
    .replaceAll("Ƿ", "w")
    .replaceAll("ȝ", "g")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setQueryParam(url, key, value) {
  if (value === null || value === undefined || value === "") {
    url.searchParams.delete(key);
    return;
  }

  url.searchParams.set(key, value);
}

function readAllowed(value, allowed, fallback) {
  return allowed.includes(value || "") ? value : fallback;
}

function weightStatus(status) {
  if (status === "ready") {
    return 3;
  }

  if (status === "partial") {
    return 2;
  }

  return 1;
}

function statusLabel(status) {
  if (status === "ready") {
    return "Ready reader";
  }

  if (status === "partial") {
    return "Partial shelf";
  }

  return "In preparation";
}

function genreLabel(genre) {
  if (genre === "prose") {
    return "Prose";
  }

  if (genre === "verse") {
    return "Verse";
  }

  return "Both";
}

function matchesGenre(entryGenre, filterGenre) {
  if (filterGenre === "all") {
    return true;
  }

  if (entryGenre === filterGenre) {
    return true;
  }

  return entryGenre === "both";
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replaceAll("þ", "th")
    .replaceAll("ð", "th")
    .replaceAll("æ", "ae")
    .replaceAll("ǣ", "ae")
    .replaceAll("ƿ", "w")
    .replaceAll("Ƿ", "w")
    .replaceAll("ȝ", "g")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
