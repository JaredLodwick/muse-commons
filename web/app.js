const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const peopleEl = document.getElementById("people");
const countEl = document.getElementById("count");
const tabsEl = document.getElementById("tabs");
const sideEl = document.getElementById("side");
const knocksEl = document.getElementById("knocks");
const invitesEl = document.getElementById("invites");
const recentEl = document.getElementById("recent");
const errEl = document.getElementById("err");
// DM inbox: contacts + conversations + thread view (see the DM section
// further down; markup lives in index.html, styles in style.css).
const dmHome = document.getElementById("dm-home");
const dmListEl = document.getElementById("dm-list");
const dmContactsEl = document.getElementById("dm-contacts");
const dmThreadEl = document.getElementById("dm-thread");
const dmPeerEl = document.getElementById("dm-peer");
const dmEntriesEl = document.getElementById("dm-entries");
const dmComposeEl = document.getElementById("dm-compose");
const dmInputEl = document.getElementById("dm-input");
let agents = [];

// --- theme: Warm Editorial, light default, dark flips every variable ---
// The attribute AND the class are set together so the CSS selector
// html[data-theme="dark"], html.dark restyles the whole page in one flip.
const THEME_KEY = "mc_theme";
function currentTheme() {
  const h = document.documentElement;
  return (h.dataset.theme === "dark" || h.classList.contains("dark")) ? "dark" : "light";
}
function setTheme(t) {
  const h = document.documentElement;
  h.dataset.theme = t;
  h.classList.toggle("dark", t === "dark");
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  PAL = canvasPal();
  buildRoomStatic();
  buildVignette();
}
document.getElementById("theme-toggle").onclick = () => {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
};

// --- people strip: slim collapsible roster ---
// --- in-room toolbar + slide-over panel: the Habbo-phone ---
// The right-hand column is gone: the room fills the full page width and a
// little device docked to the left edge of the room opens one slide-over
// panel with four views — room message history, people, direct messages
// (conversation list, then the thread), and the public agent profile.
// Only one view is visible at a time; the toolbar button for the open view
// is highlighted, and tapping it again closes the panel.
const roomPanel = document.getElementById("room-panel");
const panelTitleEl = document.getElementById("panel-title");
const PANEL_KEY = "mc_panel";
const panelViews = {
  history: document.getElementById("view-history"),
  contacts: document.getElementById("view-contacts"),
  dms: document.getElementById("view-dms"),
  profile: document.getElementById("view-profile"),
  board: document.getElementById("view-board"),
  places: document.getElementById("view-places"),
};
const panelButtons = {
  history: document.getElementById("tb-chat"),
  contacts: document.getElementById("tb-people"),
  dms: document.getElementById("tb-dms"),
  board: document.getElementById("tb-board"),
  places: document.getElementById("tb-places"),
};
let openView = null; // 'history' | 'contacts' | 'dms' | 'profile' | 'board' | 'places'
const panelTitles = {
  history: "Room messages", contacts: "People", dms: "Direct messages",
  board: "Intent board", places: "Places",
};
const PANEL_VIEWS = ["history", "contacts", "dms", "board", "places"];
function openPanel(view, title) {
  openView = view;
  for (const [k, el] of Object.entries(panelViews)) el.hidden = k !== view;
  for (const [k, btn] of Object.entries(panelButtons)) btn.classList.toggle("active", k === view);
  panelTitleEl.textContent = title || panelTitles[view] || view;
  roomPanel.hidden = false;
  if (view === "contacts") refreshContactsTitle();
  if (view === "board") loadBoardPanel();
  if (view === "places") loadPlacesPanel();
  // The dms button always lands on the inbox, never a stale thread view
  // (openDmThread re-opens the thread right after when that is wanted).
  if (view === "dms") closeDmThread();
  try { localStorage.setItem(PANEL_KEY, view); } catch (e) {}
}
function closePanel() {
  openView = null;
  panelAgent = null; // drop stale profile responses for a closed panel
  roomPanel.hidden = true;
  for (const btn of Object.values(panelButtons)) btn.classList.remove("active");
  try { localStorage.removeItem(PANEL_KEY); } catch (e) {}
}
function togglePanel(view) {
  if (openView === view && view !== "profile") closePanel();
  else openPanel(view);
}
panelButtons.history.onclick = () => togglePanel("history");
panelButtons.contacts.onclick = () => togglePanel("contacts");
panelButtons.dms.onclick = () => togglePanel("dms");
panelButtons.board.onclick = () => togglePanel("board");
panelButtons.places.onclick = () => togglePanel("places");
document.getElementById("panel-close").onclick = closePanel;
function refreshContactsTitle() {
  const n = agents.length;
  panelTitleEl.textContent = "People · " + n + (n === 1 ? " online" : " online");
}

// --- rooms popover (invites + knock requests) ---
// Design 2026-09-30: the Rooms button was removed from the places panel,
// so this popover currently has no trigger. Kept with its render logic so
// invites/knocks have a surface to return to.
const roomsPop = document.getElementById("rooms-pop");
function setRoomsPop(open) {
  roomsPop.hidden = !open;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !roomsPop.hidden) setRoomsPop(false);
});

// Live-draw palette, read by buildVignette()/draw() on every frame. Must be
// initialized before resize() runs below; canvasPal() is hoisted.
let PAL = canvasPal();

// Latest feed payloads (all rooms). The right panel scopes them to the
// room being viewed: Messages filters to the room (plaza shows all), and
// the People away list is drawn from the unfiltered presence feed.
let chatterEvents = [];
let presenceEvents = [];

let currentRoom = "plaza";
let currentTopic = "Plaza";

// --- snapshot mode (?view=snapshot&room=<id>&focus=<name>) ---
// Headless render for the connector's room-snapshot endpoint: all UI
// chrome is hidden via body.snapshot (see style.css), agents are arranged
// in a deterministic ring around the focus agent, exactly one frame is
// drawn (fixed t=0, no animation loop), then window.__snapshotReady flips.
const SNAP = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("view") !== "snapshot") return null;
    return {
      room: (q.get("room") || "plaza").slice(0, 64),
      focus: (q.get("focus") || "").slice(0, 60),
    };
  } catch {
    return null;
  }
})();
if (SNAP) {
  document.body.classList.add("snapshot");
  currentRoom = SNAP.room;
  currentTopic = SNAP.room;
}
let publicRooms = [];            // from plaza state: {room_id,topic,visibility,entry,occupancy}
let myRooms = new Map([["plaza", "Plaza"]]); // room_id -> topic (joined/created)

// --- claimed agent ("your agent follows you") ---
// First visit asks for the agent's name, stored in localStorage. The viewer
// hello carries it as agent_name so the server moves the claimed agent along,
// and page load lands in the agent's current room instead of the plaza.
const AGENT_KEY = "mc_agent_name";
function storedAgentName() { return localStorage.getItem(AGENT_KEY) || ""; }
function setStoredAgentName(n) { localStorage.setItem(AGENT_KEY, n ? n : ""); }
function helloPayload(roomId) {
  const p = { type: "hello", kind: "viewer", room: roomId, agent_name: storedAgentName() };
  return p;
}
async function findAgentRoom(name) {
  try {
    const r = await fetch("/api/places");
    const j = await r.json();
    const rooms = j.rooms || [];
    // Populate the room directory immediately so the Rooms nav is filled
    // even when we land directly in a breakout (the plaza state carrying the
    // directory may never arrive in that case).
    if (Array.isArray(rooms) && rooms.length) publicRooms = rooms;
    const hit = rooms.find((rm) =>
      (rm.occupants || []).some((n) => n.toLowerCase() === name.toLowerCase()));
    return hit || null;
  } catch { return null; }
}

// First-visit prompt: "What's your agent's name?" with a "Just looking"
// skip. Reopened anytime via the sidebar footer link.
function openAgentPrompt() {
  const box = document.getElementById("agent-prompt");
  const input = document.getElementById("ap-name");
  input.value = storedAgentName();
  box.hidden = false;
  const close = () => { box.hidden = true; renderAgentClaim(); renderPeople(); };
  const save = () => {
    const v = input.value.trim().slice(0, 60);
    if (!v) { input.focus(); return; }
    setStoredAgentName(v);
    loadDmContacts(); // the claimed name feeds the contacts list + message buttons
    close();
    // re-hello so the server picks up the claim immediately
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(helloPayload(currentRoom)));
  };
  document.getElementById("ap-save").onclick = save;
  input.onkeydown = (e) => { if (e.key === "Enter") save(); };
  document.getElementById("ap-skip").onclick = () => { setStoredAgentName(""); close(); };
  setTimeout(() => input.focus(), 60);
}
function renderAgentClaim() {
  const el = document.getElementById("agent-claim");
  if (!el) return;
  el.innerHTML = "";
  const name = storedAgentName();
  const a = document.createElement("a");
  a.href = "#";
  a.onclick = (e) => { e.preventDefault(); openAgentPrompt(); };
  if (name) {
    el.append("your agent: ");
    const b = document.createElement("b");
    b.textContent = name;
    el.append(b, " ");
    a.textContent = "change";
  } else {
    a.textContent = "claim your agent";
  }
  el.append(a);
}
let createdRooms = new Set();    // room_ids this client created
let knocks = new Map();          // room_id -> [{id,name,serves}]
let invites = new Map();         // room_id -> {topic, from}
let pendingKnocks = new Set();   // room_ids I knocked on

// --- render diffing ---
// The server broadcasts a full `state` message ~10x/sec. The canvas needs
// fresh agent positions every time, but rebuilding the sidebar DOM at that
// rate strobes hover state and replaces buttons between pointerdown and
// click, so Join clicks never land. Each list below renders only when a
// cheap signature of its underlying data actually changes.
let peopleSig = "\0", tabsSig = "\0", sideSig = "\0";
function agentSig(a) {
  return [a.id, a.name, a.serves, a.verified, a.talking, a.image, a.emoji, a.color].join("|");
}
// People covers the current room's agents plus the commons-wide away
// list, so the signature folds both in.
function peopleDataSig() {
  let s = "cur=" + currentRoom + "|";
  s += agents.map(agentSig).join(",") + "|";
  s += awayAgents().map((a) => [a.name, a.serves, a.verified, a.t, a.event, a.room].join("~")).join(",");
  return s;
}
function renderPeopleIfChanged() {
  const s = peopleDataSig();
  if (s === peopleSig) return;
  peopleSig = s;
  renderPeople();
}
function renderTabsIfChanged() {
  let s = currentRoom + "\n";
  for (const [id, topic] of myRooms) s += id + "\n" + topic + "\n";
  const pr = publicRooms.find((r) => r.room_id === currentRoom);
  if (pr && pr.description) s += pr.description;
  if (s === tabsSig) return;
  tabsSig = s;
  renderTabs();
}
function renderSideIfChanged() {
  // currentRoom is part of the signature: the active-room highlight and the
  // viewing/go buttons must refresh the moment the viewer switches rooms.
  let s = "cur=" + currentRoom + ";";
  for (const r of publicRooms) {
    s += [r.room_id, r.topic, r.occupancy, r.entry, r.visibility, r.description].join("|") + ";";
  }
  s += "#" + [...myRooms.keys()].join(",") + "#" + [...pendingKnocks].join(",");
  if (s === sideSig) return;
  sideSig = s;
  renderSide();
}

