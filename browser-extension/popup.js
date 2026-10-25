
const U = window.VideoCaptureUtils;

const state = {
  settings: { ...U.DEFAULT_SETTINGS },
  current: null,
  batch: [],
  queue: [],
  history: []
};

const $ = (id) => document.getElementById(id);

const els = {
  tabs: Array.from(document.querySelectorAll(".tab")),
  views: {
    current: $("view-current"),
    batch: $("view-batch"),
    queue: $("view-queue"),
    history: $("view-history"),
    settings: $("view-settings")
  },
  status: $("status"),
  routeLabel: $("route-label"),
  currentTitle: $("current-title"),
  currentPlatform: $("current-platform"),
  currentTime: $("current-time"),
  currentUrl: $("current-url"),
  batchCount: $("batch-count"),
  batchList: $("batch-list"),
  queueCount: $("queue-count"),
  queueList: $("queue-list"),
  historyList: $("history-list"),
  settings: {
    vault: $("setting-vault"),
    folder: $("setting-folder"),
    appendPath: $("setting-append"),
    quickAction: $("setting-quick"),
    codexWorkerUrl: $("setting-codex"),
    n8nWebhookUrl: $("setting-n8n"),
    webhookFormat: $("setting-webhook-format"),
    defaultMode: $("setting-mode"),
    defaultLanguage: $("setting-language"),
    obsidianRestProtocol: $("setting-rest-protocol"),
    obsidianRestPort: $("setting-rest-port"),
    obsidianRestToken: $("setting-rest-token")
  }
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message, type = "") {
  els.status.textContent = message || "";
  els.status.className = `status ${type}`.trim();
}

