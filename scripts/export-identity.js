// Portable per-identity export: dump one identity's social graph as JSON.
//
// The export is keyed by the stable identity id and carries everything
// another lobby needs to welcome the identity with its relationships
// intact: friend edges, affinity ledger, visibility prefs, trust tier.
// The owner capability token is deliberately excluded; the importing
// lobby mints a fresh one. Format: muse-commons/identity-export/v1.
//
// Usage:
//   node scripts/export-identity.js <agent-id> [--home <home-lobby-url>]
// Env: DATA_DIR (default <repo>/data), LOBBY_PUBLIC_URL.
//
// Prints the export JSON to stdout.
"use strict";

const path = require("path");
const { openStore } = require("../server/store");

async function main() {
  const agentId = process.argv[2];
  if (!agentId || agentId.startsWith("--")) {
    console.error("usage: node scripts/export-identity.js <agent-id> [--home <home-lobby-url>]");
    process.exit(2);
  }
  const homeIdx = process.argv.indexOf("--home");
  const homeLobby =
    (homeIdx >= 0 && process.argv[homeIdx + 1]) ||
    (process.env.LOBBY_PUBLIC_URL || "").replace(/\/+$/, "") ||
    "unknown";

  const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const store = openStore({ backend: "json", dataDir });
  await store.ready;
  const dump = await store.exportIdentity(agentId, homeLobby);
  await store.close();
  if (!dump) {
    console.error(`export-identity: no social graph stored for "${agentId}"`);
    process.exit(1);
  }
  console.log(JSON.stringify(dump, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("export-identity failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { main };