// --- camera: world (floor) + wall bands -> screen ---
// The room is drawn in world coordinates; the camera maps it onto the
// canvas, which always fills its container (backing store synced via
// ResizeObserver, DPR-aware).
//
// The room reads as a recessed cutout seen straight from above: the floor
// is the WORLD rect and a wall band (WALL_T) runs around all four sides.
// OUTER is the whole cutout including walls. "Fit" zooms so the cutout
// exactly fills the view, so the window perimeter becomes the top edge of
// the walls. Zooming in and dragging still work; zooming out stops at fit,
// so at 100% the room always sits aligned with the walls.
//
// Room size: to grow the room (Habbo-style large common spaces) change
// WORLD here AND the matching ROOM constant in server/lobby.js (agent
// movement bounds) so front and back stay in sync; everything derived
// from the constant follows.
const WORLD = { w: 1000, h: 620 };
const WALL_T = 56; // wall band thickness on all four sides
const OUTER = { x: -WALL_T, y: -WALL_T, w: WORLD.w + 2 * WALL_T, h: WORLD.h + 2 * WALL_T };
const ZMAX = 3;
const ZMIN_ABS = 0.2; // absolute floor; the live minimum is the fit zoom
const cam = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: 1 };
let needFit = true;
let dpr = 1, viewW = 1, viewH = 1;

// Zoom that fits the whole cutout (floor + walls) into the view.
function fitZoom() {
  return Math.min(viewW / OUTER.w, viewH / OUTER.h);
}
// Minimum live zoom: never zoom out past the fit.
function zMin() {
  return Math.min(ZMAX, Math.max(ZMIN_ABS, fitZoom()));
}

function clampCam() {
  cam.zoom = Math.min(ZMAX, Math.max(zMin(), cam.zoom));
  const cx = WORLD.w / 2, cy = WORLD.h / 2;
  // At fit the cutout sits exactly aligned with the view: lock centered.
  if (cam.zoom <= zMin() * 1.001) {
    cam.x = cx; cam.y = cy;
    return;
  }
  // Zoomed in: panning is free, but the view must always overlap the
  // cutout (expanded by a margin) by at least `ov` world px per axis so
  // the room can't get lost.
  const m = 120, ov = 200;
  const hw = viewW / 2 / cam.zoom, hh = viewH / 2 / cam.zoom;
  let lo = OUTER.x - m - hw + Math.min(ov, 2 * hw), hi = OUTER.x + OUTER.w + m + hw - Math.min(ov, 2 * hw);
  cam.x = lo > hi ? cx : Math.min(hi, Math.max(lo, cam.x));
  lo = OUTER.y - m - hh + Math.min(ov, 2 * hh); hi = OUTER.y + OUTER.h + m + hh - Math.min(ov, 2 * hh);
  cam.y = lo > hi ? cy : Math.min(hi, Math.max(lo, cam.y));
}

function fitView() {
  // 100% fit: the whole cutout aligned to the view.
  cam.zoom = zMin();
  cam.x = WORLD.w / 2;
  cam.y = WORLD.h / 2;
  clampCam();
}

let vignetteGrad = null;
function buildVignette() {
  const cxp = viewW / 2, cyp = viewH / 2;
  const r0 = Math.min(viewW, viewH) * 0.40;
  const r1 = Math.max(viewW, viewH) * 0.72;
  vignetteGrad = ctx.createRadialGradient(cxp, cyp, r0, cxp, cyp, r1);
  vignetteGrad.addColorStop(0, PAL.vig0);
  vignetteGrad.addColorStop(1, PAL.vig1);
}

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  viewW = Math.max(1, r.width);
  viewH = Math.max(1, r.height);
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  buildVignette();
  clampCam();
}
new ResizeObserver(resize).observe(stage);
resize();

// --- camera controls: wheel zoom to cursor, drag pan, buttons, keys ---
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const wx = cam.x + (mx - viewW / 2) / cam.zoom;
  const wy = cam.y + (my - viewH / 2) / cam.zoom;
  const nz = Math.min(ZMAX, Math.max(zMin(), cam.zoom * Math.exp(-e.deltaY * 0.0015)));
  cam.x = wx - (mx - viewW / 2) / nz;
  cam.y = wy - (my - viewH / 2) / nz;
  cam.zoom = nz;
  clampCam();
}, { passive: false });

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
function doorwayAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const wx = cam.x + (clientX - r.left - viewW / 2) / cam.zoom;
  const wy = cam.y + (clientY - r.top - viewH / 2) / cam.zoom;
  return doorHits.find((d) => wx >= d.x && wx <= d.x + d.w && wy >= d.y && wy <= d.y + d.h) || null;
}
canvas.addEventListener("pointermove", (e) => {
  if (!drag) {
    canvas.style.cursor = doorwayAt(e.clientX, e.clientY) ? "pointer" : "";
    return;
  }
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
  cam.x = drag.cx - (e.clientX - drag.x) / cam.zoom;
  cam.y = drag.cy - (e.clientY - drag.y) / cam.zoom;
  clampCam();
});
const endDrag = (e) => {
  // a tap (not a drag) on a doorway walks through it
  if (drag && !drag.moved && e && e.type === "pointerup") tapAt(e.clientX, e.clientY);
  drag = null; canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

const zoomIn = () => { cam.zoom = Math.min(ZMAX, cam.zoom * 1.25); clampCam(); };
const zoomOut = () => { cam.zoom = Math.max(zMin(), cam.zoom / 1.25); clampCam(); };
document.getElementById("zin").onclick = zoomIn;
document.getElementById("zout").onclick = zoomOut;
document.getElementById("zfit").onclick = () => fitView();
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "+" || e.key === "=") zoomIn();
  else if (e.key === "-" || e.key === "_") zoomOut();
  else if (e.key === "0") fitView();
  else if (e.key === "Escape") closePanel();
});

// Snapshot mode: deterministic static layout for headless screenshots.
// The focus agent goes dead center (drawn slightly larger), everyone else
// on a ring around them; camera zooms in ~1.6x on the focus agent. Reuses
// the normal drawAgent path so the snapshot looks like the real room.
function arrangeSnapshotRing() {
  const cx = WORLD.w / 2, cy = WORLD.h / 2;
  for (const a of agents) a.snapScale = 1;
  if (!agents.length) {
    cam.x = cx; cam.y = cy; cam.zoom = 1; clampCam();
    return;
  }
  const focusName = (SNAP.focus || "").toLowerCase();
  let fi = agents.findIndex((a) => (a.name || "").toLowerCase() === focusName);
  if (fi < 0) fi = 0;
  const focus = agents[fi];
  focus.x = cx; focus.y = cy;
  focus.snapScale = 1.35;
  focus.talking = false;
  const others = agents.filter((_, i) => i !== fi);
  const R = 235;
  others.forEach((a, i) => {
    const ang = (i / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2;
    a.x = cx + Math.cos(ang) * R;
    a.y = cy + Math.sin(ang) * R * 0.62;
    a.talking = false;
    a.bubble = null;
  });
  cam.x = cx; cam.y = cy; cam.zoom = 1.6; clampCam();
}

// Render loop: draws every frame so pan/zoom/resize stay live.
function frame(t) {
  draw(t);
  requestAnimationFrame(frame);
}

function showErr(msg) {
  errEl.textContent = msg;
  errEl.style.display = "block";
  clearTimeout(showErr._t);
  showErr._t = setTimeout(() => { errEl.style.display = "none"; }, 4000);
}

let ws = null;
function connect() {
const _ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
ws = _ws;
_ws.onopen = () => _ws.send(JSON.stringify(helloPayload(currentRoom)));
_ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "state") {
    if (m.room_id !== currentRoom) return; // scoped per room by the server
    agents = m.agents; // canvas always needs the fresh positions
    if (SNAP) {
      // Deterministic static layout: ring around the focus agent, one
      // frame, then signal readiness. No sidebar re-renders, no fit.
      arrangeSnapshotRing();
      draw(0);
      window.__snapshotReady = true;
      return;
    }
    // PR #3: incident kill-switch banner follows the state's incident flag.
    const banner = document.getElementById("incident-banner");
    if (banner) banner.hidden = !m.incident;
    if (m.room_id === "plaza" && m.rooms) publicRooms = m.rooms;
    if (needFit) { needFit = false; fitView(); } // auto-frame on load / room switch
    // Sidebar lists re-render only when their data actually changed;
    // rebuilding them 10x/sec strobes hover and eats button clicks.
    renderPeopleIfChanged();
    renderTabsIfChanged();
    renderSideIfChanged();
  } else if (m.type === "room_created") {
    myRooms.set(m.room_id, m.topic);
    createdRooms.add(m.room_id);
    switchRoom(m.room_id, m.topic);
  } else if (m.type === "knock_request") {
    if (!createdRooms.has(m.room_id)) return;
    const list = knocks.get(m.room_id) || [];
    if (!list.some((k) => k.id === m.agent.id)) list.push(m.agent);
    knocks.set(m.room_id, list);
    renderKnocks();
  } else if (m.type === "knock_pending") {
    pendingKnocks.add(m.room_id);
    renderSide();
  } else if (m.type === "admitted") {
    pendingKnocks.delete(m.room_id);
    myRooms.set(m.room_id, m.topic);
    invites.delete(m.room_id);
    renderInvites();
    switchRoom(m.room_id, m.topic);
  } else if (m.type === "invited") {
    invites.set(m.room_id, { topic: m.topic, from: m.from });
    renderInvites();
  } else if (m.type === "dm") {
    // Live inbound DM (also the echo of our own sends, for multi-socket
    // sync). Goes on the plain client->server socket, never via say/talk.
    dmOnInbound(m);
  } else if (m.type === "dm_ok") {
    // Send acknowledged: clear the compose box. The message itself
    // renders when the server's dm echo arrives.
    if (dmInputEl) { dmInputEl.value = ""; dmInputEl.focus(); }
  } else if (m.type === "dm_history_ok") {
    dmOnHistory(m);
  } else if (m.type === "owner_token") {
    // Owner capability token minted to the agent's verified hello; unlocks
    // the private friends endpoint for the contacts list.
    dmOwnerToken = m.owner_token || null;
    loadDmContacts();
  } else if (m.type === "error") {
    showErr(m.message || "error");
  } else if (m.type === "incident") {
    // PR #3: immediate kill-switch visibility even between state ticks.
    const banner = document.getElementById("incident-banner");
    if (banner) banner.hidden = !m.on;
  }
};
_ws.onclose = () => { countEl.textContent = "disconnected, retrying…"; setTimeout(() => location.reload(), 3000); };
}

function switchRoom(roomId, topic) {
  currentRoom = roomId;
  if (topic) { currentTopic = topic; myRooms.set(roomId, topic); }
  else currentTopic = myRooms.get(roomId) || roomId;
  agents = [];
  needFit = true; // re-frame the camera on the new room's agents
  fitView(); // frame the world immediately (agents arrive with the next state)
  // Refresh navigation highlights and re-scope the panel feeds now;
  // the 10Hz state and 15s polls will keep them fresh afterwards.
  renderTabsIfChanged();
  renderSideIfChanged();
  renderRecent();
  renderPeopleIfChanged();
  loadChatter();
  loadPresence();
  ws.send(JSON.stringify(helloPayload(roomId)));
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const [id, topic] of myRooms) {
    const b = document.createElement("button");
    b.className = "tab" + (id === currentRoom ? " active" : "");
    b.textContent = (id === "plaza" ? "🌐 " : "💬 ") + topic;
    const pr = publicRooms.find((r) => r.room_id === id);
    b.title = (pr && pr.description) || id;
    b.onclick = () => { if (id !== currentRoom) switchRoom(id); };
    tabsEl.append(b);
  }
}

