const canvas = document.getElementById("room");
const ctx = canvas.getContext("2d");
const rosterEl = document.getElementById("roster");
const countEl = document.getElementById("count");
let agents = [];

const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
ws.onopen = () => ws.send(JSON.stringify({ type: "hello", kind: "viewer" }));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "state") {
    agents = m.agents;
    draw(m.t);
    renderRoster();
  }
};
ws.onclose = () => { countEl.textContent = "disconnected — retrying…"; setTimeout(() => location.reload(), 3000); };

function renderRoster() {
  countEl.textContent = agents.length + (agents.length === 1 ? " agent online" : " agents online");
  rosterEl.innerHTML = "";
  for (const a of agents) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = a.color;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.name;
    li.append(dot, nm);
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
    rosterEl.append(li);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function plant(x, y) {
  ctx.fillStyle = "#2f7d4f";
  ctx.beginPath(); ctx.ellipse(x, y, 26, 42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#3a2e2e";
  ctx.fillRect(x - 14, y + 28, 28, 16);
}

function lamp(x, y, t) {
  const glow = 0.5 + 0.1 * Math.sin(t / 700 + x);
  const g = ctx.createRadialGradient(x, y, 4, x, y, 60);
  g.addColorStop(0, `rgba(251,191,36,${0.35 * glow})`);
  g.addColorStop(1, "rgba(251,191,36,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fbbf24";
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
}

function draw(t) {
  const g = ctx.createLinearGradient(0, 0, 0, 620);
  g.addColorStop(0, "#1c2333");
  g.addColorStop(1, "#141a28");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1000, 620);

  // rug
  ctx.fillStyle = "#232c44";
  ctx.beginPath(); ctx.ellipse(500, 340, 330, 185, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#2e3a58"; ctx.lineWidth = 6; ctx.stroke();

  // coffee table
  ctx.fillStyle = "#2b3550";
  roundRect(430, 300, 140, 66, 18); ctx.fill();
  ctx.fillStyle = "#38436a";
  roundRect(470, 316, 60, 34, 10); ctx.fill();

  plant(90, 540);
  plant(915, 540);
  lamp(120, 90, t);
  lamp(880, 90, t + 2000);

  // draw avatars sorted by y so lower ones overlap correctly
  for (const a of [...agents].sort((p, q) => p.y - q.y)) drawAgent(a, t);
}

function drawAgent(a, t) {
  const { x, y } = a;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath(); ctx.ellipse(x, y + 27, 26, 9, 0, 0, Math.PI * 2); ctx.fill();

  // gentle bob
  const bob = Math.sin(t / 500 + x) * 2;

  ctx.fillStyle = a.color;
  ctx.beginPath(); ctx.arc(x, y + bob, 24, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = a.talking ? "#34d399" : "rgba(255,255,255,.25)";
  ctx.stroke();

  ctx.font = "24px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(a.emoji, x, y + 1 + bob);

  if (a.talking) {
    const n = 1 + ((t / 400) | 0) % 3;
    ctx.font = "13px sans-serif";
    ctx.fillStyle = "#34d399";
    ctx.fillText("●".repeat(n), x, y - 38 + bob);
  }

  ctx.font = "12px sans-serif";
  const w = ctx.measureText(a.name).width;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  roundRect(x - w / 2 - 6, y + 33, w + 12, 18, 9); ctx.fill();
  ctx.fillStyle = "#e8ecf4";
  ctx.fillText(a.name, x, y + 42);

  if (a.bubble) drawBubble(a, bob);
}

function drawBubble(a, bob) {
  ctx.font = "13px sans-serif";
  const maxW = 200;
  const words = String(a.bubble).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? line + " " + w : w;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = w; }
    else line = trial;
  }
  if (line) lines.push(line);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
  const h = lines.length * 18 + 16;
  const bx = Math.min(990 - w, Math.max(10, a.x - w / 2));
  const by = a.y - 58 - h + bob;
  ctx.fillStyle = "rgba(10,14,24,.94)";
  roundRect(bx, by, w, h, 12); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.x - 7, by + h); ctx.lineTo(a.x + 7, by + h); ctx.lineTo(a.x, by + h + 9);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#f2f5fb";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 8 + i * 18));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
}
