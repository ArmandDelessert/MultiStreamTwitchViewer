(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const STORAGE_KEY = "twitchMultiView.state.v1";
  const MIN_CONTAINER_W = 220; // px, enforced at interaction time via the live stage size
  const MIN_CONTAINER_H = 150;

  /** @type {{containers: {id:string, channels:string[], x:number, y:number, w:number, h:number}[], muted: Record<string, boolean>, quality: string}} */
  let state = loadState();

  const el = {
    stage: document.getElementById("stage"),
    emptyState: document.getElementById("emptyState"),
    tilesLayer: document.getElementById("tilesLayer"),
    containersLayer: document.getElementById("containersLayer"),
    addForm: document.getElementById("addForm"),
    channelInput: document.getElementById("channelInput"),
    addContainerBtn: document.getElementById("addContainerBtn"),
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    twitchAccountBtn: document.getElementById("twitchAccountBtn"),
    twitchPanel: document.getElementById("twitchPanel"),
  };

  // channel -> { el, player, playing }. A tile is created once when a
  // channel first appears in any container and lives until it's removed
  // from all of them — moving between containers or resizing only ever
  // repositions these elements, never recreates the underlying Twitch
  // player/iframe.
  const tiles = new Map();
  if (location.search.includes("debug")) window.__tiles = tiles;

  // container id -> DOM handles for its chrome (grip/toolbar/resize handle).
  const containerBoxes = new Map();

  // container id -> last-laid-out pixel rect on the stage, used to hit-test
  // where a dragged tile is dropped when it's not directly over another tile.
  const containerRects = new Map();

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.containers) && parsed.containers.length) {
          const containers = parsed.containers
            .filter((c) => c && Array.isArray(c.channels))
            .map((c) => ({
              id: typeof c.id === "string" ? c.id : uid(),
              channels: c.channels.filter((ch) => typeof ch === "string"),
              x: clamp(0, Number(c.x) || 0, 0.95),
              y: clamp(0, Number(c.y) || 0, 0.95),
              w: clamp(0.05, Number(c.w) || 1, 1),
              h: clamp(0.05, Number(c.h) || 1, 1),
            }));
          return {
            containers,
            muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
            quality: typeof parsed.quality === "string" ? parsed.quality : "auto",
          };
        }
        // Migrate the older single-list shape (channels[] + zoneA/mode) into
        // one full-stage container holding everything.
        if (Array.isArray(parsed.channels)) {
          return {
            containers: parsed.channels.length
              ? [{ id: uid(), channels: parsed.channels, x: 0, y: 0, w: 1, h: 1 }]
              : [],
            muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
            quality: typeof parsed.quality === "string" ? parsed.quality : "auto",
          };
        }
      }
    } catch (e) {
      console.warn("Failed to load state", e);
    }
    return { containers: [], muted: {}, quality: "auto" };
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

  // ---- Containers ----

  function getAllChannels() {
    const out = [];
    for (const c of state.containers) out.push(...c.channels);
    return out;
  }

  function getContainer(id) {
    return state.containers.find((c) => c.id === id) || null;
  }

  function containerOf(name) {
    return state.containers.find((c) => c.channels.includes(name)) || null;
  }

  // Removes any container left with zero channels, unless that would leave
  // none at all (keep one empty container as the drop target / empty state).
  function pruneEmptyContainers() {
    const nonEmpty = state.containers.filter((c) => c.channels.length > 0);
    if (nonEmpty.length > 0) {
      for (const c of state.containers) {
        if (c.channels.length === 0) destroyContainerBox(c.id);
      }
      state.containers = nonEmpty;
    }
  }

  function defaultContainer() {
    return { id: uid(), channels: [], x: 0, y: 0, w: 1, h: 1 };
  }

  function addContainer() {
    if (state.containers.length === 0) {
      state.containers.push(defaultContainer());
      saveState();
      layoutAll();
      return;
    }

    if (state.containers.length === 1) {
      // The common case: split the one full-stage container in half,
      // side by side or stacked depending on which way the stage is wider.
      const only = state.containers[0];
      const splitVertically = only.w >= only.h;
      const half = only.channels.slice(Math.ceil(only.channels.length / 2));
      only.channels = only.channels.slice(0, Math.ceil(only.channels.length / 2));

      const next = { id: uid(), channels: half, x: 0, y: 0, w: 0, h: 0 };
      if (splitVertically) {
        next.x = only.x + only.w / 2;
        next.y = only.y;
        next.w = only.w / 2;
        next.h = only.h;
        only.w = only.w / 2;
      } else {
        next.x = only.x;
        next.y = only.y + only.h / 2;
        next.w = only.w;
        next.h = only.h / 2;
        only.h = only.h / 2;
      }
      state.containers.push(next);
    } else {
      // Take half of the largest container's channels to seed the new one,
      // and cascade its default position so it's not stacked exactly on
      // top of the others.
      const donor = state.containers.reduce((a, b) => (b.channels.length > a.channels.length ? b : a));
      const half = donor.channels.slice(Math.ceil(donor.channels.length / 2));
      donor.channels = donor.channels.slice(0, Math.ceil(donor.channels.length / 2));
      const n = state.containers.length;
      const offset = (n * 0.06) % 0.4;
      state.containers.push({
        id: uid(),
        channels: half,
        x: clamp(0, 0.08 + offset, 0.55),
        y: clamp(0, 0.08 + offset, 0.55),
        w: 0.42,
        h: 0.42,
      });
    }

    pruneEmptyContainers();
    saveState();
    layoutAll();
  }

  function removeContainer(id) {
    if (state.containers.length <= 1) return;
    const idx = state.containers.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const [removed] = state.containers.splice(idx, 1);
    const target = state.containers[0];
    target.channels.push(...removed.channels);
    destroyContainerBox(id);
    saveState();
    layoutAll();
  }

  // Moves `name` into `targetContainerId`, inserted right before
  // `beforeName` if given and already in that container, else at the end.
  function moveToContainer(name, targetContainerId, beforeName) {
    const source = containerOf(name);
    const target = getContainer(targetContainerId);
    if (!source || !target || source === target) return;
    source.channels = source.channels.filter((c) => c !== name);
    const idx = beforeName ? target.channels.indexOf(beforeName) : -1;
    if (idx !== -1) target.channels.splice(idx, 0, name);
    else target.channels.push(name);
    pruneEmptyContainers();
    saveState();
    layoutAll();
  }

  function swapChannels(list, nameA, nameB) {
    const i = list.indexOf(nameA);
    const j = list.indexOf(nameB);
    if (i !== -1 && j !== -1) {
      [list[i], list[j]] = [list[j], list[i]];
    }
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

    // Everything lives in a top overlay so nothing ever sits on top of
    // Twitch's own control bar at the bottom of the player.
    const bar = document.createElement("div");
    bar.className = "tileBar";

    const row = document.createElement("div");
    row.className = "tileBarRow";

    // Drag handle: pointer capture means dragging works even while the
    // cursor passes over other tiles' cross-origin Twitch iframes, which
    // would otherwise swallow the mouse events entirely. Dropping onto
    // another container moves the channel there.
    const gripBtn = document.createElement("button");
    gripBtn.className = "iconBtn gripBtn";
    gripBtn.textContent = "⠿";
    gripBtn.title = "Glisser pour réorganiser ou changer de conteneur";
    gripBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startDragReorder(name, e);
    });
    row.appendChild(gripBtn);

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

    const record = { el: container, player: null, playing: true };
    tiles.set(name, record);
    mountPlayer(name, mount.id, state.muted[name] !== false);
    return record;
  }

  // Creates (or re-creates) the Twitch.Player for a channel and wires up
  // the PLAY/PAUSE listeners that keep record.playing accurate.
  function mountPlayer(name, mountId, muted) {
    const record = tiles.get(name);
    if (!record) return;

    if (window.Twitch && window.Twitch.Player) {
      const player = new window.Twitch.Player(mountId, {
        width: "100%",
        height: "100%",
        channel: name,
        parent: [location.hostname || "localhost"],
        muted,
        autoplay: true,
      });
      record.player = player;
      record.playing = true;
      try {
        player.addEventListener(window.Twitch.Player.PLAY, () => {
          record.playing = true;
        });
        player.addEventListener(window.Twitch.Player.PAUSE, () => {
          record.playing = false;
        });
        if (state.quality !== "auto") {
          player.addEventListener(window.Twitch.Player.READY, () => {
            setPlayerQuality(name, state.quality);
          });
        }
      } catch (e) {
        /* ignore */
      }
    } else {
      console.warn("Twitch embed SDK not available; falling back to iframe for", name);
      const mount = document.getElementById(mountId);
      const iframe = document.createElement("iframe");
      iframe.allowFullscreen = true;
      const params = new URLSearchParams({
        channel: name,
        parent: location.hostname || "localhost",
        muted: muted ? "true" : "false",
        autoplay: "true",
      });
      iframe.src = `https://player.twitch.tv/?${params.toString()}`;
      mount.appendChild(iframe);
    }
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

  function setPlayerQuality(name, quality) {
    const record = tiles.get(name);
    if (!record) return;
    try {
      if (record.player && typeof record.player.setQuality === "function") {
        record.player.setQuality(quality);
      }
    } catch (e) {
      /* ignore */
    }
  }

  // Twitch's embed player doesn't actually resume a live channel once
  // paused via play() (confirmed via its own getPlayerState(): playback
  // stays "Idle") once a tile has ever had a CSS class toggled on it — a
  // player quirk, not something fixable from here. Kept as a best-effort
  // action; native per-tile Twitch controls remain the reliable fallback.
  function resyncToLive(name) {
    const record = tiles.get(name);
    try {
      record?.player?.seek(1e10);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- State mutations ----

  function addChannels(input) {
    const parts = input.split(",").map(normalizeChannel).filter(Boolean);
    let added = false;
    if (state.containers.length === 0) state.containers.push(defaultContainer());
    const target = state.containers[0];
    const all = getAllChannels();
    for (const name of parts) {
      if (!all.includes(name)) {
        target.channels.push(name);
        if (state.muted[name] === undefined) state.muted[name] = true;
        createTile(name);
        added = true;
      }
    }
    if (added) {
      saveState();
      layoutAll();
    }
  }

  function removeChannel(name) {
    const owner = containerOf(name);
    if (owner) owner.channels = owner.channels.filter((c) => c !== name);
    delete state.muted[name];
    destroyTile(name);
    pruneEmptyContainers();
    saveState();
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
  // justify-content:center looks.
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
      positions.set(name, { x, y, w, h });
    });
  }

  function layoutAll() {
    const hasChannels = getAllChannels().length > 0;
    el.emptyState.style.display = hasChannels ? "none" : "flex";
    if (!hasChannels) {
      for (const id of [...containerBoxes.keys()]) destroyContainerBox(id);
      return;
    }

    const rect = el.stage.getBoundingClientRect();
    const stageW = rect.width;
    const stageH = rect.height;
    const positions = new Map();

    syncContainerBoxes();

    state.containers.forEach((c, index) => {
      const px = { x: c.x * stageW, y: c.y * stageH, w: c.w * stageW, h: c.h * stageH };
      containerRects.set(c.id, px);
      packGrid(c.channels, px.x + GAP, px.y + GAP, px.w - GAP * 2, px.h - GAP * 2, positions);
      renderContainerBox(c, px, index);
    });

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
    }
  }

  // ---- Container chrome (box, grip, toolbar, resize handle) ----

  function syncContainerBoxes() {
    const liveIds = new Set(state.containers.map((c) => c.id));
    for (const id of [...containerBoxes.keys()]) {
      if (!liveIds.has(id)) destroyContainerBox(id);
    }
    for (const c of state.containers) {
      if (!containerBoxes.has(c.id)) createContainerBox(c);
    }
  }

  function destroyContainerBox(id) {
    const box = containerBoxes.get(id);
    if (box) box.el.remove();
    containerBoxes.delete(id);
    containerRects.delete(id);
  }

  function allPlayingInContainer(c) {
    if (c.channels.length === 0) return true;
    return c.channels.every((name) => tiles.get(name)?.playing);
  }

  function createContainerBox(c) {
    const box = document.createElement("div");
    box.className = "containerBox";
    box.dataset.containerId = c.id;

    const chrome = document.createElement("div");
    chrome.className = "containerChrome";

    const gripBtn = document.createElement("button");
    gripBtn.className = "containerGripBtn";
    gripBtn.textContent = "⠿";
    gripBtn.title = "Glisser pour déplacer ce conteneur";
    gripBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startDragContainer(c.id, e);
    });
    chrome.appendChild(gripBtn);

    const extra = document.createElement("div");
    extra.className = "containerToolbarExtra";

    const pauseBtn = document.createElement("button");
    pauseBtn.className = "iconBtn";
    extra.appendChild(pauseBtn);

    const muteBtn = document.createElement("button");
    muteBtn.className = "iconBtn";
    muteBtn.textContent = "🔇";
    muteBtn.title = "Couper le son de ce conteneur";
    muteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const container = getContainer(c.id);
      if (!container) return;
      for (const name of container.channels) {
        state.muted[name] = true;
        setPlayerMuted(name, true);
      }
      saveState();
    });
    extra.appendChild(muteBtn);

    const resyncBtn = document.createElement("button");
    resyncBtn.className = "iconBtn";
    resyncBtn.textContent = "⏩";
    resyncBtn.title = "Rattraper le direct sur ce conteneur";
    resyncBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const container = getContainer(c.id);
      if (!container) return;
      for (const name of container.channels) resyncToLive(name);
    });
    extra.appendChild(resyncBtn);

    const qualitySelect = document.createElement("select");
    qualitySelect.title = "Qualité vidéo pour ce conteneur";
    [
      ["auto", "Auto"],
      ["1080p60", "1080p60"],
      ["720p60", "720p60"],
      ["480p30", "480p30"],
      ["360p30", "360p30"],
      ["160p30", "160p30"],
    ].forEach(([value, label]) => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      qualitySelect.appendChild(opt);
    });
    qualitySelect.addEventListener("click", (e) => e.stopPropagation());
    qualitySelect.addEventListener("change", () => {
      const container = getContainer(c.id);
      if (!container) return;
      for (const name of container.channels) setPlayerQuality(name, qualitySelect.value);
    });
    extra.appendChild(qualitySelect);

    const removeBtn = document.createElement("button");
    removeBtn.className = "iconBtn danger";
    removeBtn.textContent = "✕";
    removeBtn.title = "Fermer ce conteneur (les vidéos rejoignent un autre conteneur)";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeContainer(c.id);
    });
    extra.appendChild(removeBtn);

    chrome.appendChild(extra);
    box.appendChild(chrome);

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "containerResizeHandle";
    resizeHandle.title = "Glisser pour redimensionner";
    resizeHandle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startResizeContainer(c.id, e);
    });
    box.appendChild(resizeHandle);

    el.containersLayer.appendChild(box);
    containerBoxes.set(c.id, { el: box, pauseBtn, muteBtn, removeBtn });
  }

  function renderContainerBox(c, px, index) {
    const box = containerBoxes.get(c.id);
    if (!box) return;
    box.el.style.left = `${Math.round(px.x)}px`;
    box.el.style.top = `${Math.round(px.y)}px`;
    box.el.style.width = `${Math.round(px.w)}px`;
    box.el.style.height = `${Math.round(px.h)}px`;
    box.el.style.zIndex = String(10 + index);

    const playing = allPlayingInContainer(c);
    box.pauseBtn.textContent = playing ? "⏸" : "▶";
    box.pauseBtn.title = playing ? "Mettre ce conteneur en pause" : "Lancer la lecture de ce conteneur";
    box.pauseBtn.onclick = (e) => {
      e.stopPropagation();
      const container = getContainer(c.id);
      if (!container) return;
      const shouldPause = allPlayingInContainer(container);
      for (const name of container.channels) {
        const record = tiles.get(name);
        if (!record) continue;
        try {
          if (shouldPause) record.player?.pause();
          else record.player?.play();
        } catch (e2) {
          /* ignore */
        }
        record.playing = !shouldPause;
      }
      renderContainerBox(container, containerRects.get(container.id), state.containers.indexOf(container));
    };

    box.removeBtn.classList.toggle("hidden", state.containers.length <= 1);
  }

  // ---- Drag to move / resize a container ----

  function bringContainerToFront(id) {
    const idx = state.containers.findIndex((c) => c.id === id);
    if (idx === -1 || idx === state.containers.length - 1) return;
    const [c] = state.containers.splice(idx, 1);
    state.containers.push(c);
  }

  function startDragContainer(id, downEvent) {
    const grip = downEvent.currentTarget;
    const c = getContainer(id);
    if (!c) return;
    bringContainerToFront(id);
    saveState();
    layoutAll();

    const box = containerBoxes.get(id);
    box?.el.classList.add("dragging");

    const rect = el.stage.getBoundingClientRect();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const startFracX = c.x;
    const startFracY = c.y;

    const onMove = (e) => {
      const container = getContainer(id);
      if (!container) return;
      const dx = (e.clientX - startX) / rect.width;
      const dy = (e.clientY - startY) / rect.height;
      container.x = clamp(0, startFracX + dx, 1 - container.w);
      container.y = clamp(0, startFracY + dy, 1 - container.h);
      layoutAll();
    };

    const onUp = () => {
      try {
        grip.releasePointerCapture(downEvent.pointerId);
      } catch (e) {
        /* ignore */
      }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      box?.el.classList.remove("dragging");
      saveState();
    };

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    try {
      grip.setPointerCapture(downEvent.pointerId);
    } catch (e) {
      /* ignore — listeners above still work without capture */
    }
  }

  function startResizeContainer(id, downEvent) {
    const handle = downEvent.currentTarget;
    const c = getContainer(id);
    if (!c) return;
    bringContainerToFront(id);
    saveState();

    const box = containerBoxes.get(id);
    box?.el.classList.add("resizing");

    const rect = el.stage.getBoundingClientRect();
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const startW = c.w;
    const startH = c.h;
    const minWFrac = MIN_CONTAINER_W / rect.width;
    const minHFrac = MIN_CONTAINER_H / rect.height;

    const onMove = (e) => {
      const container = getContainer(id);
      if (!container) return;
      const dw = (e.clientX - startX) / rect.width;
      const dh = (e.clientY - startY) / rect.height;
      container.w = clamp(minWFrac, startW + dw, 1 - container.x);
      container.h = clamp(minHFrac, startH + dh, 1 - container.y);
      layoutAll();
    };

    const onUp = () => {
      try {
        handle.releasePointerCapture(downEvent.pointerId);
      } catch (e) {
        /* ignore */
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      box?.el.classList.remove("resizing");
      saveState();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    try {
      handle.setPointerCapture(downEvent.pointerId);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- Drag to reorder tiles / move them between containers ----

  let reorderSource = null;
  let reorderTarget = null;
  let reorderHoverContainer = null;

  function containerFromPoint(clientX, clientY) {
    const rect = el.stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let found = null;
    for (const c of state.containers) {
      const px = containerRects.get(c.id);
      if (!px) continue;
      if (x >= px.x && x <= px.x + px.w && y >= px.y && y <= px.y + px.h) found = c.id;
    }
    return found;
  }

  function startDragReorder(name, downEvent) {
    reorderSource = name;
    reorderTarget = null;
    reorderHoverContainer = null;
    const grip = downEvent.currentTarget;
    tiles.get(name)?.el.classList.add("drag-source");

    const onMove = (e) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const tileEl = hit && hit.closest(".tile");
      const targetName = tileEl && tileEl.dataset.channel !== reorderSource ? tileEl.dataset.channel : null;
      if (targetName !== reorderTarget) {
        if (reorderTarget) tiles.get(reorderTarget)?.el.classList.remove("drag-target");
        reorderTarget = targetName;
        if (reorderTarget) tiles.get(reorderTarget)?.el.classList.add("drag-target");
      }
      const owner = reorderTarget ? containerOf(reorderTarget) : null;
      reorderHoverContainer = owner ? owner.id : containerFromPoint(e.clientX, e.clientY);
    };

    const onUp = () => {
      try {
        grip.releasePointerCapture(downEvent.pointerId);
      } catch (e) {
        /* ignore */
      }
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      tiles.get(reorderSource)?.el.classList.remove("drag-source");
      if (reorderTarget) tiles.get(reorderTarget)?.el.classList.remove("drag-target");

      const sourceContainer = containerOf(reorderSource);
      if (sourceContainer && reorderHoverContainer === sourceContainer.id) {
        if (reorderTarget) {
          swapChannels(sourceContainer.channels, reorderSource, reorderTarget);
          saveState();
          layoutAll();
        }
      } else if (reorderHoverContainer) {
        moveToContainer(reorderSource, reorderHoverContainer, reorderTarget);
      }

      reorderSource = null;
      reorderTarget = null;
      reorderHoverContainer = null;
    };

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
    try {
      grip.setPointerCapture(downEvent.pointerId);
    } catch (e) {
      /* ignore — listeners above still work without capture */
    }
  }

  // ---- Twitch account (OAuth) ----
  //
  // Implicit Grant flow: this is a static, backend-less page, so there's no
  // way to keep a client secret. The standard client-side approach is to
  // redirect to Twitch, get an access token back in the URL fragment, and
  // call the Helix API directly from the browser (Twitch's Helix endpoints
  // support CORS for this exact flow). The token can't be silently
  // refreshed this way — it just expires after a few hours and the user
  // reconnects.

  const TWITCH_CLIENT_ID_KEY = "twitchMultiView.twitchClientId";
  const TWITCH_TOKEN_KEY = "twitchMultiView.twitchToken";
  const TWITCH_OAUTH_STATE_KEY = "twitchMultiView.twitchOAuthState";
  const TWITCH_SCOPE = "user:read:follows";

  let twitchLiveFollowed = null; // null = not fetched yet this session
  let twitchLoading = false;
  let twitchError = null;

  function getRedirectUri() {
    return location.origin + location.pathname;
  }

  function getClientId() {
    return localStorage.getItem(TWITCH_CLIENT_ID_KEY) || "";
  }

  function getTwitchToken() {
    try {
      const raw = localStorage.getItem(TWITCH_TOKEN_KEY);
      if (!raw) return null;
      const token = JSON.parse(raw);
      if (!token.access_token || !token.obtained_at || !token.expires_in) return null;
      if (Date.now() > token.obtained_at + token.expires_in * 1000) {
        localStorage.removeItem(TWITCH_TOKEN_KEY);
        return null;
      }
      return token;
    } catch (e) {
      return null;
    }
  }

  function disconnectTwitch() {
    localStorage.removeItem(TWITCH_TOKEN_KEY);
    twitchLiveFollowed = null;
    twitchError = null;
    renderTwitchPanel();
  }

  function startTwitchLogin() {
    const clientId = getClientId();
    if (!clientId) return;
    const state2 = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(TWITCH_OAUTH_STATE_KEY, state2);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getRedirectUri(),
      response_type: "token",
      scope: TWITCH_SCOPE,
      state: state2,
    });
    location.href = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  // Runs once at startup: if we've just been bounced back from Twitch's
  // authorize page, the access token is sitting in the URL fragment.
  // Returns true if a token was just obtained this way.
  function consumeOAuthRedirect() {
    if (!location.hash || !location.hash.includes("access_token")) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get("access_token");
    const expiresIn = Number(params.get("expires_in"));
    const returnedState = params.get("state");
    const expectedState = sessionStorage.getItem(TWITCH_OAUTH_STATE_KEY);
    sessionStorage.removeItem(TWITCH_OAUTH_STATE_KEY);
    history.replaceState(null, "", location.pathname + location.search);
    if (!accessToken || !expectedState || returnedState !== expectedState) return false;
    localStorage.setItem(
      TWITCH_TOKEN_KEY,
      JSON.stringify({ access_token: accessToken, expires_in: expiresIn || 14400, obtained_at: Date.now() })
    );
    return true;
  }

  async function twitchApiFetch(url) {
    const token = getTwitchToken();
    const clientId = getClientId();
    if (!token || !clientId) throw new Error("not-connected");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}`, "Client-Id": clientId },
    });
    if (res.status === 401) {
      disconnectTwitch();
      throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(`Twitch API error ${res.status}`);
    return res.json();
  }

  async function fetchTwitchUser() {
    const data = await twitchApiFetch("https://api.twitch.tv/helix/users");
    return data.data && data.data[0];
  }

  async function fetchFollowedBroadcasters(userId) {
    const broadcasters = [];
    let cursor = "";
    do {
      const params = new URLSearchParams({ user_id: userId, first: "100" });
      if (cursor) params.set("after", cursor);
      const data = await twitchApiFetch(`https://api.twitch.tv/helix/channels/followed?${params.toString()}`);
      for (const item of data.data || []) {
        broadcasters.push(item.broadcaster_id);
      }
      cursor = data.pagination && data.pagination.cursor;
    } while (cursor);
    return broadcasters;
  }

  async function fetchLiveStreams(broadcasterIds) {
    const live = [];
    for (let i = 0; i < broadcasterIds.length; i += 100) {
      const chunk = broadcasterIds.slice(i, i + 100);
      const params = new URLSearchParams();
      params.set("first", "100");
      for (const id of chunk) params.append("user_id", id);
      const data = await twitchApiFetch(`https://api.twitch.tv/helix/streams?${params.toString()}`);
      for (const item of data.data || []) {
        live.push({
          login: item.user_login,
          name: item.user_name,
          gameName: item.game_name,
          viewerCount: item.viewer_count,
        });
      }
    }
    live.sort((a, b) => b.viewerCount - a.viewerCount);
    return live;
  }

  async function refreshFollowedLive() {
    twitchLoading = true;
    twitchError = null;
    renderTwitchPanel();
    try {
      const user = await fetchTwitchUser();
      const followedIds = await fetchFollowedBroadcasters(user.id);
      twitchLiveFollowed = await fetchLiveStreams(followedIds);
    } catch (e) {
      twitchError = "Impossible de récupérer vos chaînes suivies.";
      console.warn(e);
    }
    twitchLoading = false;
    renderTwitchPanel();
  }

  function renderTwitchPanel() {
    const panel = el.twitchPanel;
    panel.innerHTML = "";
    const clientId = getClientId();
    const token = getTwitchToken();

    if (!clientId) {
      const h = document.createElement("h3");
      h.textContent = "Connecter Twitch";
      panel.appendChild(h);

      const p = document.createElement("p");
      p.innerHTML =
        "Créez une application gratuite sur <strong>dev.twitch.tv/console/apps</strong> " +
        "(bouton « Register Your Application »), avec cette URL de redirection exacte :";
      panel.appendChild(p);

      const redirectInput = document.createElement("input");
      redirectInput.type = "text";
      redirectInput.readOnly = true;
      redirectInput.value = getRedirectUri();
      redirectInput.addEventListener("click", () => redirectInput.select());
      panel.appendChild(redirectInput);

      const p2 = document.createElement("p");
      p2.textContent = "Puis collez ici le « Client ID » généré :";
      panel.appendChild(p2);

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.placeholder = "Client ID Twitch";
      panel.appendChild(idInput);

      const saveBtn = document.createElement("button");
      saveBtn.className = "primaryBtn";
      saveBtn.textContent = "Enregistrer";
      saveBtn.addEventListener("click", () => {
        const val = idInput.value.trim();
        if (val) {
          localStorage.setItem(TWITCH_CLIENT_ID_KEY, val);
          renderTwitchPanel();
        }
      });
      panel.appendChild(saveBtn);
      return;
    }

    if (!token) {
      const h = document.createElement("h3");
      h.textContent = "Connecter Twitch";
      panel.appendChild(h);

      const p = document.createElement("p");
      p.textContent = "Connectez-vous pour voir vos chaînes suivies actuellement en direct.";
      panel.appendChild(p);

      const loginBtn = document.createElement("button");
      loginBtn.className = "primaryBtn";
      loginBtn.textContent = "Se connecter à Twitch";
      loginBtn.addEventListener("click", startTwitchLogin);
      panel.appendChild(loginBtn);

      const forget = document.createElement("button");
      forget.className = "linkBtn";
      forget.textContent = "Changer de Client ID";
      forget.addEventListener("click", () => {
        localStorage.removeItem(TWITCH_CLIENT_ID_KEY);
        renderTwitchPanel();
      });
      panel.appendChild(forget);
      return;
    }

    const row = document.createElement("div");
    row.className = "twitchAccountRow";
    const status = document.createElement("span");
    status.textContent = twitchLoading ? "Chargement…" : "Connecté";
    row.appendChild(status);
    const disconnectBtn = document.createElement("button");
    disconnectBtn.className = "linkBtn";
    disconnectBtn.textContent = "Se déconnecter";
    disconnectBtn.addEventListener("click", disconnectTwitch);
    row.appendChild(disconnectBtn);
    panel.appendChild(row);

    const refreshBtn = document.createElement("button");
    refreshBtn.className = "primaryBtn";
    refreshBtn.textContent = twitchLoading ? "Chargement…" : "🔄 Actualiser les chaînes en direct";
    refreshBtn.disabled = twitchLoading;
    refreshBtn.addEventListener("click", refreshFollowedLive);
    panel.appendChild(refreshBtn);

    if (twitchError) {
      const err = document.createElement("p");
      err.textContent = twitchError;
      panel.appendChild(err);
    }

    if (twitchLiveFollowed) {
      const h = document.createElement("h3");
      h.style.marginTop = "12px";
      h.textContent = twitchLiveFollowed.length
        ? `${twitchLiveFollowed.length} chaîne(s) suivie(s) en direct`
        : "Aucune chaîne suivie n'est en direct";
      panel.appendChild(h);

      const list = document.createElement("ul");
      list.className = "twitchLiveList";
      for (const stream of twitchLiveFollowed) {
        const li = document.createElement("li");
        li.className = "twitchLiveItem";

        const dot = document.createElement("span");
        dot.className = "liveDot";
        li.appendChild(dot);

        const info = document.createElement("div");
        info.className = "liveInfo";
        const nameEl = document.createElement("div");
        nameEl.className = "liveName";
        nameEl.textContent = stream.name;
        info.appendChild(nameEl);
        const meta = document.createElement("div");
        meta.className = "liveMeta";
        meta.textContent = `${stream.gameName || "?"} · ${stream.viewerCount.toLocaleString("fr-FR")} viewers`;
        info.appendChild(meta);
        li.appendChild(info);

        const already = getAllChannels().includes(stream.login);
        const addBtn = document.createElement("button");
        addBtn.textContent = already ? "✓" : "+";
        addBtn.disabled = already;
        addBtn.title = already ? "Déjà ajoutée" : "Ajouter cette chaîne";
        addBtn.addEventListener("click", () => {
          addChannels(stream.login);
          renderTwitchPanel();
        });
        li.appendChild(addBtn);

        list.appendChild(li);
      }
      panel.appendChild(list);
    }
  }

  function positionTwitchPanel() {
    const rect = el.twitchAccountBtn.getBoundingClientRect();
    const width = 320;
    el.twitchPanel.style.top = `${Math.round(rect.bottom + 8)}px`;
    el.twitchPanel.style.left = `${Math.round(clamp(8, rect.right - width, window.innerWidth - width - 8))}px`;
  }

  el.twitchAccountBtn.addEventListener("click", () => {
    el.twitchPanel.classList.toggle("hidden");
    if (!el.twitchPanel.classList.contains("hidden")) {
      positionTwitchPanel();
      renderTwitchPanel();
    }
  });

  document.addEventListener("click", (e) => {
    if (
      !el.twitchPanel.classList.contains("hidden") &&
      !el.twitchPanel.contains(e.target) &&
      e.target !== el.twitchAccountBtn
    ) {
      el.twitchPanel.classList.add("hidden");
    }
  });

  // ---- Wiring ----

  el.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = el.channelInput.value;
    if (val.trim()) {
      addChannels(val);
      el.channelInput.value = "";
    }
  });

  el.addContainerBtn.addEventListener("click", addContainer);

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

  const justConnectedToTwitch = consumeOAuthRedirect();
  if (justConnectedToTwitch) {
    el.twitchPanel.classList.remove("hidden");
    positionTwitchPanel();
    renderTwitchPanel();
    refreshFollowedLive();
  }

  // ---- Init ----

  function init() {
    for (const c of state.containers) {
      for (const name of c.channels) createTile(name);
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