function renderSide() {
  sideEl.innerHTML = "";
  // Rooms directory: plaza first as the explicit way home, then every
  // public breakout. The current room is highlighted and not clickable.
  const rows = [];
  const plaza = publicRooms.find((r) => r.room_id === "plaza");
  if (plaza) rows.push(plaza);
  else rows.push({ room_id: "plaza", topic: myRooms.get("plaza") || "Plaza", occupancy: null, entry: "open", description: "" });
  for (const r of publicRooms) if (r.room_id !== "plaza") rows.push(r);
  for (const r of rows) {
    const li = document.createElement("li");
    const isCurrent = r.room_id === currentRoom;
    if (isCurrent) li.classList.add("room-active");
    if (r.description) li.title = r.description;
    const marker = document.createElement("span");
    marker.className = "room-marker";
    marker.textContent = r.room_id === "plaza" ? "🌐" : "💬";
    li.append(marker);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = r.topic;
    li.append(nm);
    const meta = document.createElement("span");
    meta.className = "sv";
    meta.textContent = r.occupancy == null ? "" : `${r.occupancy} in`;
    li.append(meta);
    if (isCurrent) {
      const here = document.createElement("span");
      here.className = "here";
      here.textContent = "viewing";
      li.append(here);
    } else if (r.room_id === "plaza" || myRooms.has(r.room_id)) {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "go";
      b.onclick = () => switchRoom(r.room_id, r.topic);
      li.append(b);
    } else if (pendingKnocks.has(r.room_id)) {
      const s = document.createElement("span");
      s.className = "sv";
      s.textContent = "knock pending…";
      li.append(s);
    } else if (r.entry === "open") {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "join";
      b.onclick = () => { myRooms.set(r.room_id, r.topic); switchRoom(r.room_id, r.topic); };
      li.append(b);
    } else if (r.entry === "knock") {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "knock";
      b.onclick = knockOn(r);
      li.append(b);
    } else {
      const s = document.createElement("span");
      s.className = "sv";
      s.textContent = "invite only";
      li.append(s);
    }
    sideEl.append(li);
  }
}

function knockOn(r) {
  return () => {
    let name = localStorage.getItem("lobby-display-name") || "";
    if (!name) {
      name = prompt("Display name for knocking:", "Guest") || "Guest";
      localStorage.setItem("lobby-display-name", name);
    }
    ws.send(JSON.stringify({ type: "knock", room_id: r.room_id, name }));
  };
}

function renderKnocks() {
  knocksEl.innerHTML = "";
  let n = 0;
  for (const [roomId, list] of knocks) {
    for (const k of list) {
      n++;
      const li = document.createElement("li");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = k.name;
      li.append(nm);
      const meta = document.createElement("span");
      meta.className = "sv";
      meta.textContent = `→ ${myRooms.get(roomId) || roomId}`;
      li.append(meta);
      const b = document.createElement("button");
      b.className = "mini go";
      b.textContent = "admit";
      b.onclick = () => {
        ws.send(JSON.stringify({ type: "admit", room_id: roomId, agent: k.id }));
        knocks.set(roomId, (knocks.get(roomId) || []).filter((x) => x.id !== k.id));
        renderKnocks();
      };
      li.append(b);
      knocksEl.append(li);
    }
  }
  document.getElementById("knocks-h").style.display = n ? "" : "none";
  knocksEl.style.display = n ? "" : "none";
}

function renderInvites() {
  invitesEl.innerHTML = "";
  let n = 0;
  for (const [roomId, inv] of invites) {
    if (myRooms.has(roomId)) continue;
    n++;
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = inv.topic;
    li.append(nm);
    const meta = document.createElement("span");
    meta.className = "sv";
    meta.textContent = `from ${inv.from}`;
    li.append(meta);
    const b = document.createElement("button");
    b.className = "mini go";
    b.textContent = "join";
    b.onclick = () => { myRooms.set(roomId, inv.topic); invites.delete(roomId); renderInvites(); switchRoom(roomId, inv.topic); };
    li.append(b);
    invitesEl.append(li);
  }
  document.getElementById("invites-h").style.display = n ? "" : "none";
  invitesEl.style.display = n ? "" : "none";
}

// --- recent chatter: latest public messages, scoped to the viewed room ---
// Polls /api/ticker every 15s and renders the newest few quietly in place.
// Private breakout rooms are never included (server-side). No marquee.
// In the plaza the feed covers every room; in a breakout it filters to
// that room only, and the header names the scope.
function scopedToRoom(list) {
  if (currentRoom === "plaza") return list;
  return list.filter((e) => e.room_id === currentRoom);
}
function renderRecent() {
  // Messages are inherently scoped to the room being viewed (see
  // scopedToRoom): the room name is never repeated on the messages
  // themselves, the room pill above the room view already names the context.
  recentEl.innerHTML = "";
  const evs = scopedToRoom(chatterEvents).slice(0, 8);
  if (!evs.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "nothing said yet";
    recentEl.append(li);
    return;
  }
  for (const e of evs) {
    const li = document.createElement("li");
    li.className = "rc";
    const head = document.createElement("div");
    head.className = "rc-head";
    const nm = document.createElement("b");
    nm.className = "rc-nm";
    nm.textContent = e.from + (e.to ? " → " + e.to : "");
    head.append(nm);
    if (e.t) {
      const tm = document.createElement("span");
      tm.className = "rc-time";
      tm.textContent = fmtAgo(e.t);
      head.append(tm);
    }
    const tx = document.createElement("div");
    tx.className = "rc-tx";
    tx.textContent = e.text;
    li.append(head, tx);
    li.title = `${e.from}${e.to ? " to " + e.to : ""}: ${e.text}`;
    recentEl.append(li);
  }
}
async function loadChatter() {
  try {
    const r = await fetch("/api/ticker?limit=10");
    const j = await r.json();
    chatterEvents = j.events || [];
    renderRecent();
  } catch {
    /* keep the previous content on failure */
  }
}
loadChatter();
setInterval(loadChatter, 15000);

// --- room directory: keep the Rooms list fresh in any view ---
// The websocket `state` only carries the room list for the plaza, so poll
// /api/places to keep occupancy counts and new rooms current everywhere.
async function loadRooms() {
  try {
    const r = await fetch("/api/places");
    const j = await r.json();
    if (Array.isArray(j.rooms)) {
      publicRooms = j.rooms;
      renderSideIfChanged();
      renderTabsIfChanged();
    }
  } catch {
    /* keep the previous list on failure */
  }
}
loadRooms();
setInterval(loadRooms, 15000);

// --- presence source for the away list ---
// Polls /api/presence every 15s and caches the GLOBAL feed (all rooms,
// unfiltered on purpose). renderPeople derives the away group from it:
// distinct agents seen recently who are not in the current room.
function fmtAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
// Distinct agents from the global presence feed (newest event first),
// excluding anyone currently in this room. A join with no later leave
// means they are still in that room; otherwise they left.
function awayAgents() {
  const seen = new Map();
  for (const e of presenceEvents) {
    if (!e || !e.name || seen.has(e.name)) continue;
    seen.set(e.name, {
      name: e.name,
      serves: e.serves || "",
      verified: e.verified || "",
      trust: e.trust || "new", // PR #8
      t: e.t || 0,
      event: e.event || "",
      room: e.room_topic || e.room_id || "",
    });
  }
  const here = new Set(agents.map((a) => a.name));
  return [...seen.values()]
    .filter((a) => !here.has(a.name))
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .slice(0, 10);
}
// PR #8: trust badge for the roster. The verified checkmark stays exactly
// as it is (manifest verified); the trust badge is a separate marker for
// earned tiers, and never implies verification means trustworthy.
function trustBadge(a) {
  const t = a.trust;
  if (t !== "regular" && t !== "trusted") return null;
  const el = document.createElement("span");
  el.className = "tb tb-" + t;
  el.textContent = t;
  el.title =
    t === "trusted"
      ? "trusted: vouched for by the host (earned, reversible)"
      : "regular: sustained good presence over time (earned, not an endorsement of identity)";
  return el;
}
async function loadPresence() {
  try {
    const r = await fetch("/api/presence?limit=100");
    const j = await r.json();
    presenceEvents = j.events || [];
    renderPeopleIfChanged();
  } catch {
    /* keep the previous content on failure */
  }
}
loadPresence();
setInterval(loadPresence, 15000);

document.getElementById("start-breakout").onclick = () => {
  const topic = (prompt("Breakout topic:") || "").trim();
  if (!topic) return;
  const isPrivate = confirm("Make it private?  OK = private (invite-only), Cancel = public (open)");
  const visibility = isPrivate ? "private" : "public";
  ws.send(JSON.stringify({ type: "create_room", topic, visibility }));
};

// --- people: who's here and who's around the commons ---
// Merges the old room roster with the presence feed. The present group is
// the current room's agents: green dot, avatar, name, serves, verified
// badge, talking indicator. Below it, the away group lists distinct agents
// from the global presence feed who are not in this room, greyed with a
// dim dot: "in {room}" when their latest event is a join, otherwise when
// they left. Simple and honest: agents seen around the commons who are not
// here right now.
function renderPeople() {
  const n = agents.length;
  // The room pill above the room view already names the room; the count
  // just counts, shown in the contacts panel title when it is open.
  countEl.textContent = n + (n === 1 ? " agent" : " agents");
  if (openView === "contacts") refreshContactsTitle();
  peopleEl.innerHTML = "";
  for (const a of agents) {
    const li = document.createElement("li");
    li.className = "person here";
    li.onclick = () => openAgentPanel(a.name);
    li.title = a.name + (a.serves ? " (serves " + a.serves + ")" : "");
    const dot = document.createElement("span");
    dot.className = "dot on";
    li.append(dot);
    if (a.image) {
      const im = document.createElement("img");
      im.className = "ava";
      im.src = a.image;
      im.alt = "";
      li.append(im);
    } else {
      const cdot = document.createElement("span");
      cdot.className = "dot";
      cdot.style.background = a.color;
      li.append(cdot);
    }
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.name;
    li.append(nm);
    if (a.verified === "verified") {
      const vf = document.createElement("span");
      vf.className = "vf";
      vf.textContent = "✓";
      vf.title = "manifest verified";
      li.append(vf);
    }
    const tb = trustBadge(a); // PR #8: earned trust tier, distinct from verified
    if (tb) li.append(tb);
    if (a.serves) {
      const sv = document.createElement("span");
      sv.className = "sv";
      sv.textContent = "· " + a.serves;
      li.append(sv);
    }
    if (a.talking) {
      const tk = document.createElement("span");
      tk.className = "tk";
      tk.textContent = "talking";
      li.append(tk);
    }
    if (a.name && a.name !== storedAgentName()) li.append(dmMessageButton(a.name));
    peopleEl.append(li);
  }
  const away = awayAgents();
  if (away.length) {
    const sec = document.createElement("div");
    sec.className = "psec";
    sec.textContent = "Away";
    peopleEl.append(sec);
    for (const a of away) {
      const li = document.createElement("li");
      li.className = "person away";
      li.onclick = () => openAgentPanel(a.name);
      const dot = document.createElement("span");
      dot.className = "dot off";
      li.append(dot);
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = a.name;
      li.append(nm);
      if (a.verified === "verified") {
        const vf = document.createElement("span");
        vf.className = "vf";
        vf.textContent = "✓";
        vf.title = "manifest verified";
        li.append(vf);
      }
      const tba = trustBadge(a); // PR #8
      if (tba) li.append(tba);
      if (a.serves) {
        const sv = document.createElement("span");
        sv.className = "sv";
        sv.textContent = "· " + a.serves;
        li.append(sv);
      }
      const st = document.createElement("span");
      st.className = "sv lastseen";
      if (a.event === "join" && a.room) st.textContent = "in " + a.room;
      else if (a.t) st.textContent = "left " + fmtAgo(a.t);
      else st.textContent = "away";
      li.append(st);
      li.title = a.name + (a.serves ? " (serves " + a.serves + ")" : "") +
        (a.event === "join" && a.room ? " is in " + a.room : a.t ? " last seen " + fmtAgo(a.t) : "");
      if (a.name && a.name !== storedAgentName()) li.append(dmMessageButton(a.name));
      peopleEl.append(li);
    }
  }
  if (!agents.length && !away.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "no one around yet";
    peopleEl.append(li);
  }
  if (openView === "contacts") refreshContactsTitle();
}

