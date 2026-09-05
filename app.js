(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const HANDLE_SIZE = 8;
  const MIN_SIDE = 80; // minimal room reserved for the sidebar when the main video is at its maximal size
  const STORAGE_KEY = "twitchMultiView.state.v1";

  /** @type {{channels: string[], mode: "grid"|"focus", mainChannel: string|null, muted: Record<string, boolean>, focusLayoutOption: number}} */
  let state = loadState();

  const el = {
    stage: document.getElementById("stage"),
    emptyState: document.getElementById("emptyState"),
    tilesLayer: document.getElementById("tilesLayer"),
    focusHandle: document.getElementById("focusHandle"),
    addForm: document.getElementById("addForm"),
    channelInput: document.getElementById("channelInput"),
    modeGrid: document.getElementById("modeGrid"),
    modeFocus: document.getElementById("modeFocus"),
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    pauseAllBtn: document.getElementById("pauseAllBtn"),
    muteAllBtn: document.getElementById("muteAllBtn"),
    toolbar: document.getElementById("toolbar"),
  };

  // channel -> { el, player, playing, promoteBtn }. A tile is created once
  // when a channel is added and lives until it's removed — switching modes
  // or resizing only ever repositions these elements, never recreates the
  // underlying Twitch player/iframe.
  const tiles = new Map();

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
          focusLayoutOption: Number.isInteger(parsed.focusLayoutOption) ? parsed.focusLayoutOption : 0,
        };
      }
    } catch (e) {
      console.warn("Failed to load state", e);
    }
    return { channels: [], mode: "grid", mainChannel: null, muted: {}, focusLayoutOption: 0 };
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

  function getMainName() {
    if (state.channels.includes(state.mainChannel)) return state.mainChannel;
    return state.channels[0] || null;
  }

  // ---- Tile lifecycle (created once per channel) ----

  function createTile(name) {
    const container = document.createElement("div");
    container.className = "tile";
    container.dataset.channel = name;

    const mount = document.createElement("div");
    mount.className = "tileMount";
    mount.id = `twitch-player-${name}`;
    container.appendChild(mount);

    const badge = document.createElement("div");
    badge.className = "mainBadge";
    badge.textContent = "PRINCIPAL";
    container.appendChild(badge);

    // Everything lives in a top overlay so nothing ever sits on top of
    // Twitch's own control bar at the bottom of the player.
    const bar = document.createElement("div");
    bar.className = "tileBar";

    const row = document.createElement("div");
    row.className = "tileBarRow";

    // Drag handle: pointer capture means dragging works even while the
    // cursor passes over other tiles' cross-origin Twitch iframes, which
    // would otherwise swallow the mouse events entirely.
    const gripBtn = document.createElement("button");
    gripBtn.className = "iconBtn gripBtn";
    gripBtn.textContent = "⠿";
    gripBtn.title = "Glisser pour réorganiser";
    gripBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startDragReorder(name, e);
    });
    row.appendChild(gripBtn);

    const promoteBtn = document.createElement("button");
    promoteBtn.className = "iconBtn promoteBtn";
    promoteBtn.textContent = "⭐";
    promoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.mode === "grid") {
        switchToFocus(name);
      } else if (state.mode === "focus" && name !== getMainName()) {
        setMain(name);
      }
    });
    row.appendChild(promoteBtn);

    const nameEl = document.createElement("div");
    nameEl.className = "tileName";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "iconBtn danger";
    removeBtn.textContent = "✕";
    removeBtn.title = "Retirer";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeChannel(name);
    });
    row.appendChild(removeBtn);

    bar.appendChild(row);
    container.appendChild(bar);

    el.tilesLayer.appendChild(container);

    const record = { el: container, player: null, playing: true, promoteBtn };
    tiles.set(name, record);

    if (window.Twitch && window.Twitch.Player) {
      const player = new window.Twitch.Player(mount.id, {
        width: "100%",
        height: "100%",
        channel: name,
        parent: [location.hostname || "localhost"],
        muted: true,
        autoplay: true,
      });
      record.player = player;
      try {
        player.addEventListener(window.Twitch.Player.PLAY, () => {
          record.playing = true;
          updatePauseAllButton();
        });
        player.addEventListener(window.Twitch.Player.PAUSE, () => {
          record.playing = false;
          updatePauseAllButton();
        });
      } catch (e) {
        /* ignore */
      }
    } else {
      console.warn("Twitch embed SDK not available; falling back to iframe for", name);
      const iframe = document.createElement("iframe");
      iframe.allowFullscreen = true;
      const params = new URLSearchParams({
        channel: name,
        parent: location.hostname || "localhost",
        muted: "true",
        autoplay: "true",
      });
      iframe.src = `https://player.twitch.tv/?${params.toString()}`;
      mount.appendChild(iframe);
    }

    updatePauseAllButton();
    return record;
  }

  function destroyTile(name) {
    const record = tiles.get(name);
    if (!record) return;
    try {
      if (record.player && typeof record.player.destroy === "function") {
        record.player.destroy();
      }
    } catch (e) {
      /* ignore */
    }
    record.el.remove();
    tiles.delete(name);
    updatePauseAllButton();
  }

  function setPlayerMuted(name, muted) {
    const record = tiles.get(name);
    if (!record) return;
    try {
      if (record.player && typeof record.player.setMuted === "function") {
        record.player.setMuted(muted);
      }
    } catch (e) {
      /* player not ready yet; it will pick up the initial "muted" option */
    }
  }

  // Sets who the (unmuted) main channel is, muting every other channel —
  // only called on an explicit promotion, never on resize/relayout, so a
  // manual mute/unmute elsewhere is never fought over otherwise.
  function promoteMain(name) {
    state.mainChannel = name;
    for (const other of state.channels) {
      if (other === name) continue;
      if (state.muted[other] !== true) {
        state.muted[other] = true;
        setPlayerMuted(other, true);
      }
    }
    state.muted[name] = false;
    setPlayerMuted(name, false);
  }

  // ---- Global controls (toolbar) ----

  function anyPlaying() {
    for (const record of tiles.values()) {
      if (record.playing) return true;
    }
    return false;
  }

  function updatePauseAllButton() {
    const playing = anyPlaying();
    el.pauseAllBtn.textContent = playing ? "⏸ Tout mettre en pause" : "▶ Tout lancer";
    el.pauseAllBtn.title = playing
      ? "Mettre tous les streams en pause"
      : "Lancer la lecture de tous les streams";
  }

  el.pauseAllBtn.addEventListener("click", () => {
    const shouldPause = anyPlaying();
    for (const record of tiles.values()) {
      try {
        if (shouldPause) record.player?.pause();
        else record.player?.play();
      } catch (e) {
        /* ignore */
      }
      record.playing = !shouldPause;
    }
    updatePauseAllButton();
  });

  el.muteAllBtn.addEventListener("click", () => {
    for (const name of state.channels) {
      state.muted[name] = true;
      setPlayerMuted(name, true);
    }
    saveState();
  });

  // ---- State mutations ----

  function addChannels(input) {
    const parts = input.split(",").map(normalizeChannel).filter(Boolean);
    let added = false;
    for (const name of parts) {
      if (!state.channels.includes(name)) {
        state.channels.push(name);
        if (state.muted[name] === undefined) state.muted[name] = true;
        createTile(name);
        added = true;
      }
    }
    if (added) {
      if (!state.mainChannel) {
        if (state.mode === "focus") {
          promoteMain(state.channels[0]);
        } else {
          state.mainChannel = state.channels[0];
        }
      }
      saveState();
      layoutAll();
    }
  }

  function removeChannel(name) {
    state.channels = state.channels.filter((c) => c !== name);
    delete state.muted[name];
    destroyTile(name);
    if (state.mainChannel === name) {
      const next = state.channels[0] || null;
      if (next && state.mode === "focus") {
        promoteMain(next);
      } else {
        state.mainChannel = next;
      }
    }
    saveState();
    layoutAll();
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === "focus" && !getMainName() && state.channels.length) {
      promoteMain(state.channels[0]);
    }
    saveState();
    el.modeGrid.classList.toggle("active", state.mode === "grid");
    el.modeFocus.classList.toggle("active", state.mode === "focus");
    layoutAll();
  }

  function setMain(name) {
    promoteMain(name);
    saveState();
    layoutAll();
  }

  function switchToFocus(name) {
    state.mode = "focus";
    promoteMain(name);
    saveState();
    el.modeGrid.classList.toggle("active", false);
    el.modeFocus.classList.toggle("active", true);
    layoutAll();
  }

  // ---- Layout ----

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

  // Lays out `names` inside a box (boxX,boxY,boxW,boxH), maximizing each
  // tile's area, centering the whole block and centering each (possibly
  // partial) row within it — matching how a wrapping flex row with
  // justify-content:center looks. Used for grid mode and for the focus
  // sidebar when the main video is at its maximal size.
  function packGrid(names, boxX, boxY, boxW, boxH, positions) {
    const n = names.length;
    if (n === 0) return;
    const { cols, rows, w, h } = computeGrid(n, boxW, boxH, RATIO, GAP);
    const totalW = cols * w + (cols - 1) * GAP;
    const totalH = rows * h + (rows - 1) * GAP;
    const offsetX = boxX + (boxW - totalW) / 2;
    const offsetY = boxY + (boxH - totalH) / 2;

    names.forEach((name, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = Math.min(cols, n - row * cols);
      const rowW = itemsInRow * w + (itemsInRow - 1) * GAP;
      const rowOffsetX = offsetX + (totalW - rowW) / 2;
      const x = rowOffsetX + col * (w + GAP);
      const y = offsetY + row * (h + GAP);
      positions.set(name, { x, y, w, h, isMain: false });
    });
  }

  // Lays out `names` in exactly `cols` columns filling the full box height —
  // used for the focus sidebar when the user has picked a specific column
  // count (row orientation: main left, sidebar right).
  function packFixedCols(names, boxX, boxY, boxH, cols, positions) {
    const n = names.length;
    const rows = Math.ceil(n / cols);
    const tileH = (boxH - (rows - 1) * GAP) / rows;
    const tileW = tileH * RATIO;
    const totalW = cols * tileW + (cols - 1) * GAP;

    names.forEach((name, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = Math.min(cols, n - row * cols);
      const rowW = itemsInRow * tileW + (itemsInRow - 1) * GAP;
      const rowOffsetX = boxX + (totalW - rowW) / 2;
      const x = rowOffsetX + col * (tileW + GAP);
      const y = boxY + row * (tileH + GAP);
      positions.set(name, { x, y, w: tileW, h: tileH, isMain: false });
    });
  }

  // Same as packFixedCols but forcing a row count instead, filling the full
  // box width — used when the sidebar sits below the main video (column
  // orientation: main top, sidebar bottom).
  function packFixedRows(names, boxX, boxY, boxW, rows, positions) {
    const n = names.length;
    const cols = Math.ceil(n / rows);
    const tileW = (boxW - (cols - 1) * GAP) / cols;
    const tileH = tileW / RATIO;

    names.forEach((name, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const itemsInRow = Math.min(cols, n - row * cols);
      const rowW = itemsInRow * tileW + (itemsInRow - 1) * GAP;
      const rowOffsetX = boxX + (boxW - rowW) / 2;
      const x = rowOffsetX + col * (tileW + GAP);
      const y = boxY + row * (tileH + GAP);
      positions.set(name, { x, y, w: tileW, h: tileH, isMain: false });
    });
  }

  function computeMainFit(areaW, areaH) {
    let w, h;
    if (areaW / areaH > RATIO) {
      h = areaH;
      w = h * RATIO;
    } else {
      w = areaW;
      h = w / RATIO;
    }
    return { w, h };
  }

  // The area the main video gets for a given layout "option":
  //  - option 0: the main video is as large as the available height (row
  //    orientation) or width (column orientation) allows — its maximal size.
  //  - option k (1..otherCount): the sidebar is forced into exactly k
  //    columns (row orientation) or k rows (column orientation), each
  //    filling the full cross-axis, and the main video gets whatever
  //    space is left.
  // These are the only layouts where either the main video or the sidebar
  // is truly maximized — anything in between wastes space on one side.
  function computeMainArea(option, otherCount, availW, availH, isRow) {
    if (option === 0) {
      if (isRow) {
        const mainAreaH = availH;
        const idealW = mainAreaH * RATIO;
        const maxW = Math.max(availW - HANDLE_SIZE - MIN_SIDE, availW * 0.2);
        return { mainAreaW: Math.min(idealW, maxW), mainAreaH };
      }
      const mainAreaW = availW;
      const idealH = mainAreaW / RATIO;
      const maxH = Math.max(availH - HANDLE_SIZE - MIN_SIDE, availH * 0.2);
      return { mainAreaW, mainAreaH: Math.min(idealH, maxH) };
    }
    if (isRow) {
      const rows = Math.ceil(otherCount / option);
      const tileH = (availH - (rows - 1) * GAP) / rows;
      const tileW = tileH * RATIO;
      const sidebarW = option * tileW + (option - 1) * GAP;
      return { mainAreaW: Math.max(availW - sidebarW - HANDLE_SIZE, 20), mainAreaH: availH };
    }
    const cols = Math.ceil(otherCount / option);
    const tileW = (availW - (cols - 1) * GAP) / cols;
    const tileH = tileW / RATIO;
    const sidebarH = option * tileH + (option - 1) * GAP;
    return { mainAreaW: availW, mainAreaH: Math.max(availH - sidebarH - HANDLE_SIZE, 20) };
  }

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  function layoutAll(overrideOption) {
    const hasChannels = state.channels.length > 0;
    el.emptyState.style.display = hasChannels ? "none" : "flex";
    if (!hasChannels) {
      el.focusHandle.classList.remove("visible");
      return;
    }

    const rect = el.stage.getBoundingClientRect();
    const availW = rect.width - GAP * 2;
    const availH = rect.height - GAP * 2;
    const positions = new Map();
    let handleBox = null;

    if (state.mode === "grid") {
      packGrid(state.channels, GAP, GAP, availW, availH, positions);
    } else {
      const mainName = getMainName();
      const others = state.channels.filter((c) => c !== mainName);
      const isRow = availW >= availH;

      if (others.length === 0) {
        const fit = computeMainFit(availW, availH);
        positions.set(mainName, {
          x: GAP + (availW - fit.w) / 2,
          y: GAP + (availH - fit.h) / 2,
          w: fit.w,
          h: fit.h,
          isMain: true,
        });
      } else {
        const option = clamp(0, overrideOption ?? state.focusLayoutOption, others.length);
        const { mainAreaW, mainAreaH } = computeMainArea(option, others.length, availW, availH, isRow);
        const fit = computeMainFit(mainAreaW, mainAreaH);
        positions.set(mainName, {
          x: GAP + (mainAreaW - fit.w) / 2,
          y: GAP + (mainAreaH - fit.h) / 2,
          w: fit.w,
          h: fit.h,
          isMain: true,
        });

        if (isRow) {
          const sidebarX = GAP + mainAreaW + HANDLE_SIZE;
          if (option === 0) {
            packGrid(others, sidebarX, GAP, availW - mainAreaW - HANDLE_SIZE, availH, positions);
          } else {
            packFixedCols(others, sidebarX, GAP, availH, option, positions);
          }
          handleBox = { x: GAP + mainAreaW, y: GAP, w: HANDLE_SIZE, h: availH, orientation: "row" };
        } else {
          const sidebarY = GAP + mainAreaH + HANDLE_SIZE;
          if (option === 0) {
            packGrid(others, GAP, sidebarY, availW, availH - mainAreaH - HANDLE_SIZE, positions);
          } else {
            packFixedRows(others, GAP, sidebarY, availW, option, positions);
          }
          handleBox = { x: GAP, y: GAP + mainAreaH, w: availW, h: HANDLE_SIZE, orientation: "col" };
        }
      }
    }

    for (const [name, record] of tiles) {
      const pos = positions.get(name);
      if (!pos) {
        record.el.style.width = "0px";
        record.el.style.height = "0px";
        continue;
      }
      record.el.style.left = `${Math.round(pos.x)}px`;
      record.el.style.top = `${Math.round(pos.y)}px`;
      record.el.style.width = `${Math.floor(pos.w)}px`;
      record.el.style.height = `${Math.floor(pos.h)}px`;
      record.el.classList.toggle("is-main", pos.isMain);
      // The promote button does nothing for the tile that's already the
      // interactive main video — hide it there instead of leaving a dead button.
      const isPromotable = state.mode === "grid" || !pos.isMain;
      record.promoteBtn.classList.toggle("hidden", !isPromotable);
      record.promoteBtn.title = state.mode === "grid" ? "Agrandir en focus" : "Passer en principal";
    }

    if (handleBox) {
      el.focusHandle.classList.add("visible");
      el.focusHandle.classList.toggle("row", handleBox.orientation === "row");
      el.focusHandle.classList.toggle("col", handleBox.orientation === "col");
      el.focusHandle.style.left = `${Math.round(handleBox.x)}px`;
      el.focusHandle.style.top = `${Math.round(handleBox.y)}px`;
      el.focusHandle.style.width = `${Math.floor(handleBox.w)}px`;
      el.focusHandle.style.height = `${Math.floor(handleBox.h)}px`;
    } else {
      el.focusHandle.classList.remove("visible");
    }
  }

  // ---- Drag to resize the main video ----
  //
  // The handle doesn't move freely: it only ever rests at one of the
  // "optimal" layouts computed by computeMainArea (main maximal, or the
  // sidebar in exactly 1/2/3/... columns), so dragging picks whichever of
  // those is closest to the pointer instead of any arbitrary position.

  let dragging = false;
  let dragOption = null;

  function pickNearestOption(rawMainSize, otherCount, availW, availH, isRow) {
    let bestOption = 0;
    let bestDiff = Infinity;
    for (let k = 0; k <= otherCount; k++) {
      const area = computeMainArea(k, otherCount, availW, availH, isRow);
      const size = isRow ? area.mainAreaW : area.mainAreaH;
      const diff = Math.abs(size - rawMainSize);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestOption = k;
      }
    }
    return bestOption;
  }

  el.focusHandle.addEventListener("pointerdown", (e) => {
    if (!el.focusHandle.classList.contains("visible")) return;
    dragging = true;
    dragOption = state.focusLayoutOption;
    el.focusHandle.classList.add("dragging");
    el.focusHandle.setPointerCapture(e.pointerId);
  });

  el.focusHandle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = el.stage.getBoundingClientRect();
    const availW = rect.width - GAP * 2;
    const availH = rect.height - GAP * 2;
    const isRow = el.focusHandle.classList.contains("row");
    const rawMainSize = isRow ? e.clientX - rect.left - GAP : e.clientY - rect.top - GAP;
    const otherCount = Math.max(0, state.channels.length - 1);
    dragOption = pickNearestOption(rawMainSize, otherCount, availW, availH, isRow);
    layoutAll(dragOption);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    el.focusHandle.classList.remove("dragging");
    if (dragOption !== null) {
      state.focusLayoutOption = dragOption;
      saveState();
    }
  }
  el.focusHandle.addEventListener("pointerup", endDrag);
  el.focusHandle.addEventListener("pointercancel", endDrag);

  // ---- Drag to reorder tiles ----

  let reorderSource = null;
  let reorderTarget = null;

  function startDragReorder(name, downEvent) {
    reorderSource = name;
    reorderTarget = null;
    const grip = downEvent.currentTarget;
    tiles.get(name)?.el.classList.add("drag-source");

    const onMove = (e) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const tileEl = hit && hit.closest(".tile");
      const targetName = tileEl && tileEl.dataset.channel;
      if (targetName !== reorderTarget) {
        if (reorderTarget) tiles.get(reorderTarget)?.el.classList.remove("drag-target");
        reorderTarget = targetName && targetName !== reorderSource ? targetName : null;
        if (reorderTarget) tiles.get(reorderTarget)?.el.classList.add("drag-target");
      }
    };

    const onUp = () => {
      grip.releasePointerCapture(downEvent.pointerId);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      tiles.get(reorderSource)?.el.classList.remove("drag-source");
      if (reorderTarget) {
        tiles.get(reorderTarget)?.el.classList.remove("drag-target");
        const i = state.channels.indexOf(reorderSource);
        const j = state.channels.indexOf(reorderTarget);
        if (i !== -1 && j !== -1) {
          [state.channels[i], state.channels[j]] = [state.channels[j], state.channels[i]];
          saveState();
          layoutAll();
        }
      }
      reorderSource = null;
      reorderTarget = null;
    };

    grip.setPointerCapture(downEvent.pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  // ---- Wiring ----

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

  el.fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layoutAll(), 60);
  });
  ro.observe(el.stage);

  // ---- Init ----

  function init() {
    el.modeGrid.classList.toggle("active", state.mode === "grid");
    el.modeFocus.classList.toggle("active", state.mode === "focus");
    for (const name of state.channels) {
      createTile(name);
    }
    layoutAll();
  }

  if (window.Twitch && window.Twitch.Player) {
    init();
  } else {
    // The embed SDK script tag is loaded before app.js in index.html, so
    // this only matters if it's still parsing/executing.
    window.addEventListener("load", init, { once: true });
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((e) => {
        console.warn("Service worker registration failed", e);
      });
    });
  }
})();
