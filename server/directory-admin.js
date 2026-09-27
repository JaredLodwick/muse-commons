#!/usr/bin/env node
// Minimal admin for the lobby directory moderation queue (Phase 2).
//
// We run the directory for now (user decision 2026-09-27): submissions land
// in data/moderation-queue.json and a human approves them here. The server
// re-reads the JSON files on every access, so approvals take effect without
// a restart. Run on the machine hosting the lobby.
//
// Usage:
//   node server/directory-admin.js pending          # show the queue
//   node server/directory-admin.js list            # show approved entries
//   node server/directory-admin.js approve <id>    # publish an entry
//   node server/directory-admin.js reject <id>     # drop a submission
//
// Data dir: ../data relative to this file, or --data <dir>.

const fs = require("fs");
const path = require("path");

let dataDir = path.join(__dirname, "..", "data");
const argv = process.argv.slice(2);
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--data" && argv[i + 1]) {
    dataDir = path.resolve(argv[i + 1]);
    i++;
  } else {
    args.push(argv[i]);
  }
}
const DIR_FILE = path.join(dataDir, "directory.json");
const QUEUE_FILE = path.join(dataDir, "moderation-queue.json");

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function showPending() {
  const q = readJson(QUEUE_FILE);
  if (!q.length) {
    console.log("moderation queue is empty");
    return;
  }
  for (const e of q) {
    console.log(`- ${e.id}`);
    console.log(`  name:        ${e.name}`);
    console.log(`  url:         ${e.url}`);
    console.log(`  description: ${e.description || "(none)"}`);
    console.log(`  owner:       ${e.owner || "(none)"}  contact: ${e.contact || "(none)"}`);
    console.log(`  topics:      ${(e.topics || []).join(", ") || "(none)"}`);
    console.log(`  submitted:   ${new Date(e.submitted_at).toISOString()}  ip: ${e.ip || "(unknown)"}`);
  }
}

function showList() {
  const dir = readJson(DIR_FILE);
  if (!dir.length) {
    console.log("directory is empty");
    return;
  }
  for (const e of dir) {
    console.log(
      `- ${e.id}${e.self ? " [self]" : ""}  ${e.name}  ${e.url}  ` +
      `occupancy=${e.occupancy || 0}  last_seen=${e.last_seen ? new Date(e.last_seen).toISOString() : "?"}`
    );
  }
}

function approve(id) {
  const q = readJson(QUEUE_FILE);
  const i = q.findIndex((e) => e.id === id);
  if (i === -1) {
    console.error(`no pending submission with id ${id}`);
    process.exit(1);
  }
  const [e] = q.splice(i, 1);
  const dir = readJson(DIR_FILE);
  dir.push({
    id: e.id,
    name: e.name,
    url: e.url,
    description: e.description,
    owner: e.owner,
    contact: e.contact,
    topics: e.topics || [],
    entry_policy: e.entry_policy || "open",
    approved_at: Date.now(),
    occupancy: 0,
    last_seen: Date.now(),
  });
  writeJsonAtomic(QUEUE_FILE, q);
  writeJsonAtomic(DIR_FILE, dir);
  console.log(`approved ${e.id} (${e.name} — ${e.url})`);
}

function reject(id) {
  const q = readJson(QUEUE_FILE);
  const i = q.findIndex((e) => e.id === id);
  if (i === -1) {
    console.error(`no pending submission with id ${id}`);
    process.exit(1);
  }
  const [e] = q.splice(i, 1);
  writeJsonAtomic(QUEUE_FILE, q);
  console.log(`rejected ${e.id} (${e.name} — ${e.url})`);
}

const [cmd, id] = args;
if (cmd === "pending") showPending();
else if (cmd === "list") showList();
else if (cmd === "approve" && id) approve(id);
else if (cmd === "reject" && id) reject(id);
else {
  console.error("usage: node server/directory-admin.js [--data <dir>] <pending|list|approve <id>|reject <id>>");
  process.exit(1);
}