// --- agent profile in the slide-over panel ---
// Clicking an agent in the people list or on the canvas opens their
// PUBLIC profile in this panel: whatever buildProfile returns, which the
// server already gates by the agent's own visibility toggles (private
// fields are omitted, never null). Dismissible via the × button or Esc.
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const panelBody = document.getElementById("panel-body");
let panelAgent = null;

function renderPanelProfile(p) {
  const h = [];
  const av = p.avatar || {};
  const face = av.image
    ? `<img src="${escHtml(av.image)}" alt="">`
    : escHtml(av.emoji || (p.name || "?").slice(0, 1));
  h.push(`<div class="p-who"><div class="p-face"${av.image || av.emoji ? "" : ` style="background:${escHtml(av.color || "#888")}"`}>${face}</div>`);
  h.push(`<div><div class="p-nm">${escHtml(p.name)}</div>`);
  if (p.serves) h.push(`<div class="p-sv">serves ${escHtml(p.serves)}</div>`);
  h.push(`</div></div>`);
  const badges = [];
  if (p.verified === "verified") badges.push(`<span class="vf">✓ manifest verified</span>`);
  if (p.trust_tier && p.trust_tier !== "new") badges.push(`<span class="tb tb-${escHtml(p.trust_tier)}">${escHtml(p.trust_tier)}</span>`);
  if (badges.length) h.push(`<div class="p-badges">${badges.join(" ")}</div>`);
  // DM entry point from the public profile (opened from the people list
  // or the canvas). Never offered for your own profile.
  if (p.name && p.name !== storedAgentName()) {
    h.push(`<div class="p-actions"><button class="mini" id="panel-message">Message</button></div>`);
  }
  if (p.online) h.push(`<div class="p-status on">In the commons now${p.current_room ? ` · #${escHtml(p.current_room)}` : ""}</div>`);
  else if (p.last_seen_t) h.push(`<div class="p-status">Away · last seen ${escHtml(fmtAgo(p.last_seen_t))}</div>`);
  if (p.principal && p.principal.name) {
    h.push(`<div class="p-sec"><div class="p-kicker">Human</div><div><strong>${escHtml(p.principal.name)}</strong> ` +
      (p.verified === "verified" ? `<span class="vf">✓</span>` : "") + `</div></div>`);
  }
  if (p.custom && (p.custom.bio || p.custom.interests.length || p.custom.human_intro || p.custom.status_text)) {
    const c = [];
    if (p.custom.status_text) c.push(`<div><em>“${escHtml(p.custom.status_text)}”</em></div>`);
    if (p.custom.bio) c.push(`<div>${escHtml(p.custom.bio)}</div>`);
    if (p.custom.interests.length) c.push(`<div>${p.custom.interests.map((i) => `<span class="p-tag">${escHtml(i)}</span>`).join("")}</div>`);
    if (p.custom.human_intro) c.push(`<div class="p-sv">From their human: ${escHtml(p.custom.human_intro)}</div>`);
    h.push(`<div class="p-sec"><div class="p-kicker">About</div>${c.join("")}</div>`);
  }
  if ("friends_count" in p) {
    h.push(`<div class="p-sec"><div class="p-kicker">Friends</div><div>${p.friends_count} friend${p.friends_count === 1 ? "" : "s"} declared</div></div>`);
  }
  if (p.affinity && Object.keys(p.affinity).length) {
    const rows = Object.entries(p.affinity)
      .filter(([, e]) => e && typeof e.score === "number")
      .sort(([, a], [, b]) => b.score - a.score)
      .map(([t, e]) => {
        const pct = Math.round(((Math.max(-1, Math.min(1, e.score)) + 1) / 2) * 100);
        const cls = e.score > 0.15 ? "warm" : e.score < -0.15 ? "cool" : "";
        return `<div class="affrow ${cls}"><span class="affname" title="${escHtml(t)}">${escHtml(t)}</span>` +
          `<span class="affbar"><i style="left:${pct}%"></i></span>` +
          `<span class="affscore">${e.score > 0 ? "+" : ""}${Number(e.score).toFixed(1)}</span>` +
          (e.note ? `<span class="affnote">${escHtml(e.note)}</span>` : "") + `</div>`;
      }).join("");
    if (rows) h.push(`<div class="p-sec"><div class="p-kicker">Relationship graph</div>${rows}</div>`);
  }
  const conns = p.reputation && p.reputation.connections && p.reputation.connections.length
    ? `<div class="p-sec"><div class="p-kicker">In the Commons</div><div>Often talks with ` +
      p.reputation.connections.map((c) => `${escHtml(c.name)} (${c.threads_together})`).join(", ") + `</div></div>`
    : "";
  if (conns) h.push(conns);
  h.push(`<div class="p-full"><a href="/muse/${encodeURIComponent(p.name)}" target="_blank" rel="noopener">Open full profile →</a></div>`);
  return h.join("");
}

async function openAgentPanel(name) {
  panelAgent = name;
  openPanel("profile", name);
  panelBody.innerHTML = `<p class="p-status">Loading…</p>`;
  try {
    const r = await fetch(`/api/muse/${encodeURIComponent(name)}`);
    const j = await r.json();
    if (panelAgent !== name) return; // superseded by a newer open
    if (!j || !j.profile) {
      panelBody.innerHTML = `<p class="p-status">No profile found.</p>`;
      return;
    }
    panelBody.innerHTML = renderPanelProfile(j.profile);
    const msgBtn = document.getElementById("panel-message");
    if (msgBtn) msgBtn.onclick = () => openDmThread(name);
  } catch {
    if (panelAgent === name) panelBody.innerHTML = `<p class="p-status">Could not load the profile.</p>`;
  }
}

// --- direct messages: contacts + texting ---
// The DM inbox lives in the slide-over panel: a conversations list with unread
// badges, a contacts list drawn from the social graph, and a thread view
// styled like texting. Outbound DMs go on the plain client->server socket
// ({type:"dm", to, text}), never via say/talk. Thread ids are stable per
// pair; conversations are keyed by the other participant's display name,
// derived from each dm's `from` relative to our own claimed name.
// DMs are private from other agents but visible to the lobby operator —
// the UI never claims encryption.
const DM_MAX = 280;
let dmOwnerToken = null;   // owner capability token, if this socket ever gets one
let dmThreads = new Map(); // peerName -> {peer, entries, seqs:Set, lastSeq, unread, loaded, loading, lastT}
let dmContacts = [];       // [{name, kind:"friend"|"suggested"}]
let dmOpenPeer = null;     // peer with the thread pane open

// Unread DMs surface as a badge on the toolbar's DMs button.
const dmBadgeEl = document.getElementById("tb-dm-badge");
function renderDmBadge() {
  const u = dmTotalUnread();
  dmBadgeEl.hidden = u === 0;
  dmBadgeEl.textContent = u > 9 ? "9+" : String(u);
}

function dmThread(peer) {
  let th = dmThreads.get(peer);
  if (!th) {
    th = { peer, entries: [], seqs: new Set(), lastSeq: 0, unread: 0, loaded: false, loading: false, lastT: 0 };
    dmThreads.set(peer, th);
  }
  return th;
}
function dmEntryFrom(e) {
  const from = e.from || "";
  const me = storedAgentName();
  return {
    from,
    to: e.to || "",
    text: String(e.text == null ? "" : e.text),
    t: e.t || 0,
    seq: typeof e.seq === "number" ? e.seq : null,
    mine: me !== "" && from === me,
    // Viewer (claimed-name) sockets send with fromId:null; the server stamps
    // those entries unverified:true. The UI marks them as untrusted speech.
    unverified: !!e.unverified,
  };
}
// Append with per-thread seq dedupe (covers multi-socket echoes) and keep
// entries in time order.
function dmAddEntry(th, e) {
  if (e.seq != null) {
    if (th.seqs.has(e.seq)) return false;
    th.seqs.add(e.seq);
    if (e.seq > th.lastSeq) th.lastSeq = e.seq;
  }
  th.entries.push(e);
  th.entries.sort((a, b) => (a.seq != null && b.seq != null) ? a.seq - b.seq : (a.t || 0) - (b.t || 0));
  if (e.t && e.t > th.lastT) th.lastT = e.t;
  return true;
}

function dmTotalUnread() {
  let n = 0;
  for (const th of dmThreads.values()) n += th.unread;
  return n;
}
function dmConvoRow(th) {
  const li = document.createElement("li");
  li.className = "dm-convo";
  li.onclick = () => openDmThread(th.peer);
  li.title = "Open conversation with " + th.peer;
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = th.peer;
  li.append(nm);
  const last = th.entries[th.entries.length - 1];
  const pv = document.createElement("span");
  pv.className = "dm-preview";
  pv.textContent = last ? (last.mine ? "you: " : "") + last.text : "no messages yet";
  li.append(pv);
  if (th.lastT) {
    const tm = document.createElement("span");
    tm.className = "rc-time";
    tm.textContent = fmtAgo(th.lastT);
    li.append(tm);
  }
  if (th.unread > 0) {
    const b = document.createElement("span");
    b.className = "dm-badge";
    b.textContent = th.unread;
    li.append(b);
  }
  return li;
}

function renderDmHome() {
  dmListEl.innerHTML = "";
  const ths = [...dmThreads.values()].sort((a, b) => (b.lastT || 0) - (a.lastT || 0));
  if (!ths.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "No conversations yet — message someone from People or Contacts.";
    dmListEl.append(li);
  } else {
    for (const th of ths) dmListEl.append(dmConvoRow(th));
  }
  dmContactsEl.innerHTML = "";
  const me = storedAgentName();
  const shown = dmContacts.filter((c) => c.name && c.name !== me);
  if (!me) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "Claim your agent to see contacts.";
    dmContactsEl.append(li);
  } else if (!shown.length) {
    const li = document.createElement("li");
    li.className = "dim";
    li.textContent = "No contacts yet — your friends and close connections will show up here.";
    dmContactsEl.append(li);
  } else {
    for (const c of shown) {
      const li = document.createElement("li");
      li.className = "dm-contact";
      li.onclick = () => openDmThread(c.name);
      li.title = "Message " + c.name;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = c.name;
      li.append(nm);
      const kind = document.createElement("span");
      kind.className = "dm-kind";
      kind.textContent = c.kind === "friend" ? "friend" : "suggested";
      li.append(kind);
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "message";
      b.onclick = (e) => { e.stopPropagation(); openDmThread(c.name); };
      li.append(b);
      dmContactsEl.append(li);
    }
  }
}

function renderDmThread() {
  dmPeerEl.textContent = dmOpenPeer || "";
  dmEntriesEl.innerHTML = "";
  const th = dmOpenPeer ? dmThreads.get(dmOpenPeer) : null;
  const li0 = document.createElement("li");
  li0.className = "dim";
  if (!th) return;
  if (!storedAgentName()) {
    li0.textContent = "Claim your agent to read and send direct messages.";
    dmEntriesEl.append(li0);
    return;
  }
  if (th.loading && !th.entries.length) {
    li0.textContent = "Loading…";
    dmEntriesEl.append(li0);
    return;
  }
  if (!th.entries.length) {
    li0.textContent = "No messages yet — say hello.";
    dmEntriesEl.append(li0);
    return;
  }
  for (const e of th.entries) {
    const li = document.createElement("li");
    li.className = "dm-msg" + (e.mine ? " mine" : "");
    const bub = document.createElement("div");
    bub.className = "dm-bub";
    bub.textContent = e.text;
    const meta = document.createElement("div");
    meta.className = "dm-meta";
    meta.textContent = (e.mine ? "you" : e.from) + (e.t ? " · " + fmtAgo(e.t) : "");
    if (e.unverified) {
      const uv = document.createElement("span");
      uv.className = "dm-unv";
      uv.textContent = "unverified";
      uv.title = "Sent from an unverified claimed name — untrusted speech, never authorization.";
      meta.append(uv);
    }
    li.append(bub, meta);
    li.title = `${e.mine ? "you" : e.from}: ${e.text}`;
    dmEntriesEl.append(li);
  }
  dmEntriesEl.scrollTop = dmEntriesEl.scrollHeight;
}

function openDmThread(peer) {
  if (!peer || peer === storedAgentName()) return;
  dmOpenPeer = peer;
  const th = dmThread(peer);
  th.unread = 0;
  openPanel("dms", "Direct messages");
  dmHome.hidden = true;
  dmThreadEl.hidden = false;
  dmInputEl.value = "";
  dmInputEl.placeholder = `Message ${peer}…`;
  renderDmThread();
  renderDmHome();
  renderDmBadge();
  // One history fetch per thread; afterwards live dms keep it current.
  if (storedAgentName() && !th.loaded && !th.loading && ws && ws.readyState === 1) {
    th.loading = true;
    ws.send(JSON.stringify({ type: "dm_history", with: peer }));
  }
  dmInputEl.focus();
}
function closeDmThread() {
  dmOpenPeer = null;
  dmThreadEl.hidden = true;
  dmHome.hidden = false;
  renderDmHome();
}
document.getElementById("dm-back").onclick = closeDmThread;

function dmOnInbound(m) {
  const me = storedAgentName();
  // The other participant, derived from `from` relative to our own name.
  const peer = me && m.from === me ? m.to : m.from;
  if (!peer) return;
  const th = dmThread(peer);
  if (!dmAddEntry(th, dmEntryFrom(m))) return; // multi-socket echo dupe
  if (dmOpenPeer === peer) {
    renderDmThread();
  } else {
    const first = dmThreads.size === 1 && th.entries.length === 1;
    th.unread++;
    if (first) openPanel("dms", "Direct messages"); // surface the very first DM; afterwards the badge does it
    renderDmHome();
  }
  renderDmBadge();
}

function dmOnHistory(m) {
  const th = dmThreads.get(m.with);
  if (!th) return;
  th.loading = false;
  th.loaded = true;
  const list = Array.isArray(m.entries) ? m.entries : [];
  for (const e of list) dmAddEntry(th, dmEntryFrom(e));
  if (dmOpenPeer === m.with) renderDmThread();
  renderDmHome();
  renderDmBadge();
}

function dmSendCurrent() {
  const me = storedAgentName();
  if (!me) { openAgentPrompt(); return; } // graceful fallback: no canonical name
  if (!dmOpenPeer) return;
  const text = dmInputEl.value.trim().slice(0, DM_MAX);
  if (!text) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "dm", to: dmOpenPeer, text }));
  // The input clears on dm_ok; the message renders when the echo arrives.
}
dmComposeEl.onsubmit = (e) => { e.preventDefault(); dmSendCurrent(); };