function switchView(name) {
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
  Object.entries(els.views).forEach(([key, view]) => view.classList.toggle("active", key === name));
  if (name === "batch" && state.batch.length === 0) scanPage().catch((error) => setStatus(error.message, "error"));
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function selectedBatchItems() {
  return state.batch.filter((item) => item.checked !== false);
}

function selectedQueueItems() {
  return [...state.queue];
}

function currentItem() {
  if (!state.current?.url) throw new Error("No current video/tab detected.");
  return state.current;
}

function renderCurrent() {
  const item = state.current;
  if (!item) {
    els.currentTitle.textContent = "No current tab detected.";
    els.currentPlatform.textContent = "unknown";
    els.currentTime.textContent = "--:--";
    els.currentUrl.textContent = "no url";
    return;
  }
  els.currentTitle.textContent = item.title;
  els.currentPlatform.textContent = item.platform || U.detectPlatform(item.url);
  els.currentTime.textContent = Number.isFinite(item.timestamp) ? U.formatTimestamp(item.timestamp) : "--:--";
  els.currentUrl.textContent = getHostname(item.url);
}

function renderBatch() {
  els.batchCount.textContent = String(state.batch.length);
  if (state.batch.length === 0) {
    els.batchList.innerHTML = `<div class="empty">No video links found yet.</div>`;
    return;
  }
  els.batchList.innerHTML = "";
  const selectAll = document.createElement("div");
  selectAll.className = "row";
  selectAll.innerHTML = `
    <input type="checkbox" id="batch-select-all" checked />
    <div>
      <div class="row-title">Select all</div>
      <div class="row-meta">${state.batch.length} scanned links</div>
    </div>
    <span class="subtle"></span>
  `;
  els.batchList.appendChild(selectAll);
  selectAll.querySelector("input").addEventListener("change", (event) => {
    state.batch.forEach((item) => {
      item.checked = event.target.checked;
    });
    renderBatch();
  });

  for (const item of state.batch) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <input type="checkbox" ${item.checked === false ? "" : "checked"} />
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(getHostname(item.url))}</div>
      </div>
      <button class="secondary" data-action="queue">Queue</button>
    `;
    row.querySelector("input").addEventListener("change", (event) => {
      item.checked = event.target.checked;
    });
    row.querySelector("button").addEventListener("click", () => queueItems([item]));
    els.batchList.appendChild(row);
  }
}

function renderQueue() {
  els.queueCount.textContent = String(state.queue.length);
  if (state.queue.length === 0) {
    els.queueList.innerHTML = `<div class="empty">Queue is empty.</div>`;
    return;
  }
  els.queueList.innerHTML = "";
  [...state.queue].reverse().forEach((item) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="chip">${escapeHtml(item.platform || U.detectPlatform(item.url))}</span>
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(getHostname(item.url))}</div>
      </div>
      <button class="danger" data-action="remove">Remove</button>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      await send("QUEUE_REMOVE", { url: item.url });
      await refreshState();
      setStatus("Removed from queue.", "success");
    });
    els.queueList.appendChild(row);
  });
}

function renderHistory() {
  if (state.history.length === 0) {
    els.historyList.innerHTML = `<div class="empty">History is empty.</div>`;
    return;
  }
  els.historyList.innerHTML = "";
  [...state.history].reverse().forEach((item) => {
    const row = document.createElement("div");
    row.className = "row";
    const tone = item.status === "error" ? "chip danger" : item.status === "needs-review" ? "chip warning" : "chip";
    const metaParts = [
      item.operation || "",
      item.jobStatus ? `job: ${item.jobStatus}` : "",
      new Date(item.at).toLocaleString()
    ].filter(Boolean);
    row.innerHTML = `
      <span class="${tone}">${escapeHtml(item.status || "done")}</span>
      <div>
        <div class="row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="row-meta">${escapeHtml(metaParts.join(" · "))}</div>
      </div>
      <button class="secondary" data-action="copy">Copy</button>
    `;
    row.querySelector("button").addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.url || "");
      setStatus("Copied history URL.", "success");
    });
    els.historyList.appendChild(row);
  });
}

function renderSettings() {
  const s = state.settings;
  els.routeLabel.textContent = labelOperation(s.quickAction);
  els.settings.vault.value = s.vaultName || "";
  els.settings.folder.value = s.folder || "";
  els.settings.appendPath.value = s.appendPath || "";
  els.settings.quickAction.value = s.quickAction || "create-pending-note";
  els.settings.codexWorkerUrl.value = s.codexWorkerUrl || U.DEFAULT_SETTINGS.codexWorkerUrl;
  els.settings.n8nWebhookUrl.value = s.n8nWebhookUrl || U.DEFAULT_SETTINGS.n8nWebhookUrl;
  els.settings.webhookFormat.value = s.webhookFormat || "unified";
  els.settings.defaultMode.value = s.defaultMode || "summary";
  els.settings.defaultLanguage.value = s.defaultLanguage || "zh";
  els.settings.obsidianRestProtocol.value = s.obsidianRestProtocol || "https";
  els.settings.obsidianRestPort.value = s.obsidianRestPort || 27123;
  els.settings.obsidianRestToken.value = s.obsidianRestToken || "";
}

function renderAll() {
  renderCurrent();
  renderBatch();
  renderQueue();
  renderHistory();
  renderSettings();
}

function labelOperation(operation) {
  const labels = {
    "create-pending-note": "URI note",
    "process-via-plugin": "Plugin direct",
    "create-pending-rest": "REST note",
    "append-link": "Append",
    "send-to-codex-worker": "Worker",
    "send-to-n8n": "n8n",
    queue: "Queue"
  };
  return labels[operation] || "Route";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refreshState() {
  const response = await send("GET_STATE");
  state.settings = response.settings;
  state.queue = response.queue || [];
  state.history = response.history || [];
  state.current = response.current;
  renderAll();
  if (response.targetTab && els.views[response.targetTab]) switchView(response.targetTab);
}

async function scanPage() {
  setStatus("Scanning current page...");
  const response = await send("SCAN_CURRENT_PAGE");
  state.batch = (response.items || []).map((item) => ({ ...item, checked: true }));
  renderBatch();
  setStatus(`Found ${state.batch.length} video links.`, state.batch.length ? "success" : "");
}

async function queueItems(items) {
  if (!items.length) return;
  const response = await send("QUEUE_ADD_MANY", { items });
  state.queue = response.queue || state.queue;
  renderQueue();
  setStatus(`Queued ${items.length} item(s).`, "success");
}

async function transferItems(items, operation) {
  if (!items.length) {
    setStatus("No items selected.", "error");
    return;
  }
  setStatus(`${labelOperation(operation)}: processing ${items.length} item(s)...`);
  const response = await send("TRANSFER_ITEMS", { items, operation });
  const results = response.results || [];
  const ok = results.filter((result) => result.status === "success").length;
  const needsReview = results.filter((result) => result.status === "needs-review").length;
  const failed = results.length - ok - needsReview;
  await refreshState();
  if (failed) {
    const firstError = results.find((result) => result.status === "error")?.error || "Unknown error";
    setStatus(`${ok} succeeded, ${failed} failed. ${firstError}`, "error");
  } else if (needsReview) {
    const firstReview = results.find((result) => result.status === "needs-review")?.error || "Needs review.";
    setStatus(`${ok} completed, ${needsReview} need review. ${firstReview}`, "warning");
  } else {
    setStatus(`${ok} item(s) completed.`, "success");
  }
}

async function copyItems(items) {
  if (!items.length) return;
  await navigator.clipboard.writeText(items.map((item) => U.buildMarkdownLink(item)).join("\n"));
  setStatus(`Copied ${items.length} Markdown link(s).`, "success");
}

async function saveSettings() {
  const settings = {
    vaultName: els.settings.vault.value.trim(),
    folder: els.settings.folder.value.trim(),
    appendPath: els.settings.appendPath.value.trim(),
    quickAction: els.settings.quickAction.value,
    codexWorkerUrl: els.settings.codexWorkerUrl.value.trim(),
    n8nWebhookUrl: els.settings.n8nWebhookUrl.value.trim(),
    webhookFormat: els.settings.webhookFormat.value,
    defaultMode: els.settings.defaultMode.value,
    defaultLanguage: els.settings.defaultLanguage.value,
    obsidianRestProtocol: els.settings.obsidianRestProtocol.value,
    obsidianRestPort: Number(els.settings.obsidianRestPort.value || 27123),
    obsidianRestToken: els.settings.obsidianRestToken.value.trim()
  };
  const response = await send("SAVE_SETTINGS", { settings });
  state.settings = response.settings;
  renderSettings();
  setStatus("Settings saved.", "success");
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  $("btn-current-quick").addEventListener("click", () => {
    const item = currentItem();
    if (state.settings.quickAction === "queue") {
      return queueItems([item]);
    }
    return transferItems([item], state.settings.quickAction);
  });
  $("btn-current-queue").addEventListener("click", () => queueItems([currentItem()]));
  $("btn-current-pending").addEventListener("click", () => transferItems([currentItem()], "create-pending-note"));
  $("btn-current-rest").addEventListener("click", () => transferItems([currentItem()], "create-pending-rest"));
  $("btn-current-append").addEventListener("click", () => transferItems([currentItem()], "append-link"));
  $("btn-current-copy").addEventListener("click", () => send("COPY_TIMESTAMP_LINK").then((r) => setStatus(`Copied: ${r.text}`, "success")));
  $("btn-current-codex").addEventListener("click", () => transferItems([currentItem()], "send-to-codex-worker"));
  $("btn-current-n8n").addEventListener("click", () => transferItems([currentItem()], "send-to-n8n"));

  $("btn-scan").addEventListener("click", scanPage);
  $("btn-batch-queue").addEventListener("click", () => queueItems(selectedBatchItems()));
  $("btn-batch-pending").addEventListener("click", () => transferItems(selectedBatchItems(), "create-pending-note"));
  $("btn-batch-append").addEventListener("click", () => transferItems(selectedBatchItems(), "append-link"));
  $("btn-batch-codex").addEventListener("click", () => transferItems(selectedBatchItems(), "send-to-codex-worker"));
  $("btn-batch-n8n").addEventListener("click", () => transferItems(selectedBatchItems(), "send-to-n8n"));
  $("btn-batch-copy").addEventListener("click", () => copyItems(selectedBatchItems()));

  $("btn-queue-clear").addEventListener("click", async () => {
    await send("QUEUE_CLEAR");
    await refreshState();
    setStatus("Queue cleared.", "success");
  });
  $("btn-queue-pending").addEventListener("click", () => transferItems(selectedQueueItems(), "create-pending-note"));
  $("btn-queue-append").addEventListener("click", () => transferItems(selectedQueueItems(), "append-link"));
  $("btn-queue-codex").addEventListener("click", () => transferItems(selectedQueueItems(), "send-to-codex-worker"));
  $("btn-queue-n8n").addEventListener("click", () => transferItems(selectedQueueItems(), "send-to-n8n"));
  $("btn-queue-copy").addEventListener("click", () => copyItems(selectedQueueItems()));

  $("btn-history-clear").addEventListener("click", async () => {
    await send("HISTORY_CLEAR");
    await refreshState();
    setStatus("History cleared.", "success");
  });
  $("btn-save-settings").addEventListener("click", saveSettings);
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  try {
    await refreshState();
  } catch (error) {
    setStatus(error.message, "error");
  }
});
