(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const HANDLE_SIZE = 8;
  const STORAGE_KEY = "twitchMultiView.state.v1";
  const MIN_MAIN_FRAC = 0.25;
  const MAX_MAIN_FRAC = 0.8;

  /** @type {{channels: string[], mode: "grid"|"focus", mainChannel: string|null, muted: Record<string, boolean>, focusMainFrac: number}} */
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
    toolbar: document.getElementById("toolbar"),
  };

  // channel -> { el, player, muteBtn, playPauseBtn, nameEl, playing }. A tile is created once when
  // a channel is added and lives until it's removed — switching modes or
  // resizing only ever repositions these elements, never recreates the
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

    const bar = document.createElement("div");
    bar.className = "tileBar";

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
    bar.appendChild(gripBtn);

    const nameEl = document.createElement("div");
    nameEl.className = "tileName";
    nameEl.textContent = name;
    nameEl.title = "";
    nameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.mode === "grid") {
        switchToFocus(name);
      } else if (state.mode === "focus" && name !== getMainName()) {
        setMain(name);
      }
    });
    bar.appendChild(nameEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "iconBtn danger";
    removeBtn.textContent = "✕";
    removeBtn.title = "Retirer";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeChannel(name);
    });
    bar.appendChild(removeBtn);

    container.appendChild(bar);

    // Bottom control strip: fullscreen / mute / play-pause, revealed on hover.
    const controls = document.createElement("div");
    controls.className = "tileControls";

    const fullscreenTileBtn = document.createElement("button");
    fullscreenTileBtn.className = "iconBtn";
    fullscreenTileBtn.textContent = "⛶";
    fullscreenTileBtn.title = "Plein écran";
    fullscreenTileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (document.fullscreenElement === container) {
        document.exitFullscreen();
      } else {
        container.requestFullscreen().catch(() => {});
      }
    });
    controls.appendChild(fullscreenTileBtn);

    const muteBtn = document.createElement("button");
    muteBtn.className = "iconBtn muteBtn";
    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMute(name);
    });
    controls.appendChild(muteBtn);

    const playPauseBtn = document.createElement("button");
    playPauseBtn.className = "iconBtn playPauseBtn";
    playPauseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlayback(name);
    });
    controls.appendChild(playPauseBtn);

    container.appendChild(controls);

    el.tilesLayer.appendChild(container);

    let player = null;
    if (window.Twitch && window.Twitch.Player) {
      player = new window.Twitch.Player(mount.id, {
        width: "100%",
        height: "100%",
        channel: name,
        parent: [location.hostname || "localhost"],
        muted: true,
        autoplay: true,
      });
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

    const record = { el: container, player, muteBtn, playPauseBtn, nameEl, playing: true };
    tiles.set(name, record);
    updateMuteButton(name);
    updatePlayPauseButton(name);
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

  function updateMuteButton(name) {
    const record = tiles.get(name);
    if (!record) return;
    const muted = state.muted[name] !== false;
    record.muteBtn.classList.toggle("muted", muted);
    record.muteBtn.textContent = muted ? "🔇" : "🔊";
    record.muteBtn.title = muted ? "Activer le son" : "Couper le son";
  }

  function toggleMute(name) {
    state.muted[name] = !(state.muted[name] !== false);
    saveState();
    updateMuteButton(name);
    setPlayerMuted(name, state.muted[name] !== false);
  }

  function updatePlayPauseButton(name) {
    const record = tiles.get(name);
    if (!record) return;
    record.playPauseBtn.textContent = record.playing ? "⏸" : "▶";
    record.playPauseBtn.title = record.playing ? "Mettre en pause" : "Lancer la lecture";
  }

  function togglePlayback(name) {
    const record = tiles.get(name);
    if (!record || !record.player) return;
    try {
      if (record.playing) {
        record.player.pause();
      } else {
        record.player.play();
      }
    } catch (e) {
      /* ignore */
    }
    record.playing = !record.playing;
    updatePlayPauseButton(name);
  }

  // Sets who the (unmuted) main channel is, muting the previous one back —
  // only called on an explicit promotion, never on resize/relayout, so a
  // manual mute/unmute elsewhere is never fought over.
  function promoteMain(name) {
    const previous = state.mainChannel;
    state.mainChannel = name;
    state.muted[name] = false;
    if (previous && previous !== name) {
      state.muted[previous] = true;
      updateMuteButton(previous);
      setPlayerMuted(previous, true);
    }
    updateMuteButton(name);
    setPlayerMuted(name, false);
  }

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

  // Lays out `names` inside a box (boxX,boxY,boxW,boxH), centering the
  // whole block and centering each (possibly partial) row within it —
  // matching how a wrapping flex row with justify-content:center looks.
  function packGrid(names, boxX, boxY, boxW, boxH, positions, isMainFlag) {
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
      positions.set(name, { x, y, w, h, isMain: !!isMainFlag });
    });
  }

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  function layoutAll(overrideFrac) {
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
      packGrid(state.channels, GAP, GAP, availW, availH, positions, false);
    } else {
      const mainName = getMainName();
      const others = state.channels.filter((c) => c !== mainName);
      const isRow = availW >= availH;

      if (others.length === 0) {
        packGrid(mainName ? [mainName] : [], GAP, GAP, availW, availH, positions, true);
      } else if (isRow) {
        const frac = clamp(MIN_MAIN_FRAC, overrideFrac ?? state.focusMainFrac, MAX_MAIN_FRAC);
        const mainAreaW = availW * frac - HANDLE_SIZE / 2;
        const sidebarW = availW - mainAreaW - HANDLE_SIZE;
        packGrid([mainName], GAP, GAP, mainAreaW, availH, positions, true);
        packGrid(others, GAP + mainAreaW + HANDLE_SIZE, GAP, sidebarW, availH, positions, false);
        handleBox = { x: GAP + mainAreaW, y: GAP, w: HANDLE_SIZE, h: availH, orientation: "row" };
      } else {
        const frac = clamp(MIN_MAIN_FRAC, overrideFrac ?? state.focusMainFrac, MAX_MAIN_FRAC);
        const mainAreaH = availH * frac - HANDLE_SIZE / 2;
        const sidebarH = availH - mainAreaH - HANDLE_SIZE;
        packGrid([mainName], GAP, GAP, availW, mainAreaH, positions, true);
        packGrid(others, GAP, GAP + mainAreaH + HANDLE_SIZE, availW, sidebarH, positions, false);
        handleBox = { x: GAP, y: GAP + mainAreaH, w: availW, h: HANDLE_SIZE, orientation: "col" };
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
      // Clicking the channel name promotes a tile, except for the tile
      // that's already the interactive main video.
      const isPromotable = state.mode === "grid" || !pos.isMain;
      record.nameEl.classList.toggle("clickable", isPromotable);
      record.nameEl.title = isPromotable
        ? (state.mode === "grid" ? "Agrandir en focus" : "Passer en principal")
        : "";
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
    const isRow = el.focusHandle.classList.contains("row");
    const frac = isRow
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height;
    dragFrac = clamp(MIN_MAIN_FRAC, frac, MAX_MAIN_FRAC);
    layoutAll(dragFrac);
  });

  function endDrag() {
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

  // ---- Drag to reorder tiles ----

  let reorderSource = null;
  let reorderTarget = null;

  function startDragReorder(name, downEvent) {
    reorderSource = name;
    reorderTarget = null;
    const grip = downEvent.currentTarget;
    tiles.get(name)?.el.classList.add("drag-source");

    const onMove = (e) => {
      const el2 = document.elementFromPoint(e.clientX, e.clientY);
      const tileEl = el2 && el2.closest(".tile");
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