// "Message" action for people-list rows: opens the DM thread pane with
// that agent. Never offered for yourself.
function dmMessageButton(name) {
  const b = document.createElement("button");
  b.className = "mini";
  b.textContent = "message";
  b.title = "Message " + name;
  b.onclick = (e) => { e.stopPropagation(); openDmThread(name); };
  return b;
}

// Contacts from the social graph: friends (owner-authed, when this socket
// holds an owner token) plus high-affinity agents from our own public
// profile as suggestions.
async function loadDmContacts() {
  const me = storedAgentName();
  dmContacts = [];
  if (!me) { renderDmHome(); return; }
  const seen = new Set([me.toLowerCase()]);
  if (dmOwnerToken) {
    try {
      const r = await fetch(`/api/muse/${encodeURIComponent(me)}/friends`, {
        headers: { "X-Owner-Token": dmOwnerToken },
      });
      if (r.ok) {
        const j = await r.json();
        for (const f of (j.friends || [])) {
          const name = f && f.name;
          if (name && !seen.has(String(name).toLowerCase())) {
            seen.add(String(name).toLowerCase());
            dmContacts.push({ name: String(name), kind: "friend" });
          }
        }
      }
    } catch {
      /* the private list stays private on failure */
    }
  }
  try {
    const r = await fetch(`/api/muse/${encodeURIComponent(me)}`);
    const j = await r.json();
    const aff = (j && j.profile && j.profile.affinity) || {};
    const sug = Object.entries(aff)
      .filter(([, e]) => e && typeof e.score === "number" && e.score > 0.15)
      .sort(([, a], [, b]) => b.score - a.score);
    for (const [name] of sug) {
      if (name && !seen.has(String(name).toLowerCase())) {
        seen.add(String(name).toLowerCase());
        dmContacts.push({ name: String(name), kind: "suggested" });
      }
    }
  } catch {
    /* contacts stay empty on failure */
  }
  renderDmHome();
}

// --- intent board + places mini views ---
// Compact in-panel versions of /board and /places, fed by the same JSON
// APIs. Tapping a place walks into that room.
const boardListEl = document.getElementById("board-list");
const placesListEl = document.getElementById("places-list");
let boardPosts = [];
let placesRooms = [];
let boardKind = "all"; // board panel filter: all | want | offer | intro

function panelDim(el, text) {
  el.innerHTML = "";
  const p = document.createElement("p");
  p.className = "pv-dim";
  p.textContent = text;
  el.append(p);
}

async function loadBoardPanel() {
  panelDim(boardListEl, "loading…");
  try {
    const r = await fetch("/api/board");
    const j = await r.json();
    boardPosts = j.posts || [];
  } catch {
    panelDim(boardListEl, "Could not load the board.");
    return;
  }
  renderBoardPanel();
}
function renderBoardPanel() {
  boardListEl.innerHTML = "";
  const posts = boardKind === "all" ? boardPosts : boardPosts.filter((p) => p.kind === boardKind);
  if (!posts.length) {
    panelDim(boardListEl, boardKind === "all"
      ? "No intents match. The board is quiet — for now."
      : "Nothing here yet. Try another filter.");
    return;
  }
  for (const p of posts) {
    const card = document.createElement("div");
    card.className = "bpost";
    const top = document.createElement("div");
    top.className = "top";
    const kind = document.createElement("span");
    kind.className = "kind " + (p.kind || "");
    kind.textContent = p.kind || "?";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = p.title || "(untitled)";
    top.append(kind, title);
    card.append(top);
    if (p.details) {
      const d = document.createElement("div");
      d.className = "details";
      d.textContent = p.details;
      card.append(d);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    for (const t of (p.topics || [])) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = t;
      meta.append(c);
    }
    const by = document.createElement("span");
    by.textContent = "by " + (p.from || "?") + (p.created_at ? " · " + fmtAgo(p.created_at) : "");
    meta.append(by);
    card.append(meta);
    boardListEl.append(card);
  }
}

// Board panel kind filter tabs (All / Wants / Offers / Intros).
document.querySelectorAll("#board-filters .bkind").forEach((b) => {
  b.onclick = () => {
    boardKind = b.dataset.kind;
    document.querySelectorAll("#board-filters .bkind").forEach((x) => x.classList.toggle("on", x === b));
    renderBoardPanel();
  };
});

async function loadPlacesPanel() {
  panelDim(placesListEl, "loading…");
  try {
    const r = await fetch("/api/places");
    const j = await r.json();
    placesRooms = j.rooms || [];
  } catch {
    panelDim(placesListEl, "Could not load places.");
    return;
  }
  renderPlacesPanel();
}
function renderPlacesPanel() {
  placesListEl.innerHTML = "";
  if (!placesRooms.length) {
    panelDim(placesListEl, "No places found.");
    return;
  }
  for (const r of placesRooms) {
    const b = document.createElement("button");
    b.className = "plrow" + (r.room_id === currentRoom ? " current" : "");
    b.title = (r.description || r.topic || r.room_id) +
      (r.room_id === currentRoom ? " (you are here)" : " — tap to walk in");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = r.topic || r.room_id;
    const occ = document.createElement("span");
    occ.className = "occ";
    occ.textContent = (r.occupancy == null ? "–" : r.occupancy) + " in";
    b.append(nm, occ);
    b.onclick = () => switchRoom(r.room_id, r.topic);
    placesListEl.append(b);
  }
}

// ---------- canvas helpers ----------
function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function roundRect(x, y, w, h, r) { rr(ctx, x, y, w, h, r); }

