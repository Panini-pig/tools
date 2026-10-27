const state = {
  category: "all",
  query: "",
};

const els = {
  filters: document.querySelector("#categoryFilters"),
  grid: document.querySelector("#toolGrid"),
  empty: document.querySelector("#emptyState"),
  emptyTitle: document.querySelector("#emptyTitle"),
  emptyText: document.querySelector("#emptyText"),
  emptyAction: document.querySelector("#emptyAction"),
  toolsTitle: document.querySelector("#tools-title"),
  resultCount: document.querySelector("#resultCount"),
  toolCount: document.querySelector("#toolCount"),
  search: document.querySelector("#toolSearch"),
};

let catalog = null;

const ICONS = {
  image: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <circle cx="8.5" cy="9.5" r="1.5"></circle>
      <path d="m21 15-5-5L5 21"></path>
    </svg>`,
  archive: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1"></rect>
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"></path>
      <path d="M10 12h4"></path>
      <path d="m12 15 0 4"></path>
      <path d="m10.5 17.5 1.5 1.5 1.5-1.5"></path>
    </svg>`,
  extension: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 4a3 3 0 0 1 6 0v1h3a1 1 0 0 1 1 1v3h1a3 3 0 0 1 0 6h-1v3a1 1 0 0 1-1 1h-3v-1a3 3 0 0 0-6 0v1H6a1 1 0 0 1-1-1v-3H4a3 3 0 0 1 0-6h1V6a1 1 0 0 1 1-1h3V4Z"></path>
    </svg>`,
  default: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5 2.5-2.5Z"></path>
    </svg>`,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char];
  });
}

function iconFor(name) {
  return ICONS[name] || ICONS.default;
}

function categoryOf(id) {
  return catalog.categories.find((category) => category.id === id) || null;
}

function countFor(categoryId) {
  if (!catalog) return 0;
  return catalog.tools.filter((tool) => tool.category === categoryId).length;
}

function matchesQuery(tool, query) {
  if (!query) return true;
  const category = categoryOf(tool.category);
  const haystack = [
    tool.name,
    tool.summary,
    tool.description,
    category?.name,
    ...(tool.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function visibleTools() {
  return catalog.tools.filter((tool) => {
    if (state.category !== "all" && tool.category !== state.category) {
      return false;
    }
    return matchesQuery(tool, state.query);
  });
}

function renderFilters() {
  const allCount = catalog.tools.length;
  const buttons = [
    `<button class="filter" type="button" data-category="all" aria-pressed="true">全部 <span class="filter-count">${allCount}</span></button>`,
    ...catalog.categories.map((category) => {
      const count = countFor(category.id);
      const emptyClass = count === 0 ? " is-empty" : "";
      return `<button class="filter${emptyClass}" type="button" data-category="${escapeHtml(category.id)}" aria-pressed="false"${count === 0 ? ' title="这个分类还在筹备"' : ""}>${escapeHtml(category.name)} <span class="filter-count">${count}</span></button>`;
    }),
  ];

  els.filters.innerHTML = buttons.join("");
}

function updateFilterState() {
  els.filters.querySelectorAll("[data-category]").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.category === state.category),
    );
  });
}

