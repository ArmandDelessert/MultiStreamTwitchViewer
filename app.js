(() => {
  "use strict";

  const RATIO = 16 / 9;
  const GAP = 8;
  const STORAGE_KEY = "twitchMultiView.state.v1";
  const MIN_CONTAINER_W = 220; // px, enforced at interaction time via the live stage size
  const MIN_CONTAINER_H = 150;

  // Containers are tiled edge-to-edge across the whole stage, arranged as a
  // binary tree of splits (no overlap, no gaps left over): a leaf holds one
  // container's id, a split holds two children side by side ("horizontal")
  // or stacked ("vertical") with `ratio` giving the first child's share.
  /** @type {{containers: {id:string, channels:string[]}[], layout: object|null, muted: Record<string, boolean>, quality: string}} */
  let state = loadState();

  const el = {
    stage: document.getElementById("stage"),
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
  if (location.search.includes("debug")) {
    window.__tiles = tiles;
    window.__state = state;
  }

  // container id -> DOM handles for its chrome (grip/toolbar).
  const containerBoxes = new Map();

  // container id -> last-laid-out pixel rect on the stage, used to hit-test
  // where a dragged tile/container is dropped.
  const containerRects = new Map();

  // split-node id -> DOM handle for its divider (the draggable seam between
  // its two children).
  const dividerEls = new Map();

  // split-node id -> {node, dir, parentRect} from the last layout pass, used
  // to resize a divider by dragging it.
  const dividerMeta = new Map();

  function clamp(min, val, max) {
    return Math.max(min, Math.min(max, val));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  // Builds a default tiling tree for a list of containers when there's no
  // (valid) saved layout tree to reuse — alternates split direction so
  // successive containers don't all stack the same way.
  function buildTreeFromContainers(containers) {
    if (containers.length === 0) return null;
    let tree = { type: "leaf", containerId: containers[0].id };
    for (let i = 1; i < containers.length; i++) {
      tree = {
        id: uid(),
        type: "split",
        dir: i % 2 === 1 ? "horizontal" : "vertical",
        ratio: 0.5,
        children: [tree, { type: "leaf", containerId: containers[i].id }],
      };
    }
    return tree;
  }

  function collectLeafIds(node, out) {
    if (!node) return;
    if (node.type === "leaf") {
      out.push(node.containerId);
      return;
    }
    if (!node.children || node.children.length !== 2) throw new Error("malformed split");
    collectLeafIds(node.children[0], out);
    collectLeafIds(node.children[1], out);
  }

  // A saved layout tree is only usable if it references exactly the current
  // set of container ids (nothing missing, nothing stale).
  function isValidTree(tree, containers) {
    if (!tree) return false;
    try {
      const ids = [];
      collectLeafIds(tree, ids);
      const a = ids.slice().sort();
      const b = containers.map((c) => c.id).sort();
      return a.length === b.length && a.every((v, i) => v === b[i]);
    } catch (e) {
      return false;
    }
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
            }));
          // Older saves used free-form x/y/w/h geometry instead of a layout
          // tree; when that (or anything else invalid) is all we have,
          // rebuild a fresh tiling tree from the containers' channel lists.
          const layout = isValidTree(parsed.layout, containers)
            ? parsed.layout
            : buildTreeFromContainers(containers);
          return {
            containers,
            layout,
            muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
            quality: typeof parsed.quality === "string" ? parsed.quality : "auto",
          };
        }
        // Migrate the even older single-list shape (channels[] + zoneA/mode)
        // into one full-stage container holding everything.
        if (Array.isArray(parsed.channels)) {
          const containers = parsed.channels.length ? [{ id: uid(), channels: parsed.channels }] : [];
          return {
            containers,
            layout: buildTreeFromContainers(containers),
            muted: parsed.muted && typeof parsed.muted === "object" ? parsed.muted : {},
            quality: typeof parsed.quality === "string" ? parsed.quality : "auto",
          };
        }
      }
    } catch (e) {
      console.warn("Failed to load state", e);
    }
    return { containers: [], layout: null, muted: {}, quality: "auto" };
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

  function defaultContainer() {
    return { id: uid(), channels: [] };
  }

  // ---- Layout tree (tiling: leaves hold a container id, splits hold two
  // children arranged "horizontal" (side by side) or "vertical" (stacked)). ----

  function findLeaf(node, containerId) {
    if (!node) return null;
    if (node.type === "leaf") return node.containerId === containerId ? node : null;
    return findLeaf(node.children[0], containerId) || findLeaf(node.children[1], containerId);
  }

  // Removes the leaf for `containerId`, collapsing its parent split into
  // whichever sibling remains.
  function removeLeaf(node, containerId) {
    if (!node) return null;
    if (node.type === "leaf") return node.containerId === containerId ? null : node;
    const [c0, c1] = node.children;
    if (c0.type === "leaf" && c0.containerId === containerId) return c1;
    if (c1.type === "leaf" && c1.containerId === containerId) return c0;
    node.children = [removeLeaf(c0, containerId), removeLeaf(c1, containerId)];
    return node;
  }

  // Replaces the leaf for `targetId` with a new split holding it and
  // `newLeaf`, on the given edge ("left"/"right"/"top"/"bottom").
  function insertLeaf(node, targetId, newLeaf, edge) {
    if (!node) return newLeaf;
    if (node.type === "leaf") {
      if (node.containerId !== targetId) return node;
      const dir = edge === "left" || edge === "right" ? "horizontal" : "vertical";
      const children = edge === "left" || edge === "top" ? [newLeaf, node] : [node, newLeaf];
      return { id: uid(), type: "split", dir, ratio: 0.5, children };
    }
    node.children = [
      insertLeaf(node.children[0], targetId, newLeaf, edge),
      insertLeaf(node.children[1], targetId, newLeaf, edge),
    ];
    return node;
  }

  // Picks the container currently occupying the most on-screen space, to
  // seed a newly added container from.
  function pickSplitDonor() {
    let best = null;
    let bestArea = -1;
    for (const c of state.containers) {
      const r = containerRects.get(c.id);
      const area = r ? r.w * r.h : 0;
      if (area > bestArea) {
        bestArea = area;
        best = c;
      }
    }
    return best || state.containers[0];
  }

  // Adds a new, empty container docked next to the one currently taking up
  // the most space — it never moves existing videos; the new container
  // shows its own "add a channel" field until something is added to it.
  function addContainer() {
    const c = defaultContainer();
    if (state.containers.length === 0) {
      state.containers.push(c);
      state.layout = { type: "leaf", containerId: c.id };
      saveState();
      layoutAll();
      return;
    }

    const donor = pickSplitDonor();
    const donorRect = containerRects.get(donor.id);
    const edge = !donorRect || donorRect.w >= donorRect.h ? "right" : "bottom";

    state.containers.push(c);
    state.layout = insertLeaf(state.layout, donor.id, { type: "leaf", containerId: c.id }, edge);

    saveState();
    layoutAll();
  }

  // Closing a container is always allowed, including the last one: its
  // videos (if any) merge into another container, or if it was the only
  // one left, they're simply dropped and a fresh empty container takes its
  // place — this is the "clear everything" affordance.
  function removeContainer(id) {
    const idx = state.containers.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const [removed] = state.containers.splice(idx, 1);
    if (state.containers.length === 0) {
      for (const name of removed.channels) {
        delete state.muted[name];
        destroyTile(name);
      }
      const c = defaultContainer();
      state.containers.push(c);
      state.layout = { type: "leaf", containerId: c.id };
    } else {
      const target = state.containers[0];
      target.channels.push(...removed.channels);
      state.layout = removeLeaf(state.layout, id);
    }
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
    if (state.containers.length === 0) {
      const c = defaultContainer();
      state.containers.push(c);
      state.layout = { type: "leaf", containerId: c.id };
    }
    addChannelsToContainer(state.containers[0].id, input);
  }

  // Same as addChannels, but into a specific container — used by each
  // empty container's own inline "add a channel" field.
  function addChannelsToContainer(containerId, input) {
    const target = getContainer(containerId);
    if (!target) return;
    const parts = input.split(",").map(normalizeChannel).filter(Boolean);
    let added = false;
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

  // Walks the tiling tree, writing each leaf's pixel rect into `leafRects`
  // and collecting one entry per split (its thin divider rect, plus the
  // full rect it divides, needed to turn a divider drag delta into a ratio).
  function layoutTree(node, rect, leafRects, dividers) {
    if (!node) return;
    if (node.type === "leaf") {
      leafRects.set(node.containerId, rect);
      return;
    }
    if (node.dir === "horizontal") {
      const w1 = clamp(0, Math.round((rect.w - GAP) * node.ratio), rect.w - GAP);
      const rectA = { x: rect.x, y: rect.y, w: w1, h: rect.h };
      const rectB = { x: rect.x + w1 + GAP, y: rect.y, w: rect.w - GAP - w1, h: rect.h };
      dividers.push({
        id: node.id,
        node,
        dir: "horizontal",
        rect: { x: rect.x + w1, y: rect.y, w: GAP, h: rect.h },
        parentRect: rect,
      });
      layoutTree(node.children[0], rectA, leafRects, dividers);
      layoutTree(node.children[1], rectB, leafRects, dividers);
    } else {
      const h1 = clamp(0, Math.round((rect.h - GAP) * node.ratio), rect.h - GAP);
      const rectA = { x: rect.x, y: rect.y, w: rect.w, h: h1 };
      const rectB = { x: rect.x, y: rect.y + h1 + GAP, w: rect.w, h: rect.h - GAP - h1 };
      dividers.push({
        id: node.id,
        node,
        dir: "vertical",
        rect: { x: rect.x, y: rect.y + h1, w: rect.w, h: GAP },
        parentRect: rect,
      });
      layoutTree(node.children[0], rectA, leafRects, dividers);
      layoutTree(node.children[1], rectB, leafRects, dividers);
    }
  }

  function layoutAll() {
    // Always keep at least one container (possibly empty) so there's
    // always something on the stage — an empty container shows its own
    // "add a channel" field instead of a whole-page placeholder.
    if (state.containers.length === 0) {
      const c = defaultContainer();
      state.containers.push(c);
      state.layout = { type: "leaf", containerId: c.id };
    }
    if (!state.layout) state.layout = buildTreeFromContainers(state.containers);

    const rect = el.stage.getBoundingClientRect();
    const stageRect = { x: 0, y: 0, w: rect.width, h: rect.height };
    const positions = new Map();
    const leafRects = new Map();
    const dividers = [];
    layoutTree(state.layout, stageRect, leafRects, dividers);

    syncContainerBoxes();
    syncDividers(dividers);

    state.containers.forEach((c, index) => {
      const px = leafRects.get(c.id) || { x: 0, y: 0, w: 0, h: 0 };
      containerRects.set(c.id, px);
      packGrid(c.channels, px.x + GAP, px.y + GAP, px.w - GAP * 2, px.h - GAP * 2, positions);
      renderContainerBox(c, px, index);
    });

    for (const d of dividers) {
      renderDivider(d);
      dividerMeta.set(d.id, { node: d.node, dir: d.dir, parentRect: d.parentRect });
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
    gripBtn.title = "Glisser vers le bord d'un autre conteneur pour l'y ancrer, ou vers son centre pour échanger leurs places";
    gripBtn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startDragDock(c.id, e);
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
    removeBtn.title = "Fermer ce conteneur";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeContainer(c.id);
    });
    extra.appendChild(removeBtn);

    chrome.appendChild(extra);
    box.appendChild(chrome);

    // Shown instead of any tiles while this container has no channels yet.
    const emptyState = document.createElement("form");
    emptyState.className = "containerEmptyState";
    emptyState.autocomplete = "off";

    const emptyInput = document.createElement("input");
    emptyInput.type = "text";
    emptyInput.placeholder = "Ajouter une chaîne…";
    emptyState.appendChild(emptyInput);

    const emptySubmit = document.createElement("button");
    emptySubmit.type = "submit";
    emptySubmit.textContent = "Ajouter";
    emptyState.appendChild(emptySubmit);

    emptyState.addEventListener("pointerdown", (e) => e.stopPropagation());
    emptyState.addEventListener("submit", (e) => {
      e.preventDefault();
      if (emptyInput.value.trim()) {
        addChannelsToContainer(c.id, emptyInput.value);
        emptyInput.value = "";
      }
    });
    box.appendChild(emptyState);

    el.containersLayer.appendChild(box);
    containerBoxes.set(c.id, { el: box, pauseBtn, muteBtn, removeBtn, emptyState });
  }

  function renderContainerBox(c, px, index) {
    const box = containerBoxes.get(c.id);
    if (!box) return;
    box.el.style.left = `${Math.round(px.x)}px`;
    box.el.style.top = `${Math.round(px.y)}px`;
    box.el.style.width = `${Math.round(px.w)}px`;
    box.el.style.height = `${Math.round(px.h)}px`;

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

    box.emptyState.classList.toggle("hidden", c.channels.length > 0);
  }

  // ---- Container dividers (drag the seam between two panes to resize) ----

  function syncDividers(dividers) {
    const liveIds = new Set(dividers.map((d) => d.id));
    for (const id of [...dividerEls.keys()]) {
      if (!liveIds.has(id)) destroyDivider(id);
    }
    for (const d of dividers) {
      if (!dividerEls.has(d.id)) createDivider(d);
    }
  }

  function destroyDivider(id) {
    const rec = dividerEls.get(id);
    if (rec) rec.el.remove();
    dividerEls.delete(id);
    dividerMeta.delete(id);
  }

  function createDivider(d) {
    const divEl = document.createElement("div");
    divEl.className = "containerDivider";
    divEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      startResizeDivider(d.id, e);
    });
    el.containersLayer.appendChild(divEl);
    dividerEls.set(d.id, { el: divEl });
  }

  function renderDivider(d) {
    const rec = dividerEls.get(d.id);
    if (!rec) return;
    rec.el.classList.toggle("horizontal", d.dir === "horizontal");
    rec.el.classList.toggle("vertical", d.dir === "vertical");
    rec.el.style.left = `${Math.round(d.rect.x)}px`;
    rec.el.style.top = `${Math.round(d.rect.y)}px`;
    rec.el.style.width = `${Math.round(d.rect.w)}px`;
    rec.el.style.height = `${Math.round(d.rect.h)}px`;
  }

  // Total number of channels under a layout node, used to size the "ideal"
  // grid on each side of a divider (nested splits are just summed — a
  // reasonable approximation of how tightly that whole side will pack).
  function countChannelsInSubtree(node) {
    if (!node) return 0;
    if (node.type === "leaf") {
      const c = getContainer(node.containerId);
      return c ? c.channels.length : 0;
    }
    return countChannelsInSubtree(node.children[0]) + countChannelsInSubtree(node.children[1]);
  }

  // How much of a (boxW x boxH) pane's area is left over once `n` tiles are
  // packed into it at 16:9 — the thing we're trying to minimize on both
  // sides of a divider at once.
  function paneWastedPx(n, boxW, boxH) {
    if (n <= 0) return 0;
    const w = Math.max(0, boxW - GAP * 2);
    const h = Math.max(0, boxH - GAP * 2);
    if (w <= 0 || h <= 0) return w * h;
    const packed = computeGrid(n, w, h, RATIO, GAP);
    return Math.max(0, w * h - n * packed.w * packed.h);
  }

  // The ratios a divider should snap to: the ones that leave the least
  // unused space on both sides combined ("ideal" positions), plus a few
  // evenly-spaced in-between ones whenever two ideal spots are far apart —
  // so dragging feels like choosing from a short list of good layouts
  // rather than a fully free, continuous resize.
  function computeSnapRatios(n1, n2, totalPx, crossPx, minPx) {
    const avail = totalPx - GAP;
    const lo = clamp(0, minPx, avail);
    const hi = clamp(lo, avail - minPx, avail);
    if (hi <= lo) return [0.5];

    const waste = (s) => paneWastedPx(n1, s, crossPx) + paneWastedPx(n2, avail - GAP - s, crossPx);
    const step = Math.max(2, Math.round((hi - lo) / 300));
    const samples = [];
    for (let s = lo; s <= hi; s += step) samples.push({ s, waste: waste(s) });
    if (samples[samples.length - 1].s !== hi) samples.push({ s: hi, waste: waste(hi) });

    const notches = [];
    samples.forEach((cur, i) => {
      const prev = samples[i - 1];
      const next = samples[i + 1];
      const isEdge = i === 0 || i === samples.length - 1;
      const isLocalMin = (!prev || cur.waste <= prev.waste) && (!next || cur.waste <= next.waste);
      if ((isLocalMin || isEdge) && (!notches.length || cur.s - notches[notches.length - 1] > step)) {
        notches.push(cur.s);
      }
    });

    const maxGap = Math.max(minPx * 1.4, (hi - lo) * 0.18);
    const filled = [];
    notches.forEach((s, i) => {
      filled.push(s);
      const next = notches[i + 1];
      if (next === undefined) return;
      const extra = Math.floor((next - s) / maxGap);
      for (let k = 1; k <= extra; k++) filled.push(s + ((next - s) * k) / (extra + 1));
    });

    return filled.map((s) => clamp(0, s / avail, 1));
  }

  // Small tick marks shown along a divider's track while it's being
  // dragged, one per snap ratio, so it's visible which discrete positions
  // are on offer instead of it just feeling like it randomly "sticks".
  let snapTickEls = [];

  function showSnapTicks(dir, parentRect, snapRatios) {
    clearSnapTicks();
    const avail = (dir === "horizontal" ? parentRect.w : parentRect.h) - GAP;
    for (const r of snapRatios) {
      const tick = document.createElement("div");
      tick.className = `snapTick ${dir}`;
      const offset = clamp(0, Math.round(avail * r), avail) + GAP / 2;
      if (dir === "horizontal") {
        tick.style.left = `${Math.round(parentRect.x + offset)}px`;
        tick.style.top = `${Math.round(parentRect.y)}px`;
        tick.style.height = `${Math.round(parentRect.h)}px`;
      } else {
        tick.style.top = `${Math.round(parentRect.y + offset)}px`;
        tick.style.left = `${Math.round(parentRect.x)}px`;
        tick.style.width = `${Math.round(parentRect.w)}px`;
      }
      el.containersLayer.appendChild(tick);
      snapTickEls.push(tick);
    }
  }

  function clearSnapTicks() {
    for (const t of snapTickEls) t.remove();
    snapTickEls = [];
  }

  function startResizeDivider(splitId, downEvent) {
    const handle = downEvent.currentTarget;
    const meta = dividerMeta.get(splitId);
    if (!meta) return;
    const { node, dir, parentRect } = meta;
    const rec = dividerEls.get(splitId);
    rec?.el.classList.add("dragging");

    const totalPx = dir === "horizontal" ? parentRect.w : parentRect.h;
    const crossPx = dir === "horizontal" ? parentRect.h : parentRect.w;
    const minPx = dir === "horizontal" ? MIN_CONTAINER_W : MIN_CONTAINER_H;
    const n1 = countChannelsInSubtree(node.children[0]);
    const n2 = countChannelsInSubtree(node.children[1]);
    const snapRatios = computeSnapRatios(n1, n2, totalPx, crossPx, minPx);
    showSnapTicks(dir, parentRect, snapRatios);

    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const startRatio = node.ratio;

    const onMove = (e) => {
      const delta =
        dir === "horizontal" ? (e.clientX - startX) / parentRect.w : (e.clientY - startY) / parentRect.h;
      const rawRatio = clamp(0, startRatio + delta, 1);
      let snapped = snapRatios[0];
      let bestDist = Infinity;
      for (const r of snapRatios) {
        const dist = Math.abs(r - rawRatio);
        if (dist < bestDist) {
          bestDist = dist;
          snapped = r;
        }
      }
      node.ratio = snapped;
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
      rec?.el.classList.remove("dragging");
      clearSnapTicks();
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

  // ---- Drag a container's grip onto another container's edge to dock it
  // there (splitting that container's spot), or onto its center to swap
  // the two containers' positions. ----

  function containerFromPoint(clientX, clientY) {
    const rect = el.stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const c of state.containers) {
      const px = containerRects.get(c.id);
      if (!px) continue;
      if (x >= px.x && x <= px.x + px.w && y >= px.y && y <= px.y + px.h) return { id: c.id, x, y };
    }
    return null;
  }

  // Which edge of `rect` the point (x,y) is closest to, or "center" when
  // it's well inside the middle of the container (swap zone).
  function edgeFromPoint(rect, x, y) {
    const relX = (x - rect.x) / rect.w;
    const relY = (y - rect.y) / rect.h;
    const CENTER_MARGIN = 0.28;
    if (relX > CENTER_MARGIN && relX < 1 - CENTER_MARGIN && relY > CENTER_MARGIN && relY < 1 - CENTER_MARGIN) {
      return "center";
    }
    const distances = { left: relX, right: 1 - relX, top: relY, bottom: 1 - relY };
    return Object.keys(distances).reduce((a, b) => (distances[b] < distances[a] ? b : a));
  }

  let dockIndicatorEl = null;

  function updateDockIndicator(targetId, edge) {
    if (!dockIndicatorEl) {
      dockIndicatorEl = document.createElement("div");
      dockIndicatorEl.className = "dockIndicator";
      el.containersLayer.appendChild(dockIndicatorEl);
    }
    if (!targetId || !edge) {
      dockIndicatorEl.style.display = "none";
      return;
    }
    const rect = containerRects.get(targetId);
    if (!rect) {
      dockIndicatorEl.style.display = "none";
      return;
    }
    dockIndicatorEl.style.display = "block";
    dockIndicatorEl.classList.toggle("dockCenter", edge === "center");
    let ix = rect.x;
    let iy = rect.y;
    let iw = rect.w;
    let ih = rect.h;
    if (edge === "left") iw = rect.w * 0.5;
    else if (edge === "right") {
      ix = rect.x + rect.w * 0.5;
      iw = rect.w * 0.5;
    } else if (edge === "top") ih = rect.h * 0.5;
    else if (edge === "bottom") {
      iy = rect.y + rect.h * 0.5;
      ih = rect.h * 0.5;
    }
    dockIndicatorEl.style.left = `${Math.round(ix)}px`;
    dockIndicatorEl.style.top = `${Math.round(iy)}px`;
    dockIndicatorEl.style.width = `${Math.round(iw)}px`;
    dockIndicatorEl.style.height = `${Math.round(ih)}px`;
  }

  function dockContainer(sourceId, targetId, edge) {
    if (sourceId === targetId) return;
    state.layout = removeLeaf(state.layout, sourceId);
    state.layout = insertLeaf(state.layout, targetId, { type: "leaf", containerId: sourceId }, edge);
    saveState();
    layoutAll();
  }

  function swapContainerPositions(idA, idB) {
    const leafA = findLeaf(state.layout, idA);
    const leafB = findLeaf(state.layout, idB);
    if (!leafA || !leafB) return;
    leafA.containerId = idB;
    leafB.containerId = idA;
    saveState();
    layoutAll();
  }

  function startDragDock(id, downEvent) {
    const grip = downEvent.currentTarget;
    const box = containerBoxes.get(id);
    box?.el.classList.add("dragging");

    let targetId = null;
    let edge = null;

    const onMove = (e) => {
      const hit = containerFromPoint(e.clientX, e.clientY);
      if (!hit || hit.id === id) {
        targetId = null;
        edge = null;
      } else {
        targetId = hit.id;
        edge = edgeFromPoint(containerRects.get(hit.id), hit.x, hit.y);
      }
      updateDockIndicator(targetId, edge);
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
      updateDockIndicator(null, null);

      if (targetId && edge === "center") swapContainerPositions(id, targetId);
      else if (targetId && edge) dockContainer(id, targetId, edge);
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

  // ---- Drag to reorder tiles / move them between containers ----

  let reorderSource = null;
  let reorderTarget = null;
  let reorderHoverContainer = null;

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
      const hoverHit = containerFromPoint(e.clientX, e.clientY);
      reorderHoverContainer = owner ? owner.id : hoverHit && hoverHit.id;
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