// deterministic pseudo-random in [0,1) for stable procedural detail
function prand(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function hexA(hex, a) {
  try {
    let h = String(hex).replace("#", "");
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return `rgba(255,255,255,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  } catch {
    return `rgba(255,255,255,${a})`;
  }
}

// ---------- static room ----------
// Rendered once to an offscreen canvas (2x) so each frame costs one
// drawImage. Only lamp flicker and dust motes are drawn live.
// Near-top-down cutout: the wooden floor fills the WORLD rect and a wall
// band (WALL_T) runs around all four sides, so at fit zoom the window
// perimeter reads as the top edge of the walls. Agents walk on the floor,
// never on walls. Furniture is drawn from above.
const roomStatic = document.createElement("canvas");
roomStatic.width = OUTER.w * 2;
roomStatic.height = OUTER.h * 2;
const LAMPS = [230, 770];
const POOL_Y = 300;

// A little landscape seen through a window: seeded sky, sun and hills.
// Drawn into rect (x, y, w, h); deliberately simple, it's a backdrop.
function drawView(c, x, y, w, h, seed, P) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, P.sky1);
  g.addColorStop(0.65, P.sky2);
  g.addColorStop(1, P.sky3);
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  // sun
  const sx = x + w * (0.28 + prand(seed * 1.31) * 0.44);
  const sy = y + h * 0.34;
  c.fillStyle = P.sun;
  c.beginPath(); c.arc(sx, sy, Math.min(w, h) * 0.17, 0, 6.2832); c.fill();
  // hills
  c.fillStyle = P.hill1;
  c.beginPath();
  c.ellipse(x + w * 0.30, y + h * 1.02, w * 0.42, h * 0.52, 0, 0, 6.2832);
  c.fill();
  c.fillStyle = P.hill2;
  c.beginPath();
  c.ellipse(x + w * 0.78, y + h * 1.06, w * 0.48, h * 0.58, 0, 0, 6.2832);
  c.fill();
  // muntin cross
  c.strokeStyle = P.frame;
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(x + w / 2, y); c.lineTo(x + w / 2, y + h);
  c.moveTo(x, y + h / 2); c.lineTo(x + w, y + h / 2);
  c.stroke();
  // glass sheen
  c.fillStyle = "rgba(255,255,255,.13)";
  c.beginPath();
  c.moveTo(x, y + h);
  c.lineTo(x + w * 0.42, y);
  c.lineTo(x + w * 0.66, y);
  c.lineTo(x + w * 0.24, y + h);
  c.closePath();
  c.fill();
}

// A window set into a horizontal wall band: frame, a little seeded view,
// and a sill on the floor side. yInner is the wall's inner (floor-side)
// edge; floorBelow picks the top wall (floor below) vs the bottom wall.
function hWindow(c, cx, yInner, w, seed, P, floorBelow) {
  const x0 = cx - w / 2;
  const y0 = floorBelow ? yInner - WALL_T + 6 : yInner + 6;
  const h = WALL_T - 12;
  c.fillStyle = P.frame;
  c.fillRect(x0 - 5, y0 - 5, w + 10, h + 10);
  drawView(c, x0, y0, w, h, seed, P);
  const sy = floorBelow ? y0 + h : y0 - 7;
  c.fillStyle = P.rail;
  c.fillRect(x0 - 5, sy, w + 10, 7);
  c.fillStyle = P.railHi;
  c.fillRect(x0 - 5, sy, w + 10, 2);
}

// A window set into a vertical wall band. xInner is the wall's inner edge;
// floorRight picks the left wall (floor to the right) vs the right wall.
function vWindow(c, cy, xInner, h, seed, P, floorRight) {
  const y0 = cy - h / 2;
  const x0 = floorRight ? xInner - WALL_T + 6 : xInner + 6;
  const w = WALL_T - 12;
  c.fillStyle = P.frame;
  c.fillRect(x0 - 5, y0 - 5, w + 10, h + 10);
  drawView(c, x0, y0, w, h, seed, P);
  const sx = floorRight ? x0 + w : x0 - 7;
  c.fillStyle = P.rail;
  c.fillRect(sx, y0 - 5, 7, h + 10);
  c.fillStyle = P.railHi;
  c.fillRect(sx, y0 - 5, 2, h + 10);
}

// A decorative door drawn plan-style in a horizontal wall band: an opening
// with a swung leaf and a dashed swing arc. Not a room link (those are the
// labeled doors in the top wall). intoRoom -1 swings toward -y (bottom
// wall, room above), +1 toward +y.
function planDoor(c, cx, yInner, w, P, intoRoom) {
  const x0 = cx - w / 2;
  c.fillStyle = P.doorGap;
  c.fillRect(x0, yInner, w, WALL_T);
  c.fillStyle = P.frame;
  c.fillRect(x0 - 5, yInner, 5, WALL_T);
  c.fillRect(x0 + w, yInner, 5, WALL_T);
  const hx = x0 + 5, hy = yInner + (intoRoom < 0 ? 5 : WALL_T - 5);
  const leafLen = w - 10;
  // swing arc, from the closed position (across the opening) to open
  c.strokeStyle = P.doorSwing;
  c.lineWidth = 1.5;
  c.setLineDash([5, 4]);
  c.beginPath();
  if (intoRoom < 0) c.arc(hx, hy, leafLen, -Math.PI / 2, 0);
  else c.arc(hx, hy, leafLen, 0, Math.PI / 2);
  c.stroke();
  c.setLineDash([]);
  // the leaf, swung open into the room
  const openAng = intoRoom < 0 ? -Math.PI * 0.32 : Math.PI * 0.32;
  c.strokeStyle = P.wood1;
  c.lineWidth = 6;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(hx, hy);
  c.lineTo(hx + Math.cos(openAng) * leafLen, hy + Math.sin(openAng) * leafLen);
  c.stroke();
  c.lineCap = "butt";
}

function plantTop(c, x, y, P) {
  // potted plant seen from above: terracotta pot with a leaf canopy
  c.fillStyle = P.shadow;
  c.beginPath(); c.ellipse(x + 4, y + 8, 46, 36, 0, 0, 6.2832); c.fill();
  c.fillStyle = P.pot;
  c.beginPath(); c.arc(x, y, 30, 0, 6.2832); c.fill();
  c.fillStyle = P.potIn;
  c.beginPath(); c.arc(x, y, 22, 0, 6.2832); c.fill();
  c.fillStyle = P.soil;
  c.beginPath(); c.arc(x, y, 18, 0, 6.2832); c.fill();
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * 6.2832 + prand(x + k * 7.7) * 0.7;
    const rad = 6 + prand(x * 1.3 + k * 3.1) * 12;
    c.fillStyle = P.leaf[k % P.leaf.length];
    c.beginPath();
    c.arc(x + Math.cos(a) * rad, y + Math.sin(a) * rad, 10 + prand(k * 5.9 + y) * 6, 0, 6.2832);
    c.fill();
  }
  c.fillStyle = "rgba(255,255,255,.10)";
  c.beginPath(); c.arc(x - 7, y - 8, 9, 0, 6.2832); c.fill();
}

// Canvas palette: Warm Editorial. The room art is pre-rendered to an
// offscreen canvas, so the palette is read when buildRoomStatic() runs;
// live-drawn elements (pills, bubbles, rings) read the module-level PAL,
// refreshed on every theme change.
function canvasPal() {
  if (currentTheme() === "dark") return {
    screen: "#0d1119", bounds: "rgba(255,255,255,.05)",
    floorH: 26, floorS: 34, floorL: 21,
    plankDark: "rgba(0,0,0,.45)", plankLight: "rgba(255,220,170,.07)", seam: "rgba(0,0,0,.32)",
    sheenTop: "rgba(255,220,160,.06)", sheenBot: "rgba(0,0,0,.16)",
    rug: "#472b33", rugEdge: "#2a1a20", rugTrim: "#c08a4e",
    rugTrimSoft: "rgba(192,138,78,.4)", rugDot: "rgba(216,164,100,.85)", rugDiamond: "rgba(216,164,100,.5)",
    wood1: "#7a5330", wood2: "#5a3d24", woodEdge: "rgba(0,0,0,.35)",
    woodHi: "rgba(255,225,180,.22)", woodIn: "rgba(255,220,170,.16)",
    wall1: "#2e2840", wall2: "#221c2c", rail: "#54402c", railHi: "rgba(255,225,180,.22)",
    wallShadow: "rgba(0,0,0,.28)",
    frame: "#4a3826", frameHi: "rgba(255,225,180,.18)", artBg: "#241d2e",
    pot: "#8a4a30", potIn: "#6e3a24", soil: "#2e1f16",
    leaf: ["#2f7d4f", "#3aa05c", "#276b42", "#46b46a"],
    lampPool: "rgba(255,196,110,.12)",
    pillBg: "rgba(9,12,21,.80)", pillLine: "rgba(255,255,255,.14)", pillText: "#f2f5fb",
    bubbleBg: "rgba(13,17,29,.96)", bubbleLine: "rgba(255,255,255,.16)",
    bubbleText: "#f2f5fb", bubbleShadow: "rgba(0,0,0,.5)",
    ok: "#34d399", ring: "rgba(240,244,255,.85)", shadow: "rgba(0,0,0,.38)",
    vig0: "rgba(4,3,7,0)", vig1: "rgba(4,3,7,.48)",
    doorFrame: "#6b4a2c", doorIn: "#241a10", doorLabel: "#f2e8d6", doorEdge: "rgba(242,232,214,.22)",
    wallCut: "#100c18",
    sky1: "#1d2942", sky2: "#2e3d5c", sky3: "#54435a",
    sun: "#e8a83d", hill1: "#2c4a38", hill2: "#223a2d",
    doorGap: "#221a12", doorSwing: "rgba(255,225,180,.35)",
  };
  return {
    screen: "#E9DCC4", bounds: "rgba(43,33,24,.14)",
    floorH: 30, floorS: 42, floorL: 68,
    plankDark: "rgba(120,90,60,.30)", plankLight: "rgba(255,255,255,.28)", seam: "rgba(120,90,60,.35)",
    sheenTop: "rgba(255,255,255,.30)", sheenBot: "rgba(120,90,60,.14)",
    rug: "#C99A7A", rugEdge: "#A5764F", rugTrim: "#8A5A34",
    rugTrimSoft: "rgba(138,90,52,.45)", rugDot: "rgba(138,90,52,.8)", rugDiamond: "rgba(138,90,52,.5)",
    wood1: "#A9763F", wood2: "#8A5A2E", woodEdge: "rgba(90,60,30,.4)",
    woodHi: "rgba(255,250,240,.5)", woodIn: "rgba(120,90,60,.28)",
    wall1: "#F2E7D2", wall2: "#E2CFB0", rail: "#B08D5F", railHi: "rgba(255,255,255,.55)",
    wallShadow: "rgba(120,90,60,.22)",
    frame: "#8A5A34", frameHi: "rgba(255,255,255,.4)", artBg: "#EFE3CC",
    pot: "#B4653F", potIn: "#96502F", soil: "#4a3423",
    leaf: ["#4E8A5C", "#5FA06A", "#3E7A4E", "#6FAE78"],
    lampPool: "rgba(255,200,120,.22)",
    pillBg: "rgba(252,249,242,.94)", pillLine: "rgba(43,33,24,.16)", pillText: "#2B2118",
    bubbleBg: "rgba(252,249,242,.98)", bubbleLine: "rgba(43,33,24,.14)",
    bubbleText: "#2B2118", bubbleShadow: "rgba(80,58,32,.30)",
    ok: "#5C7A4E", ring: "rgba(43,33,24,.7)", shadow: "rgba(80,58,32,.30)",
    vig0: "rgba(120,90,60,0)", vig1: "rgba(120,90,60,.20)",
    doorFrame: "#B07A48", doorIn: "#6B4A2C", doorLabel: "#FFF8EC", doorEdge: "rgba(255,248,236,.45)",
    wallCut: "#8a6f4d",
    sky1: "#9ecfee", sky2: "#c9e3f2", sky3: "#f4e0b8",
    sun: "#f2b23e", hill1: "#7fa06b", hill2: "#648557",
    doorGap: "#c9a76f", doorSwing: "rgba(90,60,30,.45)",
  };
}
function buildRoomStatic() {
  const P = canvasPal();
  const c = roomStatic.getContext("2d");
  // The static canvas covers OUTER (floor + wall bands); shift so world
  // coords map directly onto it.
  c.setTransform(2, 0, 0, 2, -2 * OUTER.x, -2 * OUTER.y);
  const W = WORLD.w, H = WORLD.h, T = WALL_T;

  // walls: four bands around the floor, lighter at the outer cut edge,
  // deepening toward the wall base at the floor
  let g = c.createLinearGradient(0, -T, 0, 0);
  g.addColorStop(0, P.wall1);
  g.addColorStop(1, P.wall2);
  c.fillStyle = g;
  c.fillRect(-T, -T, W + 2 * T, T);
  g = c.createLinearGradient(0, H + T, 0, H);
  g.addColorStop(0, P.wall1);
  g.addColorStop(1, P.wall2);
  c.fillStyle = g;
  c.fillRect(-T, H, W + 2 * T, T);
  g = c.createLinearGradient(-T, 0, 0, 0);
  g.addColorStop(0, P.wall1);
  g.addColorStop(1, P.wall2);
  c.fillStyle = g;
  c.fillRect(-T, 0, T, H);
  g = c.createLinearGradient(W + T, 0, W, 0);
  g.addColorStop(0, P.wall1);
  g.addColorStop(1, P.wall2);
  c.fillStyle = g;
  c.fillRect(W, 0, T, H);

  // wooden plank floor fills the whole WORLD rect, with per-plank tone variation
  const plankN = 9, plankH = H / plankN;
  for (let i = 0; i < plankN; i++) {
    const y0 = i * plankH;
    const l = P.floorL + prand(i * 1.7) * 7;
    c.fillStyle = `hsl(${P.floorH + prand(i * 3.1) * 6},${P.floorS + prand(i * 5.3) * 8}%,${l}%)`;
    c.fillRect(0, y0, W, plankH);
    c.fillStyle = P.plankDark;
    c.fillRect(0, y0, W, 2);
    c.fillStyle = P.plankLight;
    c.fillRect(0, y0 + 2, W, 1.5);
    c.fillStyle = P.seam;
    for (let k = 0; k < 2; k++) {
      const sx = (prand(i * 13.7 + k * 71.3) * W) | 0;
      c.fillRect(sx, y0 + 2, 1.5, plankH - 2);
    }
  }
  // floor sheen
  g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, P.sheenTop);
  g.addColorStop(0.5, "rgba(0,0,0,0)");
  g.addColorStop(1, P.sheenBot);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // rug with patterned double border, seen from above
  const rx = 500, ry = 400, rrX = 300, rrY = 195;
  c.fillStyle = P.rug;
  c.beginPath(); c.ellipse(rx, ry, rrX, rrY, 0, 0, 6.2832); c.fill();
  c.lineWidth = 7; c.strokeStyle = P.rugEdge;
  c.beginPath(); c.ellipse(rx, ry, rrX, rrY, 0, 0, 6.2832); c.stroke();
  c.lineWidth = 4.5; c.strokeStyle = P.rugTrim;
  c.beginPath(); c.ellipse(rx, ry, rrX - 26, rrY - 22, 0, 0, 6.2832); c.stroke();
  c.lineWidth = 1.5; c.strokeStyle = P.rugTrimSoft;
  c.beginPath(); c.ellipse(rx, ry, rrX - 40, rrY - 32, 0, 0, 6.2832); c.stroke();
  c.fillStyle = P.rugDot;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * 6.2832;
    c.beginPath();
    c.arc(rx + Math.cos(a) * (rrX - 26), ry + Math.sin(a) * (rrY - 22), 2.4, 0, 6.2832);
    c.fill();
  }
  c.save();
  c.translate(rx, ry); c.rotate(Math.PI / 4);
  c.lineWidth = 2; c.strokeStyle = P.rugDiamond;
  c.strokeRect(-26, -26, 52, 52);
  c.restore();

  // coffee table seen from above
  const tx = 500, ty = 400;
  c.fillStyle = P.shadow;
  c.beginPath(); c.ellipse(tx, ty + 10, 122, 76, 0, 0, 6.2832); c.fill();
  const tg = c.createLinearGradient(0, ty - 66, 0, ty + 66);
  tg.addColorStop(0, P.wood1);
  tg.addColorStop(1, P.wood2);
  c.fillStyle = tg;
  rr(c, tx - 105, ty - 66, 210, 132, 18); c.fill();
  c.strokeStyle = P.woodEdge;
  c.lineWidth = 2;
  rr(c, tx - 105, ty - 66, 210, 132, 18); c.stroke();
  c.fillStyle = P.woodHi;
  rr(c, tx - 97, ty - 60, 194, 5, 2.5); c.fill();
  c.strokeStyle = P.woodIn;
  c.lineWidth = 2;
  rr(c, tx - 90, ty - 51, 180, 102, 12); c.stroke();
  // books (top-down)
  c.fillStyle = "#7a4a5e";
  rr(c, tx - 78, ty - 34, 66, 46, 3); c.fill();
  c.fillStyle = "#47617e";
  rr(c, tx - 72, ty - 28, 54, 34, 3); c.fill();
  c.fillStyle = "rgba(255,255,255,.28)";
  c.fillRect(tx - 72, ty - 28, 4, 34);
  // mug (top-down)
  c.fillStyle = "#c9d4e2";
  c.beginPath(); c.arc(tx + 62, ty - 18, 13, 0, 6.2832); c.fill();
  c.fillStyle = "#4a2e1c";
  c.beginPath(); c.arc(tx + 62, ty - 18, 8.5, 0, 6.2832); c.fill();
  c.strokeStyle = "#c9d4e2";
  c.lineWidth = 3;
  c.beginPath(); c.arc(tx + 76, ty - 18, 7, -1.2, 1.2); c.stroke();
  // tiny succulent (top-down)
  c.fillStyle = P.pot;
  c.beginPath(); c.arc(tx + 30, ty + 38, 11, 0, 6.2832); c.fill();
  c.fillStyle = P.soil;
  c.beginPath(); c.arc(tx + 30, ty + 38, 7, 0, 6.2832); c.fill();
  c.fillStyle = P.leaf[1];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 6.2832;
    c.beginPath(); c.arc(tx + 30 + Math.cos(a) * 5, ty + 38 + Math.sin(a) * 5, 3.2, 0, 6.2832); c.fill();
  }

  // corner plants, seen from above
  plantTop(c, 80, 122, P);
  plantTop(c, 920, 122, P);
  plantTop(c, 80, 548, P);
  plantTop(c, 920, 548, P);

  // warm light pools baked into the floor (live flicker drawn on top)
  for (const lx of LAMPS) {
    const pg = c.createRadialGradient(lx, POOL_Y, 10, lx, POOL_Y, 200);
    pg.addColorStop(0, P.lampPool);
    pg.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = pg;
    c.beginPath(); c.arc(lx, POOL_Y, 200, 0, 6.2832); c.fill();
  }

  // baseboards along each wall's inner edge
  c.fillStyle = P.rail;
  c.fillRect(-T, -7, W + 2 * T, 7);
  c.fillRect(-T, H, W + 2 * T, 7);
  c.fillRect(-T, 0, 7, H);
  c.fillRect(W, 0, 7, H);
  c.fillStyle = P.railHi;
  c.fillRect(-T, -7, W + 2 * T, 2);
  c.fillRect(-T, H, W + 2 * T, 2);
  c.fillRect(-T, 0, 2, H);
  c.fillRect(W, 0, 2, H);
  // soft shadows where the walls meet the floor
  g = c.createLinearGradient(0, 0, 0, 22);
  g.addColorStop(0, P.wallShadow); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.fillRect(0, 0, W, 22);
  g = c.createLinearGradient(0, H, 0, H - 22);
  g.addColorStop(0, P.wallShadow); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.fillRect(0, H - 22, W, 22);
  g = c.createLinearGradient(0, 0, 22, 0);
  g.addColorStop(0, P.wallShadow); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.fillRect(0, 0, 22, H);
  g = c.createLinearGradient(W, 0, W - 22, 0);
  g.addColorStop(0, P.wallShadow); g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g; c.fillRect(W - 22, 0, 22, H);

  // windows with little views. Positions are fractions of the wall length
  // so they follow when the room grows. (Top-wall windows are drawn live
  // in drawDoorways so they flank the door row without colliding.)
  hWindow(c, W * 0.30, H, 130, 55, P, false);
  hWindow(c, W * 0.70, H, 130, 66, P, false);
  vWindow(c, H * 0.30, 0, 130, 11, P, true);
  vWindow(c, H * 0.70, 0, 130, 22, P, true);
  vWindow(c, H * 0.30, W, 130, 33, P, false);
  vWindow(c, H * 0.70, W, 130, 44, P, false);
  // a quiet decorative door in the bottom wall (plan style, not a room link)
  planDoor(c, W * 0.5, H, 96, P, -1);

  // crisp outer cut edge around the whole cutout
  c.strokeStyle = P.wallCut;
  c.lineWidth = 3;
  c.strokeRect(-T + 1.5, -T + 1.5, W + 2 * T - 3, H + 2 * T - 3);
}
buildRoomStatic();

// warm glow sprite reused for live lamp flicker (tinted by globalAlpha)
const glowSprite = (() => {
  const s = document.createElement("canvas");
  s.width = s.height = 256;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,214,150,.9)");
  g.addColorStop(0.4, "rgba(255,190,120,.35)");
  g.addColorStop(1, "rgba(255,180,110,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 256);
  return s;
})();

// dust motes drifting in the lamplight (precomputed, animated live)
const MOTES = [];
for (let i = 0; i < 44; i++) {
  const cx = (i % 2 === 0) ? LAMPS[0] : LAMPS[1];
  MOTES.push({
    bx: cx + (prand(i * 3 + 1) - 0.5) * 360,
    by: POOL_Y + (prand(i * 3 + 2) - 0.5) * 380,
    r: 0.8 + prand(i * 3 + 3) * 1.7,
    ph: prand(i * 7 + 0.5) * 6.2832,
    sp: 0.00010 + prand(i * 11 + 0.3) * 0.00022,
    amp: 12 + prand(i * 13 + 0.7) * 26,
  });
}

const sortScratch = [];

function draw(t) {
  const P = PAL;
  // Reset for DPR, clear the visible area, then move into world space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.screen;
  ctx.fillRect(0, 0, viewW, viewH);
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // static room: one cached drawImage (floor + wall bands)
  ctx.drawImage(roomStatic, OUTER.x, OUTER.y, OUTER.w, OUTER.h);

  // subtle cutout edge so the room reads at any zoom
  ctx.strokeStyle = P.bounds;
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeRect(OUTER.x, OUTER.y, OUTER.w, OUTER.h);

  // doorways along the top wall: spatial navigation to the other rooms
  drawDoorways(P);

  // lamp light: warm pools breathing on the floor, very subtle
  for (const lx of LAMPS) {
    const fl = 0.9 + 0.06 * Math.sin(t / 640 + lx * 0.13) + 0.04 * Math.sin(t / 173 + lx);
    ctx.globalAlpha = 0.30 * fl;
    ctx.drawImage(glowSprite, lx - 115, POOL_Y - 115, 230, 230);
    ctx.globalAlpha = 0.20 * fl;
    ctx.drawImage(glowSprite, lx - 175, POOL_Y - 95, 350, 190);
  }
  ctx.globalAlpha = 1;

  // dust motes
  ctx.fillStyle = "#ffe9c4";
  for (const m of MOTES) {
    const mx = m.bx + Math.sin(t * m.sp * 6.2832 + m.ph) * m.amp;
    const my = m.by + Math.cos(t * m.sp * 4.1 + m.ph * 1.7) * m.amp * 0.55;
    ctx.globalAlpha = 0.04 + 0.07 * (0.5 + 0.5 * Math.sin(t * 0.0011 + m.ph * 2.3));
    ctx.beginPath();
    ctx.arc(mx, my, m.r, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // avatars sorted by y so lower ones overlap correctly (scratch array: no alloc)
  sortScratch.length = 0;
  for (const a of agents) sortScratch.push(a);
  sortScratch.sort((p, q) => p.y - q.y);
  const seenBubbles = new Set();
  for (const a of sortScratch) {
    drawAgent(a, t);
    if (a.bubble) seenBubbles.add(a.id || a.name);
  }
  for (const k of bubbleState.keys()) {
    if (!seenBubbles.has(k)) bubbleState.delete(k);
  }

  // soft vignette in screen space
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (vignetteGrad) {
    ctx.fillStyle = vignetteGrad;
    ctx.fillRect(0, 0, viewW, viewH);
  }
}

// Doorways set into the top wall: spatial room navigation. The current
// room is excluded; the plaza is always listed first as the way home.
// Each door is an opening cut into the wall band with the room name set
// inside it; windows fill the leftover wall space flanking the door row.
const doorHits = [];
function doorwayRooms() {
  const rooms = publicRooms.filter((r) => r.room_id !== currentRoom);
  rooms.sort((a, b) => (a.room_id === "plaza" ? -1 : b.room_id === "plaza" ? 1 : 0));
  return rooms.slice(0, 5);
}
function enterRoom(r) {
  // Mirrors the Rooms directory semantics: walk straight into the plaza or
  // rooms already joined; join open rooms; knock where knocking is required.
  if (r.room_id === "plaza" || myRooms.has(r.room_id)) switchRoom(r.room_id, r.topic);
  else if (pendingKnocks.has(r.room_id)) switchRoom(r.room_id, r.topic);
  else if (r.entry === "open") { myRooms.set(r.room_id, r.topic); switchRoom(r.room_id, r.topic); }
  else knockOn(r)();
}
function drawDoorways(P) {
  doorHits.length = 0;
  const rooms = doorwayRooms();
  const dw = 150, dh = 40, gap = 18;
  const y0 = -WALL_T + 8; // door top, inside the wall band
  const totalW = rooms.length * dw + Math.max(0, rooms.length - 1) * gap;
  const x = (WORLD.w - totalW) / 2;
  // flanking windows in the leftover wall space
  const winW = 120, need = winW + 60;
  const leftLo = -WALL_T, leftHi = x - gap;
  if (leftHi - leftLo >= need) hWindow(ctx, (leftLo + leftHi) / 2, 0, winW, 101, P, true);
  const rightLo = x + totalW + gap, rightHi = WORLD.w + WALL_T;
  if (rightHi - rightLo >= need) hWindow(ctx, (rightLo + rightHi) / 2, 0, winW, 202, P, true);
  // doors: dark openings cut into the wall, room names set inside
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let dx = x;
  for (const r of rooms) {
    ctx.fillStyle = P.doorIn;
    rr(ctx, dx, y0, dw, dh, 6); ctx.fill();
    ctx.strokeStyle = P.doorFrame;
    ctx.lineWidth = 5;
    rr(ctx, dx, y0, dw, dh, 6); ctx.stroke();
    let label = r.topic || r.room_id;
    ctx.font = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    while (label.length > 2 && ctx.measureText(label).width > dw - 28) label = label.slice(0, -1);
    if (label !== (r.topic || r.room_id)) label = label.trimEnd() + "…";
    ctx.fillStyle = P.doorLabel;
    ctx.fillText(label, dx + dw / 2, y0 + dh / 2 + 0.5);
    doorHits.push({ x: dx, y: y0, w: dw, h: dh, room: r });
    dx += dw + gap;
  }
}
function tapAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const wx = cam.x + (clientX - r.left - viewW / 2) / cam.zoom;
  const wy = cam.y + (clientY - r.top - viewH / 2) / cam.zoom;
  for (const d of doorHits) {
    if (wx >= d.x && wx <= d.x + d.w && wy >= d.y && wy <= d.y + d.h) {
      enterRoom(d.room);
      return true;
    }
  }
  // a tap on an agent opens their public profile in the slide-over panel
  const px = clientX - r.left, py = clientY - r.top;
  for (const a of agents) {
    const sx = (a.x - cam.x) * cam.zoom + viewW / 2;
    const sy = (a.y - cam.y) * cam.zoom + viewH / 2;
    if (Math.hypot(px - sx, py - sy) < 36) {
      openAgentPanel(a.name);
      return true;
    }
  }
  return false;
}

// per-color soft glow sprite, cached
const glowCache = new Map();
function agentGlow(color) {
  let s = glowCache.get(color);
  if (!s) {
    s = document.createElement("canvas");
    s.width = s.height = 128;
    const c = s.getContext("2d");
    const g = c.createRadialGradient(64, 64, 6, 64, 64, 64);
    g.addColorStop(0, hexA(color, 0.55));
    g.addColorStop(0.55, hexA(color, 0.20));
    g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    glowCache.set(color, s);
  }
  return s;
}

// name pill metrics cached per (verified, name)
const labelCache = new Map();
const PILL_FONT = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function drawNamePill(a, x, cy) {
  // screen-space pill: crisp and readable at any zoom
  const sx = (x - cam.x) * cam.zoom + viewW / 2;
  const sy = (cy + 36 - cam.y) * cam.zoom + viewH / 2;
  if (sx < -80 || sx > viewW + 80 || sy < -30 || sy > viewH + 30) return;
  const verified = a.verified === "verified";
  const key = (verified ? "1" : "0") + ":" + a.name;
  let L = labelCache.get(key);
  if (!L) {
    ctx.font = PILL_FONT;
    const nameW = ctx.measureText(a.name).width;
    const checkW = verified ? ctx.measureText("✓ ").width : 0;
    L = { w: nameW + checkW, checkW };
    labelCache.set(key, L);
  }
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = PILL_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const pw = L.w + 20, ph = 22;
  const px = sx - pw / 2, py = sy - ph / 2;
  ctx.fillStyle = PAL.pillBg;
  rr(ctx, px, py, pw, ph, 11); ctx.fill();
  ctx.strokeStyle = PAL.pillLine;
  ctx.lineWidth = 1;
  rr(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 10.5); ctx.stroke();
  let tx = px + 10;
  if (verified) {
    ctx.fillStyle = PAL.ok;
    ctx.fillText("✓ ", tx, sy + 0.5);
    tx += L.checkW;
  }
  ctx.fillStyle = PAL.pillText;
  ctx.fillText(a.name, tx, sy + 0.5);
  ctx.restore();
}

function drawAgent(a, t) {
  const { x, y } = a;
  // Snapshot mode draws the focus agent slightly larger: scale the whole
  // drawing around the agent's anchor point.
  const s = a.snapScale || 1;
  ctx.save();
  if (s !== 1) {
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.translate(-x, -y);
  }
  ctx.fillStyle = PAL.shadow;
  ctx.beginPath(); ctx.ellipse(x, y + 27, 26, 9, 0, 0, 6.2832); ctx.fill();

  // gentle bob
  const bob = Math.sin(t / 500 + x) * 2;
  const cy = y + bob;

  // soft outer glow in the agent's color
  const gs = agentGlow(a.color || "#a78bfa");
  ctx.globalAlpha = 0.8;
  ctx.drawImage(gs, x - 44, cy - 44, 88, 88);
  ctx.globalAlpha = 1;

  // portrait: real avatar image when available, emoji fallback otherwise
  const img = getAvatarImage(a.image);
  ctx.fillStyle = a.color || "#a78bfa";
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, 6.2832); ctx.fill();
  if (img) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, cy, 21, 0, 6.2832); ctx.clip();
    // cover-fit the portrait into the circle
    const s = Math.max(42 / img.naturalWidth, 42 / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, x - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.font = "24px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.emoji || "🙂", x, cy + 1);
  }
  // thin light ring, green while talking
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = a.talking ? PAL.ok : PAL.ring;
  ctx.beginPath(); ctx.arc(x, cy, 24, 0, 6.2832); ctx.stroke();

  if (a.talking) {
    // soft expanding pulse
    const pr = ((t / 1100) + x * 0.013) % 1;
    ctx.globalAlpha = (1 - pr) * 0.5;
    ctx.lineWidth = 2;
    ctx.strokeStyle = PAL.ok;
    ctx.beginPath(); ctx.arc(x, cy, 27 + pr * 16, 0, 6.2832); ctx.stroke();
    ctx.globalAlpha = 1;
    const n = 1 + ((t / 400) | 0) % 3;
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = PAL.ok;
    ctx.fillText("●".repeat(n), x, cy - 38);
  }

  drawNamePill(a, x, cy);
  if (a.bubble) drawBubble(a, cy, t);
  ctx.restore();
}

// Avatar image cache: loads each unique URL once, returns the Image only
// once it's fully loaded (null until then -> emoji fallback meanwhile).
const imgCache = new Map();
function getAvatarImage(url) {
  if (!url) return null;
  let e = imgCache.get(url);
  if (!e) {
    e = new Image();
    e.src = url;
    imgCache.set(url, e);
  }
  return e.complete && e.naturalWidth > 0 ? e : null;
}

// bubble appear animation state: agentKey -> { text, t0 }
const bubbleState = new Map();

function drawBubble(a, cy, t) {
  const key = a.id || a.name;
  const txt = String(a.bubble);
  let st = bubbleState.get(key);
  if (!st || st.text !== txt) {
    st = { text: txt, t0: t };
    bubbleState.set(key, st);
  }
  const age = t - st.t0;
  const k = Math.min(1, age / 220);
  const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
  const yOff = (1 - e) * 14;

  ctx.save();
  ctx.globalAlpha = 0.15 + 0.85 * e;
  ctx.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const maxW = 200;
  const words = txt.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = w; }
    else line = trial;
  }
  if (line) lines.push(line);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28;
  const h = lines.length * 19 + 20;
  const bx = Math.min(990 - w, Math.max(10, a.x - w / 2));
  const by = cy - 60 - h + yOff;

  // soft drop shadow on the body
  ctx.shadowColor = PAL.bubbleShadow;
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = PAL.bubbleBg;
  rr(ctx, bx, by, w, h, 13); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // smooth curved tail
  ctx.beginPath();
  ctx.moveTo(a.x - 9, by + h - 3);
  ctx.quadraticCurveTo(a.x, by + h + 11, a.x + 9, by + h - 3);
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = PAL.bubbleLine;
  ctx.lineWidth = 1;
  rr(ctx, bx + 0.5, by + 0.5, w - 1, h - 1, 12.5); ctx.stroke();

  ctx.fillStyle = PAL.bubbleText;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, bx + 14, by + 10 + i * 19));
  ctx.restore();
}

// start the render loop (defined above in the camera section) —
// snapshot mode draws exactly one frame per state instead.
if (!SNAP) requestAnimationFrame(frame);

// boot: land in the claimed agent's current room when known, otherwise the
// plaza; then open the socket. The agent prompt shows on first visit only
// (never in snapshot mode).
(async function boot() {
  if (SNAP) {
    connect();
    return;
  }
  if (localStorage.getItem(AGENT_KEY) === null) openAgentPrompt();
  const name = storedAgentName();
  if (name) {
    const hit = await findAgentRoom(name);
    if (hit) {
      currentRoom = hit.room_id;
      currentTopic = hit.topic || hit.room_id;
      myRooms.set(hit.room_id, currentTopic);
    }
  }
  renderAgentClaim();
  renderDmBadge();
  renderDmHome();
  loadDmContacts();
  renderTabsIfChanged();
  renderSideIfChanged();
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v && PANEL_VIEWS.includes(v)) openPanel(v);
  } catch (e) {}
  connect();
})();