function toolCard(tool) {
  const category = categoryOf(tool.category);
  const platform = (tool.platforms || [])[0];
  const badges = [
    category
      ? `<span class="badge badge-accent">${escapeHtml(category.name)}</span>`
      : "",
    platform
      ? `<span class="badge">${escapeHtml(platform)}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  const meta = [
    ...(tool.meta || []),
    tool.version ? `v${tool.version}` : "",
    tool.updated ? `更新于 ${tool.updated}` : "",
    tool.size || "",
  ]
    .filter(Boolean)
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");

  const isExternal = /^https?:\/\//i.test(tool.url || "");
  const target = isExternal
    ? ' target="_blank" rel="noopener noreferrer"'
    : "";
  const action = tool.action || "查看详情";

  return `
    <a class="tool-card" href="${escapeHtml(tool.url || "#")}"${target} aria-label="${escapeHtml(`${tool.name}，${action}`)}">
      <div class="tool-card-top">
        <span class="tool-icon">${iconFor(tool.icon)}</span>
        <span class="tool-badges">${badges}</span>
      </div>
      <h3>${escapeHtml(tool.name)}</h3>
      <p class="tool-card-summary">${escapeHtml(tool.summary || "")}</p>
      ${meta ? `<div class="meta">${meta}</div>` : ""}
      <div class="tool-action">
        <span>${escapeHtml(action)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5 12h14"></path>
          <path d="m13 6 6 6-6 6"></path>
        </svg>
      </div>
    </a>`;
}

function setEmptyState(kind) {
  const category =
    state.category === "all" ? null : categoryOf(state.category);
  const hasQuery = Boolean(state.query);

  if (kind === "error") {
    els.emptyTitle.textContent = "工具目录没有加载成功";
    els.emptyText.textContent =
      "请刷新页面重试。你也可以直接访问本地图片压缩，或稍后再来。";
    els.emptyAction.textContent = "重新加载";
    els.emptyAction.onclick = () => window.location.reload();
  } else if (hasQuery) {
    els.emptyTitle.textContent = "没有找到匹配的工具";
    els.emptyText.textContent = `没有和“${state.query}”匹配的结果。换个关键词，或者看看全部工具。`;
    els.emptyAction.textContent = "清除搜索";
    els.emptyAction.onclick = () => {
      state.query = "";
      state.category = "all";
      els.search.value = "";
      updateFilterState();
      render();
      syncUrl();
      els.search.focus();
    };
  } else if (category && countFor(category.id) === 0) {
    els.emptyTitle.textContent = `${category.name}还在筹备`;
    els.emptyText.textContent = `${category.description || "这个分类还没有工具"}。先看看全部工具，或者建议一个。`;
    els.emptyAction.textContent = "查看全部工具";
    els.emptyAction.onclick = () => selectCategory("all");
  } else {
    els.emptyTitle.textContent = "没有可显示的工具";
    els.emptyText.textContent = "换个分类，或者清除搜索再看看。";
    els.emptyAction.textContent = "查看全部工具";
    els.emptyAction.onclick = () => selectCategory("all");
  }
}

function render() {
  if (!catalog) return;

  const tools = visibleTools();
  const category =
    state.category === "all" ? null : categoryOf(state.category);

  els.toolsTitle.textContent = category ? category.name : "全部工具";
  els.resultCount.textContent = state.query
    ? `找到 ${tools.length} 个`
    : `${tools.length} 个工具`;

  if (tools.length === 0) {
    els.grid.innerHTML = "";
    els.empty.hidden = false;
    setEmptyState("empty");
    return;
  }

  els.empty.hidden = true;
  els.grid.innerHTML = tools.map(toolCard).join("");
}

function selectCategory(categoryId) {
  state.category = categoryId;
  updateFilterState();
  render();
  syncUrl();
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.query) {
    params.set("q", state.query);
  }

  const search = params.toString() ? `?${params.toString()}` : "";
  const hash = state.category === "all" ? "" : `#${state.category}`;
  const next = `${window.location.pathname}${search}${hash}`;
  window.history.replaceState(null, "", next);
}

function readHash() {
  if (!catalog) return;
  const hash = window.location.hash.replace(/^#/, "");
  const next = catalog.categories.some((category) => category.id === hash)
    ? hash
    : "all";

  if (state.category === next) return;
  state.category = next;
  updateFilterState();
  render();
}

function readUrl() {
  const query = new URLSearchParams(window.location.search).get("q");
  if (query) {
    state.query = query;
    els.search.value = query;
  }
  readHash();
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

async function init() {
  try {
    const response = await fetch("data/tools.json", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    catalog = await response.json();
    catalog.categories.sort(
      (a, b) => (a.order ?? 99) - (b.order ?? 99),
    );

    const toolCount = catalog.tools.length;
    els.toolCount.textContent = `共 ${toolCount} 个工具 · ${catalog.categories.length} 个分类`;

    renderFilters();
    updateFilterState();
    readUrl();
    render();
  } catch (error) {
    console.error(error);
    els.toolCount.textContent = "工具目录暂时不可用";
    els.grid.innerHTML = "";
    els.empty.hidden = false;
    els.resultCount.textContent = "";
    setEmptyState("error");
  }
}

els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  selectCategory(button.dataset.category);
});

els.search.addEventListener(
  "input",
  debounce(() => {
    state.query = els.search.value.trim();
    render();
    syncUrl();
  }, 120),
);

window.addEventListener("hashchange", readHash);

init();
