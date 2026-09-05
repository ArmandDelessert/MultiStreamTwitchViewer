(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const HANDLE_SIZE = 8;
  const MIN_OTHER_SIDE = 20; // never let a split notch fully starve the other zone
  const STORAGE_KEY = "twitchMultiView.state.v1";

  /** @type {{channels: string[], mode: "grid"|"split", zoneA: string[], muted: Record<string, boolean>, splitNotch: {side: "a"|"b", lines: number}}} */
  let state = loadState();

  const el = {
    stage: document.getElementById("stage"),
    emptyState: document.getElementById("emptyState"),
    tilesLayer: document.getElementById("tilesLayer"),
    focusHandle: document.getElementById("focusHandle"),
    addForm: document.getElementById("addForm"),
    channelInput: document.getElementById("channelInput"),
    splitToggleBtn: document.getElementById("splitToggleBtn"),
    swapZonesBtn: document.getElementById("swapZonesBtn"),
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    pauseAllBtn: document.getElementById("pauseAllBtn"),
    muteAllBtn: document.getElementById("muteAllBtn"),
    resyncAllBtn: document.getElementById("resyncAllBtn"),
    qualitySelect: document.getElementById("qualitySelect"),
    twitchAccountBtn: document.getElementById("twitchAccountBtn"),
    twitchPanel: document.getElementById("twitchPanel"),
    toolbar: document.getElementById("toolbar"),
  };

  // channel -> { el, player, playing, promoteBtn }. A tile is created once
  // when a channel is added and lives until it's removed — switching modes
  // or resizing only ever repositions these elements, never recreates the
  // underlying Twitch player/iframe.
  const tiles = new Map();
  if (location.search.includes("debug")) window.__tiles = tiles;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const mode = parsed.mode === "focus" || parsed.mode === "split" ? "split" : "grid";
        let zoneA;
        if (Array.isArray(parsed.zoneA)) zoneA = parsed.zoneA;
        else if (parsed.mainChannel) zoneA = [parsed.mainChannel];
        else zoneA = [];
        let splitNotch;
        if (parsed.splitNotch && typeof parsed.splitNotch.lines === "number") {
          splitNotch = { side: parsed.splitNotch.side === "b" ? "b" : "a", lines: parsed.splitNotch.lines };
        } else if (Number.isInteger(parsed.focusLayoutOption)) {
          splitNotch =
            parsed.focusLayoutOption === 0
              ? { side: "a", lines: 1 }
              : { side: "b", lines: parsed.focusLayoutOption };
        } else {
          splitNotch = { side: "a", lines: 1 };
        }
        return {
          channels: Array.isArray(parsed.channels) ? parsed.channels : [],
          mode,
          zoneA,
          muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
          splitNotch,
          quality: typeof parsed.quality === "string" ? parsed.quality : "auto",
        };
      }
    } catch (e) {
      console.warn("Failed to load state", e);
    }
    return { channels: [], mode: "grid", zoneA: [], muted: {}, splitNotch: { side: "a", lines: 1 }, quality: "auto" };
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

  // ---- Split-mode zones ----
  //
  // Zone A is the only bit of state we keep explicitly; zone B is simply
  // "every other channel", in their relative order within state.channels —
  // so reordering within B reuses the exact same array-swap as grid mode.

  function getZones() {
    const a = state.zoneA.filter((c) => state.channels.includes(c));
    const aSet = new Set(a);
    const b = state.channels.filter((c) => !aSet.has(c));
    return { a, b };
  }

  function zoneOf(name) {
    return state.zoneA.includes(name) ? "a" : "b";
  }

  // Keeps zone A sane after channels are added/removed: never empty (when
  // there's at least one channel) and never *every* channel (so a divider
  // always has something on both sides) unless there's only one channel.
  function ensureValidZoneA() {
    state.zoneA = state.zoneA.filter((c) => state.channels.includes(c));
    if (state.zoneA.length === 0 && state.channels.length > 0) {
      state.zoneA = [state.channels[0]];
    }
    if (state.zoneA.length === state.channels.length && state.channels.length > 1) {
      state.zoneA = state.zoneA.slice(0, -1);
    }
  }

  // A zone with exactly one channel is shown large with a "PRINCIPAL" badge
  // and — because of a Twitch player quirk (see promoteAudio comment below
  // and updatePauseAllButton) — is left out of the global play/pause action.
  function getSoloName() {
    if (state.mode !== "split") return null;
    const { a, b } = getZones();
    if (a.length === 1) return a[0];
    if (b.length === 1) return b[0];
    return null;
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
    // would otherwise swallow the mouse events entirely. In split mode,
    // dragging onto the other zone moves the channel there.
    const gripBtn = document.createElement("button");
    gripBtn.className = "iconBtn gripBtn";
    gripBtn.textContent = "⠿";
    gripBtn.title = "Glisser pour réorganiser ou changer de zone";
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
        switchToSplitSolo(name);
      } else if (!(state.zoneA.length === 1 && state.zoneA[0] === name)) {
        setZoneASolo(name);
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
    mountPlayer(name, mount.id, state.muted[name] !== false);

    updatePauseAllButton();
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
          updatePauseAllButton();
        });
        player.addEventListener(window.Twitch.Player.PAUSE, () => {
          record.playing = false;
          updatePauseAllButton();
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

  // Nudges a live stream back to the live edge to claw back accumulated
  // buffering delay — the same idea as browser extensions with a "fast
  // forward buffer" button, but done through Twitch's embed API instead of
  // reaching into the player's own <video> element (which we can't do:
  // player.twitch.tv is a cross-origin iframe, even though it's Twitch's
  // own domain). Seeking past the end of the seekable range is how HTML5
  // live players commonly expose "jump to live". Applied to every stream
  // at once from the toolbar button.
  function resyncAllToLive() {
    for (const record of tiles.values()) {
      try {
        record.player?.seek(1e10);
      } catch (e) {
        /* ignore */
      }
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

  // Muting/unmuting is otherwise fully manual (each tile's own Twitch
  // controls) — this one-off nudge just gives a freshly-made solo video a
  // sensible default (it plays, everything else goes quiet) instead of
  // starting silent with no obvious way to fix it.
  function promoteAudio(name) {
    for (const other of state.channels) {
      if (other !== name && state.muted[other] !== true) {
        state.muted[other] = true;
        setPlayerMuted(other, true);
      }
    }
    state.muted[name] = false;
    setPlayerMuted(name, false);
  }

  // ---- Global controls (toolbar) ----

  // Twitch's embed player can't reliably resume a paused stream via play()
  // once *any* CSS class/style change has ever touched its tile — verified
  // directly against getPlayerState() (playback gets stuck on "Idle").
  // Since becoming a solo zone's tile always applies the "is-main" class
  // (for the badge), that one tile is structurally the one this can't fix;
  // it's left out of the global controls — its own Twitch controls still
  // work fine since a real click is a genuine user gesture inside the iframe.
  function nonSoloTiles() {
    const soloName = getSoloName();
    return [...tiles.entries()].filter(([name]) => name !== soloName);
  }

  function allPlaying() {
    const list = nonSoloTiles();
    return list.every(([, record]) => record.playing);
  }

  function updatePauseAllButton() {
    const list = nonSoloTiles();
    if (list.length === 0) {
      // Nothing left to control (e.g. a single channel, or every channel
      // is the solo one) — use its own Twitch controls directly instead.
      el.pauseAllBtn.disabled = true;
      el.pauseAllBtn.textContent = "⏸ Tout mettre en pause";
      el.pauseAllBtn.title = "Utilisez les contrôles de la vidéo principale";
      return;
    }
    el.pauseAllBtn.disabled = false;
    // "Tout lancer" as soon as a single (controllable) stream is paused —
    // pausing everything is only offered once nothing is left to resume.
    const playing = list.every(([, record]) => record.playing);
    el.pauseAllBtn.textContent = playing ? "⏸ Tout mettre en pause" : "▶ Tout lancer";
    el.pauseAllBtn.title = playing
      ? "Mettre tous les streams en pause"
      : "Lancer la lecture de tous les streams";
  }

  el.pauseAllBtn.addEventListener("click", () => {
    const shouldPause = allPlaying();
    for (const [, record] of nonSoloTiles()) {
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

  el.resyncAllBtn.addEventListener("click", resyncAllToLive);

  el.qualitySelect.addEventListener("change", () => {
    state.quality = el.qualitySelect.value;
    saveState();
    for (const name of state.channels) {
      setPlayerQuality(name, state.quality);
    }
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
      if (state.mode === "split") ensureValidZoneA();
      saveState();
      layoutAll();
      updatePauseAllButton();
    }
  }

  function removeChannel(name) {
    state.channels = state.channels.filter((c) => c !== name);
    state.zoneA = state.zoneA.filter((c) => c !== name);
    delete state.muted[name];
    destroyTile(name);
    if (state.mode === "split") ensureValidZoneA();
    saveState();
    layoutAll();
    updatePauseAllButton();
  }

  function updateModeButtons() {
    const isSplit = state.mode === "split";
    el.splitToggleBtn.textContent = isSplit ? "⊟ Retirer la séparation" : "⊞ Ajouter une séparation";
    el.splitToggleBtn.title = isSplit
      ? "Revenir à une grille simple"
      : "Créer deux zones séparées par une poignée";
    el.swapZonesBtn.classList.toggle("hidden", !isSplit);
  }

  function toggleSplit() {
    if (state.mode === "split") {
      state.mode = "grid";
    } else {
      state.mode = "split";
      ensureValidZoneA();
    }
    saveState();
    updateModeButtons();
    layoutAll();
    updatePauseAllButton();
  }

  // Moves every channel to the opposite side: whatever was in zone B
  // becomes zone A and vice versa (zone B is always just "the rest", so
  // nothing needs to change there explicitly).
  function swapZones() {
    if (state.mode !== "split") return;
    state.zoneA = getZones().b;
    saveState();
    layoutAll();
    updatePauseAllButton();
  }

  // Makes `name` the sole member of zone A (everyone else ends up in zone
  // B) and gives it the sensible "it plays, everything else is quiet"
  // audio default. Used by the star button as a one-click shortcut —
  // fine-grained zone membership is still done by dragging tiles around.
  function setZoneASolo(name) {
    state.zoneA = [name];
    promoteAudio(name);
    saveState();
    layoutAll();
    updatePauseAllButton();
  }

  function switchToSplitSolo(name) {
    state.mode = "split";
    state.zoneA = [name];
    promoteAudio(name);
    saveState();
    updateModeButtons();
    layoutAll();
    updatePauseAllButton();
  }

  // Moves `name` into `targetZone` ("a" or "b"), inserted right before
  // `beforeName` if that's given and already in the target zone, else at
  // the end.
  function moveToZone(name, targetZone, beforeName) {
    state.zoneA = state.zoneA.filter((c) => c !== name);
    if (targetZone === "a") {
      const idx = beforeName ? state.zoneA.indexOf(beforeName) : -1;
      if (idx !== -1) state.zoneA.splice(idx, 0, name);
      else state.zoneA.push(name);
    }
    saveState();
    layoutAll();
    updatePauseAllButton();
  }

  function swapChannels(list, nameA, nameB) {
    const i = list.indexOf(nameA);
    const j = list.indexOf(nameB);
    if (i !== -1 && j !== -1) {
      [list[i], list[j]] = [list[j], list[i]];
    }
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
  // justify-content:center looks. Used for grid mode and for whichever
  // split zone isn't the one with a forced line count.
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

  // Lays out `names` in exactly `lines` columns (row orientation) or rows
  // (column orientation), each filling the full cross-axis length — used
  // for whichever split zone the user pinned to a specific line count.
  function packForcedLines(names, boxX, boxY, crossLength, lines, isRow, positions) {
    const n = names.length;
    if (isRow) {
      const cols = lines;
      const rows = Math.ceil(n / cols);
      const tileH = (crossLength - (rows - 1) * GAP) / rows;
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
    } else {
      const rows = lines;
      const cols = Math.ceil(n / rows);
      const tileW = (crossLength - (cols - 1) * GAP) / cols;
      const tileH = tileW / RATIO;
      names.forEach((name, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        const itemsInRow = Math.min(cols, n - row * cols);
        const rowW = itemsInRow * tileW + (itemsInRow - 1) * GAP;
        const rowOffsetX = boxX + (crossLength - rowW) / 2;
        const x = rowOffsetX + col * (tileW + GAP);
        const y = boxY + row * (tileH + GAP);
        positions.set(name, { x, y, w: tileW, h: tileH, isMain: false });
      });
    }
  }

  // The along-axis size that `count` items forced into `lines` lines
  // (filling the full cross-axis) end up occupying.
  function computeForcedSize(count, lines, availW, availH, isRow) {
    if (isRow) {
      const rows = Math.ceil(count / lines);
      const tileH = (availH - (rows - 1) * GAP) / rows;
      const tileW = tileH * RATIO;
      return lines * tileW + (lines - 1) * GAP;
    }
    const cols = Math.ceil(count / lines);
    const tileW = (availW - (cols - 1) * GAP) / cols;
    const tileH = tileW / RATIO;
    return lines * tileH + (lines - 1) * GAP;
  }

  // The only layouts where either zone is truly maximized: zone A forced
  // into 1..aCount lines (zone B gets whatever's left, best-packed), or
  // symmetrically zone B forced into 1..bCount lines. Anything in between
  // wastes space on one side, so those are the only notches the divider
  // can rest on. Each notch records zone A's resulting along-axis size,
  // used both to render it and to find the notch closest to the pointer.
  function computeSplitNotches(aCount, bCount, availW, availH, isRow) {
    const availAxis = isRow ? availW : availH;
    const notches = [];
    for (let lines = 1; lines <= aCount; lines++) {
      const size = computeForcedSize(aCount, lines, availW, availH, isRow);
      notches.push({ side: "a", lines, aSize: clamp(20, size, availAxis - HANDLE_SIZE - MIN_OTHER_SIDE) });
    }
    for (let lines = 1; lines <= bCount; lines++) {
      const bSize = computeForcedSize(bCount, lines, availW, availH, isRow);
      const aSize = clamp(MIN_OTHER_SIDE, availAxis - bSize - HANDLE_SIZE, availAxis - HANDLE_SIZE - 20);
      notches.push({ side: "b", lines, aSize });
    }
    return notches;
  }

  function resolveNotch(stored, notches) {
    if (stored) {
      const exact = notches.find((n) => n.side === stored.side && n.lines === stored.lines);
      if (exact) return exact;
      const sameSide = notches.filter((n) => n.side === stored.side);
      if (sameSide.length) {
        const maxLines = Math.max(...sameSide.map((n) => n.lines));
        const clampedLines = clamp(1, stored.lines, maxLines);
        const found = sameSide.find((n) => n.lines === clampedLines);
        if (found) return found;
      }
    }
    return notches[0];
  }

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Geometry from the last layout, used by the tile-drag code to figure
  // out which zone the pointer is over even when it's not on top of a tile
  // (e.g. dropped on empty space within a zone).
  let lastSplitGeometry = null;

  function layoutAll(overrideNotch) {
    const hasChannels = state.channels.length > 0;
    el.emptyState.style.display = hasChannels ? "none" : "flex";
    if (!hasChannels) {
      el.focusHandle.classList.remove("visible");
      lastSplitGeometry = null;
      return;
    }

    const rect = el.stage.getBoundingClientRect();
    const availW = rect.width - GAP * 2;
    const availH = rect.height - GAP * 2;
    const positions = new Map();
    let handleBox = null;
    lastSplitGeometry = null;

    if (state.mode === "grid") {
      packGrid(state.channels, GAP, GAP, availW, availH, positions);
    } else {
      // Note: zone A is *not* auto-repaired here — the user may have
      // deliberately dragged every tile to one side, which should render
      // as a plain grid (below) rather than being silently undone.
      const { a, b } = getZones();
      const isRow = availW >= availH;

      if (a.length === 0 || b.length === 0) {
        packGrid(state.channels, GAP, GAP, availW, availH, positions);
      } else {
        const notches = computeSplitNotches(a.length, b.length, availW, availH, isRow);
        const chosen = resolveNotch(overrideNotch ?? state.splitNotch, notches);
        const aSize = chosen.aSize;

        if (isRow) {
          if (chosen.side === "a") packForcedLines(a, GAP, GAP, availH, chosen.lines, true, positions);
          else packGrid(a, GAP, GAP, aSize, availH, positions);

          const bX = GAP + aSize + HANDLE_SIZE;
          const bW = availW - aSize - HANDLE_SIZE;
          if (chosen.side === "b") packForcedLines(b, bX, GAP, availH, chosen.lines, true, positions);
          else packGrid(b, bX, GAP, bW, availH, positions);

          handleBox = { x: GAP + aSize, y: GAP, w: HANDLE_SIZE, h: availH, orientation: "row" };
          lastSplitGeometry = { isRow: true, splitAt: GAP + aSize };
        } else {
          if (chosen.side === "a") packForcedLines(a, GAP, GAP, availW, chosen.lines, false, positions);
          else packGrid(a, GAP, GAP, availW, aSize, positions);

          const bY = GAP + aSize + HANDLE_SIZE;
          const bH = availH - aSize - HANDLE_SIZE;
          if (chosen.side === "b") packForcedLines(b, GAP, bY, availW, chosen.lines, false, positions);
          else packGrid(b, GAP, bY, availW, bH, positions);

          handleBox = { x: GAP, y: GAP + aSize, w: availW, h: HANDLE_SIZE, orientation: "col" };
          lastSplitGeometry = { isRow: false, splitAt: GAP + aSize };
        }

        if (a.length === 1) positions.get(a[0]).isMain = true;
        if (b.length === 1) positions.get(b[0]).isMain = true;
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
      record.el.classList.toggle("is-main", !!pos.isMain);
      // The promote button does nothing for a tile that's already the
      // lone member of zone A — hide it there instead of a dead button.
      const isPromotable = !(state.mode === "split" && state.zoneA.length === 1 && state.zoneA[0] === name);
      record.promoteBtn.classList.toggle("hidden", !isPromotable);
      record.promoteBtn.title = state.mode === "grid" ? "Basculer en vue partagée" : "Mettre en avant seul(e)";
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

  // ---- Drag to resize the split ----
  //
  // The handle doesn't move freely: it only ever rests at one of the
  // "optimal" notches from computeSplitNotches, so dragging picks whichever
  // is closest to the pointer instead of any arbitrary position.

  let dragging = false;
  let dragNotch = null;

  el.focusHandle.addEventListener("pointerdown", (e) => {
    if (!el.focusHandle.classList.contains("visible")) return;
    dragging = true;
    dragNotch = state.splitNotch;
    el.focusHandle.classList.add("dragging");
    try {
      el.focusHandle.setPointerCapture(e.pointerId);
    } catch (e2) {
      /* ignore */
    }
  });

  el.focusHandle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = el.stage.getBoundingClientRect();
    const availW = rect.width - GAP * 2;
    const availH = rect.height - GAP * 2;
    const isRow = el.focusHandle.classList.contains("row");
    const rawASize = isRow ? e.clientX - rect.left - GAP : e.clientY - rect.top - GAP;
    const { a, b } = getZones();
    const notches = computeSplitNotches(a.length, b.length, availW, availH, isRow);
    let best = notches[0];
    let bestDiff = Infinity;
    for (const n of notches) {
      const diff = Math.abs(n.aSize - rawASize);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = n;
      }
    }
    dragNotch = { side: best.side, lines: best.lines };
    layoutAll(dragNotch);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    el.focusHandle.classList.remove("dragging");
    if (dragNotch) {
      state.splitNotch = dragNotch;
      saveState();
    }
  }
  el.focusHandle.addEventListener("pointerup", endDrag);
  el.focusHandle.addEventListener("pointercancel", endDrag);

  // ---- Drag to reorder tiles / move them between zones ----

  let reorderSource = null;
  let reorderTarget = null;
  let reorderHoverZone = null;

  function zoneFromPoint(clientX, clientY) {
    if (!lastSplitGeometry) return null;
    const rect = el.stage.getBoundingClientRect();
    return lastSplitGeometry.isRow
      ? clientX - rect.left < lastSplitGeometry.splitAt
        ? "a"
        : "b"
      : clientY - rect.top < lastSplitGeometry.splitAt
        ? "a"
        : "b";
  }

  function startDragReorder(name, downEvent) {
    reorderSource = name;
    reorderTarget = null;
    reorderHoverZone = null;
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
      if (state.mode === "split") {
        reorderHoverZone = reorderTarget ? zoneOf(reorderTarget) : zoneFromPoint(e.clientX, e.clientY);
      }
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

      if (state.mode === "grid") {
        if (reorderTarget) {
          swapChannels(state.channels, reorderSource, reorderTarget);
          saveState();
          layoutAll();
        }
      } else {
        const sourceZone = zoneOf(reorderSource);
        const targetZone = reorderTarget ? zoneOf(reorderTarget) : reorderHoverZone;
        if (targetZone && targetZone === sourceZone) {
          if (reorderTarget) {
            if (sourceZone === "a") swapChannels(state.zoneA, reorderSource, reorderTarget);
            else swapChannels(state.channels, reorderSource, reorderTarget);
            saveState();
            layoutAll();
          }
        } else if (targetZone && targetZone !== sourceZone) {
          // Never let a drag fully empty a zone — with no tile left there,
          // there'd be no divider to drag through to get one back.
          const sourceCount = getZones()[sourceZone].length;
          if (sourceCount > 1 || state.channels.length <= 1) {
            moveToZone(reorderSource, targetZone, reorderTarget);
          }
        }
      }

      reorderSource = null;
      reorderTarget = null;
      reorderHoverZone = null;
    };

    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    try {
      grip.setPointerCapture(downEvent.pointerId);
    } catch (e) {
      /* ignore — listeners above still work without capture */
    }
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

  el.splitToggleBtn.addEventListener("click", toggleSplit);
  el.swapZonesBtn.addEventListener("click", swapZones);

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

        const already = state.channels.includes(stream.login);
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

  const justConnectedToTwitch = consumeOAuthRedirect();
  if (justConnectedToTwitch) {
    el.twitchPanel.classList.remove("hidden");
    positionTwitchPanel();
    renderTwitchPanel();
    refreshFollowedLive();
  }

  // ---- Init ----

  function init() {
    updateModeButtons();
    el.qualitySelect.value = state.quality;
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
