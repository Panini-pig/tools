(() => {
  const STORAGE_KEY = "panini-tools-theme";
  const MODES = ["light", "dark", "system"];
  const root = document.documentElement;
  const media = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  function storedMode() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return MODES.includes(value) ? value : null;
    } catch (error) {
      return null;
    }
  }

  function currentMode() {
    const value = root.dataset.themeMode;
    if (MODES.includes(value)) return value;
    return storedMode() || "dark";
  }

  function resolvedTheme(mode) {
    if (mode === "system") {
      if (!media) return "dark";
      return media.matches ? "dark" : "light";
    }
    return mode === "light" ? "light" : "dark";
  }

  function apply(mode, persist = false) {
    const nextMode = MODES.includes(mode) ? mode : "dark";
    const theme = resolvedTheme(nextMode);

    root.dataset.theme = theme;
    root.dataset.themeMode = nextMode;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "dark" ? "#151513" : "#f6f5f1");
    }

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const modeLabel =
        nextMode === "system"
          ? "跟随系统"
          : nextMode === "dark"
            ? "深色"
            : "浅色";
      button.setAttribute(
        "aria-label",
        `主题：${modeLabel}，打开主题选择`,
      );
      button.setAttribute("title", `主题：${modeLabel}`);
    });

    document
      .querySelectorAll('input[name="theme-mode"]')
      .forEach((input) => {
        input.checked = input.value === nextMode;
      });

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, nextMode);
      } catch (error) {
        /* localStorage can be unavailable in private modes. */
      }
    }
  }

  const toggle = document.querySelector("[data-theme-toggle]");
  const menu = document.querySelector("[data-theme-menu]");
  const control = toggle ? toggle.closest(".theme-control") : null;
  const status = document.querySelector("[data-theme-status]");

  function announce(mode) {
    if (!status) return;
    status.textContent =
      mode === "system"
        ? "已切换到跟随系统"
        : `已切换到${mode === "dark" ? "深色" : "浅色"}模式`;
  }

  function selectMode(mode) {
    if (!MODES.includes(mode)) return;
    apply(mode, true);
    announce(mode);
    closeMenu();
    if (toggle) toggle.focus();
  }

  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function openMenu(shouldFocus = false) {
    if (!menu) return;
    menu.hidden = false;
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (!shouldFocus) return;
    const checked = menu.querySelector('input[name="theme-mode"]:checked');
    const first = menu.querySelector('input[name="theme-mode"]');
    (checked || first)?.focus({ preventScroll: true });
  }

  if (toggle && menu) {
    let openWithKeyboard = false;

    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        openWithKeyboard = true;
      }
    });

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) {
        openMenu(openWithKeyboard);
      } else {
        closeMenu();
      }
      openWithKeyboard = false;
    });

    document.addEventListener("click", (event) => {
      if (control && !control.contains(event.target)) closeMenu();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        closeMenu();
        toggle.focus();
      }
    });

    menu.addEventListener("click", (event) => {
      const option = event.target.closest(".theme-option");
      if (!option) return;
      const input = option.querySelector('input[name="theme-mode"]');
      if (!input) return;
      event.preventDefault();
      input.checked = true;
      selectMode(input.value);
    });

    menu.addEventListener("change", (event) => {
      const input = event.target.closest('input[name="theme-mode"]');
      if (!input) return;
      selectMode(input.value);
    });
  }

  const onSystemChange = () => {
    if (currentMode() === "system") apply("system");
  };

  if (media) {
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(onSystemChange);
    }
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    apply(storedMode() || "dark");
  });

  apply(currentMode());
})();
