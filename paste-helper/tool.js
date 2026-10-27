const toolId = document.body.dataset.toolId;

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

function setField(name, value) {
  if (!value) return;
  document.querySelectorAll(`[data-tool="${name}"]`).forEach((node) => {
    node.textContent = value;
  });
}

async function hydrate() {
  try {
    const response = await fetch("../data/tools.json", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const catalog = await response.json();
    const tool = catalog.tools.find((item) => item.id === toolId);
    if (!tool) return;

    setField("version", tool.version ? `v${tool.version}` : "");
    setField("updated", tool.updated || "");
    setField("size", tool.size || "");
    setField("platforms", (tool.platforms || []).join(" / "));
    setField("sha256", tool.sha256 || "");

    if (tool.storeUrl) {
      document.querySelectorAll("[data-store-link]").forEach((link) => {
        link.href = tool.storeUrl;
      });
    }

    if (tool.downloadUrl) {
      document.querySelectorAll("[data-download-file]").forEach((link) => {
        link.href = tool.downloadUrl;
      });
      const download = document.querySelector('[data-external="download"]');
      if (download) download.href = tool.downloadUrl;
    }

    if (tool.externalUrl) {
      const home = document.querySelector('[data-external="home"]');
      if (home) home.href = tool.externalUrl;
    }

    if (Array.isArray(tool.versions) && tool.versions.length > 0) {
      const summary = document.querySelector("#versionSummary");
      if (summary) {
        summary.textContent = `当前共 ${tool.versions.length} 个版本`;
      }

      const list = document.querySelector("#versionList");
      if (list) {
        list.innerHTML = tool.versions
          .map((version) => {
            const notes = (version.notes || [])
              .map((note) => `<li>${escapeHtml(note)}</li>`)
              .join("");
            return `
              <article class="version-item">
                <div class="version-head">
                  <strong>v${escapeHtml(version.version)}</strong>
                  <span>${escapeHtml(version.date || "")}</span>
                  ${version.current ? '<span class="badge badge-success">当前版本</span>' : ""}
                </div>
                ${notes ? `<ul>${notes}</ul>` : ""}
              </article>`;
          })
          .join("");
      }
    }
  } catch (error) {
    console.error(error);
  }
}

hydrate();
