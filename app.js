(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const STORAGE_KEY = "twitchMultiView.state.v1";
  const MIN_MAIN_FRAC = 0.25;
  const MAX_MAIN_FRAC = 0.8;

  /** @type {{channels: string[], mode: "grid"|"focus", mainChannel: string|null, muted: Record<string, boolean>, focusMainFrac: number}} */
  let state = loadState();

  const el = {
    stage: document.getElementById("stage"),
    emptyState: document.getElementById("emptyState"),
    gridView: document.getElementById("gridView"),
    focusView: document.getElementById("focusView"),
    focusMain: document.getElementById("focusMain"),
    focusHandle: document.getElementById("focusHandle"),
    focusSidebar: document.getElementById("focusSidebar"),
    addForm: document.getElementById("addForm"),
    channelInput: document.getElementById("channelInput"),
    modeGrid: document.getElementById("modeGrid"),
    modeFocus: document.getElementById("modeFocus"),
    toggleToolbar: document.getElementById("toggleToolbar"),
    toolbar: document.getElementById("toolbar"),
  };

  // Tracks what's currently built in the DOM so we only recreate <iframe>s
  // (which reloads the stream) when the set of channels actually changes,
  // not on every resize/drag.
  let builtKey = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          channels: Array.isArray(parsed.channels) ? parsed.channels : [],
          mode: parsed.mode === "focus" ? "focus" : "grid",
          mainChannel: parsed.mainChannel || null,
          muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
          focusMainFrac: typeof parsed.focusMainFrac === "number" ? parsed.focusMainFrac : 0.62,
        };
      }
    } catch (e) {
      console.warn("Failed to load state", e);
    }
    return { channels: [], mode: "grid", mainChannel: null, muted: {}, focusMainFrac: 0.62 };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function normalizeChannel(raw) {
    let s = raw.trim().toLowerCase();
    if (!s) return null;
    try {
      if (s.includes("twitch.tv/")) {
        const url = new URL(s.startsWith("http") ? s : `https://${s}`);
        s = url.pathname.split("/").filter(Boolean)[0] || "";
      }
    } catch (e) {
      /* not a URL, keep as-is */
    }
    s = s.replace(/[^a-z0-9_]/g, "");
    return s || null;
  }

  function addChannels(input) {
    const parts = input.split(",").map(normalizeChannel).filter(Boolean);
    let added = false;
    for (const name of parts) {
      if (!state.channels.includes(name)) {
        state.channels.push(name);
        if (state.muted[name] === undefined) state.muted[name] = true;
        added = true;
      }
    }
    if (added) {
      if (!state.mainChannel) state.mainChannel = state.channels[0];
      saveState();
      render();
    }
  }

  function removeChannel(name) {
    state.channels = state.channels.filter((c) => c !== name);
    delete state.muted[name];
    if (state.mainChannel === name) {
      state.mainChannel = state.channels[0] || null;
    }
    saveState();
    render();
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === "focus" && !state.mainChannel && state.channels.length) {
      state.mainChannel = state.channels[0];
    }
    saveState();
    render();
  }

  function setMain(name) {
    state.mainChannel = name;
    saveState();
    render();
  }

  function toggleMute(name) {
    state.muted[name] = !state.muted[name];
    saveState();
    const tile = el.gridView.querySelector(`.tile[data-channel="${cssEscape(name)}"]`);
    if (tile) {
      const iframe = tile.querySelector("iframe");
      const muted = state.muted[name] !== false;
      iframe.src = embedUrl(name, muted);
      const btn = tile.querySelector(".iconBtn.muteBtn");
      if (btn) {
        btn.classList.toggle("muted", muted);
        btn.textContent = muted ? "🔇" : "🔊";
        btn.title = muted ? "Activer le son" : "Couper le son";
      }
    }
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  }

  function embedUrl(channel, muted) {
    const params = new URLSearchParams();
    params.set("channel", channel);
    params.set("parent", location.hostname || "localhost");
    params.set("muted", muted ? "true" : "false");
    params.set("autoplay", "true");
    return `https://player.twitch.tv/?${params.toString()}`;
  }

  function makeTile(name, { muted, showMuteToggle, badge }) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.channel = name;

    const iframe = document.createElement("iframe");
    iframe.src = embedUrl(name, muted);
    iframe.allowFullscreen = true;
    tile.appendChild(iframe);

    if (badge) {
      const b = document.createElement("div");
      b.className = "mainBadge";
      b.textContent = "PRINCIPAL";
      tile.appendChild(b);
    }

    const bar = document.createElement("div");
    bar.className = "tileBar";

    const nameEl = document.createElement("div");
    nameEl.className = "tileName";
    nameEl.textContent = name;
    bar.appendChild(nameEl);

    const actions = document.createElement("div");
    actions.className = "tileActions";

    if (showMuteToggle) {
      const muted0 = state.muted[name] !== false;
      const muteBtn = document.createElement("button");
      muteBtn.className = "iconBtn muteBtn" + (muted0 ? " muted" : "");
      muteBtn.textContent = muted0 ? "🔇" : "🔊";
      muteBtn.title = muted0 ? "Activer le son" : "Couper le son";
      muteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMute(name);
      });
      actions.appendChild(muteBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "iconBtn danger";
    removeBtn.textContent = "✕";
    removeBtn.title = "Retirer";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeChannel(name);
    });
    actions.appendChild(removeBtn);

    bar.appendChild(actions);
    tile.appendChild(bar);

    return tile;
  }

  function computeGrid(n, W, H, ratio, gap) {
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const availW = W - gap * (cols - 1);
      const availH = H - gap * (rows - 1);
      if (availW <= 0 || availH <= 0) continue;
      let w = availW / cols;
      let h = w / ratio;
      if (h * rows > availH) {
        h = availH / rows;
        w = h * ratio;
      }
      const area = w * h;
      if (!best || area > best.area) {
        best = { area, cols, rows, w, h };
      }
    }
    if (!best) best = { cols: 1, rows: n, w: W, h: W / ratio };
    return best;
  }

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  // ---- Grid mode ----

  function buildGrid() {
    el.gridView.innerHTML = "";
    for (const name of state.channels) {
      const tile = makeTile(name, {
        muted: state.muted[name] !== false,
        showMuteToggle: true,
        badge: false,
      });
      el.gridView.appendChild(tile);
    }
  }

  function layoutGrid() {
    const n = state.channels.length;
    if (n === 0) return;
    const rect = el.gridView.getBoundingClientRect();
    const W = rect.width - GAP * 2;
    const H = rect.height - GAP * 2;
    const { w, h } = computeGrid(n, W, H, RATIO, GAP);
    for (const tile of el.gridView.children) {
      tile.style.width = `${Math.floor(w)}px`;
      tile.style.height = `${Math.floor(h)}px`;
    }
  }

  // ---- Focus mode ----

  function buildFocus(mainName, others) {
    el.focusMain.innerHTML = "";
    el.focusSidebar.innerHTML = "";

    const mainTile = makeTile(mainName, { muted: false, showMuteToggle: false, badge: others.length > 0 });
    el.focusMain.appendChild(mainTile);

    for (const name of others) {
      const tile = makeTile(name, { muted: true, showMuteToggle: false, badge: false });
      tile.addEventListener("click", () => setMain(name));
      el.focusSidebar.appendChild(tile);
    }
  }

  function layoutFocus(mainName, others, overrideFrac) {
    const rect = el.stage.getBoundingClientRect();
    const W = rect.width - GAP * 2;
    const H = rect.height - GAP * 2;
    const isRow = W >= H;

    el.focusView.classList.toggle("row", isRow);
    el.focusView.classList.toggle("col", !isRow);
    el.focusHandle.classList.toggle("visible", others.length > 0);

    const mainTile = el.focusMain.firstElementChild;
    if (!mainTile) return;

    let mainW, mainH;

    if (others.length === 0) {
      el.focusMain.style.width = `${Math.floor(W)}px`;
      el.focusMain.style.height = `${Math.floor(H)}px`;
      el.focusSidebar.style.width = "0px";
      el.focusSidebar.style.height = "0px";
      if (W / H > RATIO) {
        mainH = H;
        mainW = mainH * RATIO;
      } else {
        mainW = W;
        mainH = mainW / RATIO;
      }
      mainTile.style.width = `${Math.floor(mainW)}px`;
      mainTile.style.height = `${Math.floor(mainH)}px`;
      return;
    }

    const frac = clamp(MIN_MAIN_FRAC, overrideFrac ?? state.focusMainFrac, MAX_MAIN_FRAC);
    const handleSize = 8;

    if (isRow) {
      const mainAreaW = W * frac - handleSize / 2;
      const sidebarW = W - mainAreaW - GAP * 2 - handleSize;
      const mainAreaH = H;

      el.focusMain.style.width = `${Math.floor(mainAreaW)}px`;
      el.focusMain.style.height = `${Math.floor(mainAreaH)}px`;
      el.focusSidebar.style.width = `${Math.floor(sidebarW)}px`;
      el.focusSidebar.style.height = `${Math.floor(mainAreaH)}px`;

      if (mainAreaW / mainAreaH > RATIO) {
        mainH = mainAreaH;
        mainW = mainH * RATIO;
      } else {
        mainW = mainAreaW;
        mainH = mainAreaW / RATIO;
      }
      mainTile.style.width = `${Math.floor(mainW)}px`;
      mainTile.style.height = `${Math.floor(mainH)}px`;

      const { w, h } = computeGrid(others.length, sidebarW, H, RATIO, GAP);
      for (const tile of el.focusSidebar.children) {
        tile.style.width = `${Math.floor(w)}px`;
        tile.style.height = `${Math.floor(h)}px`;
      }
    } else {
      const mainAreaH = H * frac - handleSize / 2;
      const sidebarH = H - mainAreaH - GAP * 2 - handleSize;
      const mainAreaW = W;

      el.focusMain.style.width = `${Math.floor(mainAreaW)}px`;
      el.focusMain.style.height = `${Math.floor(mainAreaH)}px`;
      el.focusSidebar.style.width = `${Math.floor(mainAreaW)}px`;
      el.focusSidebar.style.height = `${Math.floor(sidebarH)}px`;

      if (mainAreaW / mainAreaH > RATIO) {
        mainH = mainAreaH;
        mainW = mainH * RATIO;
      } else {
        mainW = mainAreaW;
        mainH = mainAreaW / RATIO;
      }
      mainTile.style.width = `${Math.floor(mainW)}px`;
      mainTile.style.height = `${Math.floor(mainH)}px`;

      const { w, h } = computeGrid(others.length, W, sidebarH, RATIO, GAP);
      for (const tile of el.focusSidebar.children) {
        tile.style.width = `${Math.floor(w)}px`;
        tile.style.height = `${Math.floor(h)}px`;
      }
    }
  }

  // ---- Drag to resize the main video ----

  let dragging = false;
  let dragFrac = null;

  el.focusHandle.addEventListener("pointerdown", (e) => {
    if (!el.focusHandle.classList.contains("visible")) return;
    dragging = true;
    dragFrac = state.focusMainFrac;
    el.focusHandle.classList.add("dragging");
    el.focusHandle.setPointerCapture(e.pointerId);
  });

  el.focusHandle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = el.stage.getBoundingClientRect();
    const isRow = el.focusView.classList.contains("row");
    const frac = isRow
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height;
    dragFrac = clamp(MIN_MAIN_FRAC, frac, MAX_MAIN_FRAC);
    const mainName = getMainName();
    const others = state.channels.filter((c) => c !== mainName);
    layoutFocus(mainName, others, dragFrac);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.focusHandle.classList.remove("dragging");
    if (dragFrac !== null) {
      state.focusMainFrac = dragFrac;
      saveState();
    }
  }
  el.focusHandle.addEventListener("pointerup", endDrag);
  el.focusHandle.addEventListener("pointercancel", endDrag);

  function getMainName() {
    if (state.channels.includes(state.mainChannel)) return state.mainChannel;
    return state.channels[0];
  }

  // ---- Top-level render ----

  function keyFor() {
    const mainName = getMainName();
    return `${state.mode}|${state.channels.join(",")}|${mainName}`;
  }

  function render() {
    const hasChannels = state.channels.length > 0;
    el.emptyState.style.display = hasChannels ? "none" : "flex";
    el.gridView.classList.toggle("active", hasChannels && state.mode === "grid");
    el.focusView.classList.toggle("active", hasChannels && state.mode === "focus");

    el.modeGrid.classList.toggle("active", state.mode === "grid");
    el.modeFocus.classList.toggle("active", state.mode === "focus");

    if (!hasChannels) {
      builtKey = null;
      return;
    }

    const key = keyFor();
    const needsRebuild = key !== builtKey;

    if (state.mode === "grid") {
      if (needsRebuild) buildGrid();
      layoutGrid();
    } else {
      const mainName = getMainName();
      const others = state.channels.filter((c) => c !== mainName);
      if (needsRebuild) buildFocus(mainName, others);
      layoutFocus(mainName, others);
    }

    builtKey = key;
  }

  el.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = el.channelInput.value;
    if (val.trim()) {
      addChannels(val);
      el.channelInput.value = "";
    }
  });

  el.modeGrid.addEventListener("click", () => setMode("grid"));
  el.modeFocus.addEventListener("click", () => setMode("focus"));

  el.toggleToolbar.addEventListener("click", () => {
    el.toolbar.classList.toggle("collapsed");
    el.toggleToolbar.textContent = el.toolbar.classList.contains("collapsed") ? "▸" : "▾";
  });

  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 60);
  });
  ro.observe(el.stage);

  render();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((e) => {
        console.warn("Service worker registration failed", e);
      });
    });
  }
})();
