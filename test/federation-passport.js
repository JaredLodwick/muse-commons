// PR #9 federation passport prototype tests.
//
// Spawns TWO local lobby instances (A = issuer, B = receiver) plus a
// fixture manifest server, and exercises the passport contract over
// WebSocket: issuance, cross-lobby verification via the issuer's
// .well-known, tamper/expiry/revocation rejection, identity-key binding
// (non-transferable), the verified-tier cap on arrival, and fallback to
// the normal challenge flow on a bad passport.
//
//   node test/federation-passport.js
//
// Exit 0 = all pass, 1 = any failure. Local instances only — never
// touches the production lobby.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const REPO = path.join(__dirname, "..");
const LOBBY = path.join(REPO, "server", "lobby.js");
const PORT_A = 18821; // issuer lobby
const PORT_B = 18822; // receiving lobby
const FIXTURE_PORT = 18820;
const URL_A = `http://127.0.0.1:${PORT_A}`;
const URL_B = `http://127.0.0.1:${PORT_B}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- operator keys: one per lobby, as base64 seeds in temp files ---
function writeOperatorKey() {
  const seed = crypto.randomBytes(32).toString("base64");
  const file = path.join("/tmp", `pp-op-${crypto.randomBytes(4).toString("hex")}.key`);
  fs.writeFileSync(file, seed + "\n", { mode: 0o600 });
  return file;
}
const OPKEY_A = writeOperatorKey();
const OPKEY_B = writeOperatorKey();

// The cross-lobby tests verify passports against the issuer key the
// home lobby publishes at /.well-known/muse-commons.json — but that
// route serves 503 unless web/skill.md's Ed25519 signature verifies,
// and the working tree's skill.md is (correctly) unsigned between
// releases. So for the duration of this run we sign the current
// skill.md with lobby A's throwaway operator key, then restore the
// original files. The repo is never committed in this state.
const SKILL_FILE = path.join(REPO, "web", "skill.md");
const SIG_FILE = path.join(REPO, "web", "skill.md.sig");
const origSkillText = fs.readFileSync(SKILL_FILE, "utf8");
const origSigText = fs.readFileSync(SIG_FILE, "utf8");
function testSignSkill() {
  const seed = Buffer.from(fs.readFileSync(OPKEY_A, "utf8").trim(), "base64");
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const pubRaw = Buffer.from(crypto.createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  const pubB64 = pubRaw.toString("base64");
  const keyId = crypto.createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);
  let text = origSkillText
    .replace(/^operator_pubkey:.*$/m, `operator_pubkey: ${pubB64}`)
    .replace(/^operator_key_id:.*$/m, `operator_key_id: ${keyId}`);
  const skillMod = require(path.join(REPO, "server", "skill.js"));
  const digest = skillMod.computeDigest(text);
  text = text.replace(/^(digest:\s*sha256:)[0-9a-fA-F]{64}/m, (_, p) => p + digest);
  const sig = crypto.sign(null, Buffer.from(text, "utf8"), priv);
  fs.writeFileSync(SKILL_FILE, text);
  fs.writeFileSync(SIG_FILE, sig.toString("base64") + "\n");
}
function restoreSkill() {
  fs.writeFileSync(SKILL_FILE, origSkillText);
  fs.writeFileSync(SIG_FILE, origSigText);
}

// --- fixture identity keys + manifest server ---
const keys = {};
function keyFor(name) {
  if (!keys[name]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    keys[name] = {
      priv: privateKey,
      pubB64: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"),
    };
  }
  return keys[name];
}
const manifestUrlFor = (name) => `http://127.0.0.1:${FIXTURE_PORT}/m/${encodeURIComponent(name)}`;
const fixture = http.createServer((req, res) => {
  const m = req.url.match(/^\/m\/(.+)$/);
  const name = m ? decodeURIComponent(m[1]) : "Nobody";
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      muse: { name, serves: "PassportTester" },
      signing_key: { alg: "ed25519", key_id: `fx-${name}`, pubkey: keyFor(name).pubB64 },
    })
  );
});
const signChallenge = (nonce, priv) =>
  crypto.sign(null, Buffer.from("muse-commons/v1/challenge:" + nonce, "utf8"), priv).toString("base64");
const signPassportChallenge = (nonce, priv) =>
  crypto
    .sign(null, Buffer.from("muse-commons/v1/passport-challenge:" + nonce, "utf8"), priv)
    .toString("base64");

// --- lobby spawners ---
function startLobby(port, opkeyFile, extraEnv = {}) {
  return spawn("node", [LOBBY], {
    env: {
      ...process.env,
      PORT: String(port),
      LOBBY_PUBLIC_URL: `http://127.0.0.1:${port}/`,
      MANIFEST_ALLOW_PRIVATE: "1",
      MUSE_IDENTITY_KEY_FILE: opkeyFile,
      HOST_MUSE: "HostMuse",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 20000);
    const onData = (d) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (c) => reject(new Error(`server exited with ${c}`)));
  });
}

// Connect to a lobby port; answer manifest challenges with `signer` and
// passport challenges with `ppSigner` (null = don't answer). Resolves
// once hello_ok arrives; rejects on error before that.
function connect(port, helloFields, { signer = null, ppSigner = null } = {}) {
  return new Promise((resolve, reject) => {
    const rec = { ws: null, helloOk: null, msgs: [] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    rec.ws = ws;
    const timer = setTimeout(() => reject(new Error("hello timed out")), 15000);
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      rec.msgs.push(m);
      if (m.type === "challenge" && signer) {
        ws.send(JSON.stringify({ type: "challenge_response", challenge_id: m.challenge_id, signature: signer(m.nonce) }));
      } else if (m.type === "passport_challenge" && ppSigner) {
        ws.send(
          JSON.stringify({
            type: "passport_challenge_response",
            challenge_id: m.challenge_id,
            signature: ppSigner(m.nonce),
          })
        );
      } else if (m.type === "hello_ok" && !rec.helloOk) {
        rec.helloOk = m;
        clearTimeout(timer);
        resolve(rec);
      } else if (m.type === "error" && !rec.helloOk) {
        clearTimeout(timer);
        reject(new Error(`hello failed: ${m.code} ${m.message}`));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol_version: "1.0", ...helloFields })));
  });
}

// Verified connect via the fixture manifest.
function vconnect(port, name) {
  keyFor(name);
  return connect(
    port,
    { name, manifest_url: manifestUrlFor(name) },
    { signer: (nonce) => signChallenge(nonce, keyFor(name).priv) }
  );
}

function waitFor(rec, pred, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const found = rec.msgs.find(pred);
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(timer);
        rec.ws.removeListener("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
  });
}

function sendMut(rec, obj, expectType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rec.ws.removeListener("message", onMsg);
      reject(new Error(`no ack (${expectType}) for ${obj.type}`));
    }, 8000);
    const onMsg = (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === expectType || m.type === "error") {
        clearTimeout(timer);
        rec.ws.removeListener("message", onMsg);
        resolve(m);
      }
    };
    rec.ws.on("message", onMsg);
    rec.ws.send(JSON.stringify({ ...obj, session_token: rec.helloOk.session_token }));
  });
}

function decodePassport(token) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

async function main() {
  testSignSkill();
  let failures = 1;
  try {
    failures = await run();
  } finally {
    restoreSkill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

async function run() {
  await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));
  const lobbyA = startLobby(PORT_A, OPKEY_A);
  const lobbyB = startLobby(PORT_B, OPKEY_B);
  const lobbyBs = []; // restarted lobbies (kill them all at the end)
  const conns = [];
  const track = (rec) => {
    conns.push(rec);
    return rec;
  };
  try {
    await waitForListening(lobbyA);
    await waitForListening(lobbyB);

    // 1. issuance ---------------------------------------------------------
    const alice = track(await vconnect(PORT_A, "AlicePP"));
    check("verified hello on issuer works", alice.helloOk.verified === "verified");
    const iss = await sendMut(alice, { type: "request_passport" }, "passport");
    check("request_passport returns a passport", iss.type === "passport" && typeof iss.passport === "string");
    const p = decodePassport(iss.passport);
    check("passport fields are correct", 
      p.kind === "muse-commons/passport" &&
        p.agent_id === alice.helloOk.agent_id &&
        p.agent_name === "AlicePP" &&
        p.home_lobby === URL_A &&
        typeof p.nonce === "string" &&
        p.expires_at - p.issued_at === 24 * 60 * 60 * 1000,
      JSON.stringify({ kind: p.kind, home: p.home_lobby })
    );
    check(
      "passport binds the agent identity key",
      p.identity_pubkey === keyFor("AlicePP").pubB64,
      "identity_pubkey mismatch"
    );

    // 2. unverified agents cannot mint passports --------------------------
    const anon = track(
      await connect(PORT_A, { name: "AnonPP" }, {})
    );
    const denied = await sendMut(anon, { type: "request_passport" }, "passport");
    check(
      "unverified request_passport is refused",
      denied.type === "error" && denied.code === "VERIFIED_ONLY",
      denied.code
    );

    // 3. cross-lobby acceptance --------------------------------------------
    const bob = track(
      await connect(
        PORT_B,
        { name: "AlicePP", passport: iss.passport },
        { ppSigner: (nonce) => signPassportChallenge(nonce, keyFor("AlicePP").priv) }
      )
    );
    check("passport accepted on lobby B (no manifest needed)", bob.helloOk.verified === "verified");
    check(
      "foreign agent id is namespaced",
      typeof bob.helloOk.agent_id === "string" && bob.helloOk.agent_id.startsWith("a-f-"),
      bob.helloOk.agent_id
    );
    check("arrival trust tier is verified", bob.helloOk.trust === "verified", bob.helloOk.trust);

    // 4. tier cap: a home-"trusted" passport still arrives at verified ------
    const passportMod = require(path.join(REPO, "server", "passport.js"));
    const seedA = Buffer.from(fs.readFileSync(OPKEY_A, "utf8").trim(), "base64");
    const privA = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedA]),
      format: "der",
      type: "pkcs8",
    });
    keyFor("CarolPP");
    const trustedTok = passportMod.issuePassport(privA, {
      agentId: "a-v-deadbeef1234",
      agentName: "CarolPP",
      identityPubkeyB64: keyFor("CarolPP").pubB64,
      homeLobby: URL_A,
      trustTier: "trusted",
    });
    const carol = track(
      await connect(
        PORT_B,
        { name: "CarolPP", passport: trustedTok },
        { ppSigner: (nonce) => signPassportChallenge(nonce, keyFor("CarolPP").priv) }
      )
    );
    check(
      "home tier 'trusted' is capped at verified on arrival",
      carol.helloOk.trust === "verified",
      carol.helloOk.trust
    );

    // 5. tampered passport -> clear error, normal flow still works ---------
    const tampered = iss.passport.slice(0, -6) + "AAAAAA";
    let tamperErr = null;
    try {
      await connect(PORT_B, { name: "AlicePP", passport: tampered }, {});
    } catch (e) {
      tamperErr = e.message;
    }
    check(
      "tampered passport is rejected with PASSPORT_INVALID",
      tamperErr && tamperErr.includes("PASSPORT_INVALID"),
      tamperErr
    );
    const fallback = track(await vconnect(PORT_B, "FallbackMuse"));
    check(
      "agent can still join via the normal challenge flow after a bad passport",
      fallback.helloOk.verified === "verified"
    );

    // 6. expired passport ---------------------------------------------------
    const oldTok = passportMod.issuePassport(
      privA,
      {
        agentId: "a-v-deadbeef1234",
        agentName: "OldMuse",
        identityPubkeyB64: keyFor("OldMuse").pubB64,
        homeLobby: URL_A,
        trustTier: "verified",
      },
      Date.now() - 25 * 60 * 60 * 1000
    );
    keyFor("OldMuse");
    let expErr = null;
    try {
      await connect(PORT_B, { name: "OldMuse", passport: oldTok }, {});
    } catch (e) {
      expErr = e.message;
    }
    check("expired passport is rejected", expErr && expErr.includes("PASSPORT_INVALID"), expErr);

    // 7. revocation ---------------------------------------------------------
    const host = track(await vconnect(PORT_A, "HostMuse"));
    const dave = track(await vconnect(PORT_A, "DavePP"));
    const daveIss = await sendMut(dave, { type: "request_passport" }, "passport");
    const daveP = decodePassport(daveIss.passport);
    const rev = await sendMut(host, { type: "revoke_passport", nonce: daveP.nonce }, "passport_revoked");
    check("host can revoke a passport by nonce", rev.type === "passport_revoked", rev.type);
    const revList = await new Promise((resolve, reject) => {
      http
        .get(`${URL_A}/api/passport-revocations`, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(JSON.parse(b)));
        })
        .on("error", reject);
    });
    check(
      "revocation list publishes the nonce",
      revList.revoked_nonces.includes(daveP.nonce),
      JSON.stringify(revList).slice(0, 120)
    );
    // B cached A's (previously empty) revocation list; restart B so it
    // refetches. In production this propagation takes up to the 10-minute
    // revocation-list cache TTL (documented in docs/FEDERATION.md).
    lobbyB.kill();
    await new Promise((r) => setTimeout(r, 500));
    const lobbyB2 = startLobby(PORT_B, OPKEY_B);
    await waitForListening(lobbyB2);
    lobbyBs.push(lobbyB2);
    let revErr = null;
    try {
      await connect(
        PORT_B,
        { name: "DavePP", passport: daveIss.passport },
        { ppSigner: (nonce) => signPassportChallenge(nonce, keyFor("DavePP").priv) }
      );
    } catch (e) {
      revErr = e.message;
    }
    check("revoked passport is rejected on lobby B", revErr && revErr.includes("PASSPORT_INVALID"), revErr);
    // non-host revoke is refused
    const revDenied = await sendMut(dave, { type: "revoke_passport", nonce: "x" }, "passport_revoked");
    check(
      "non-host cannot revoke",
      revDenied.type === "error" && (revDenied.code === "HOST_ONLY" || revDenied.code === "INSUFFICIENT_SCOPE"),
      revDenied.code
    );

    // 8. non-transferable: wrong identity key fails the binding ------------
    const erin = track(await vconnect(PORT_A, "ErinPP"));
    const erinIss = await sendMut(erin, { type: "request_passport" }, "passport");
    keyFor("MalloryPP"); // attacker's key, never bound to the passport
    const evilWs = new WebSocket(`ws://127.0.0.1:${PORT_B}`);
    const bindErr = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout waiting for binding result"), 12000);
      evilWs.on("open", () =>
        evilWs.send(JSON.stringify({ type: "hello", protocol_version: "1.0", name: "ErinPP", passport: erinIss.passport }))
      );
      evilWs.on("message", (raw) => {
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.type === "passport_challenge") {
          evilWs.send(
            JSON.stringify({
              type: "passport_challenge_response",
              challenge_id: m.challenge_id,
              signature: signPassportChallenge(m.nonce, keyFor("MalloryPP").priv),
            })
          );
        } else if (m.type === "error") {
          clearTimeout(timer);
          resolve(`${m.code} ${m.message}`);
        } else if (m.type === "hello_ok") {
          clearTimeout(timer);
          resolve("UNEXPECTED hello_ok — passport was transferable!");
        }
      });
      evilWs.on("error", (e) => {
        clearTimeout(timer);
        resolve("ws error: " + e.message);
      });
    });
    check("passport cannot be used with a different identity key", bindErr.includes("PASSPORT_BINDING_FAILED"), bindErr);
    evilWs.close();

    // 9. own-lobby passports verify via the fast path -----------------------
    const frank = track(await vconnect(PORT_A, "FrankPP"));
    const frankIss = await sendMut(frank, { type: "request_passport" }, "passport");
    frank.ws.close();
    const frank2 = track(
      await connect(
        PORT_A,
        { name: "FrankPP", passport: frankIss.passport },
        { ppSigner: (nonce) => signPassportChallenge(nonce, keyFor("FrankPP").priv) }
      )
    );
    check("own-lobby passport re-admits without a manifest", frank2.helloOk.verified === "verified");
  } finally {
    for (const c of conns) {
      try {
        c.ws.close();
      } catch {
        /* ignore */
      }
    }
    lobbyA.kill();
    lobbyB.kill();
    for (const lb of lobbyBs) lb.kill();
    fixture.close();
    for (const f of [OPKEY_A, OPKEY_B]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    // tidy the shared data dir: drop this run's revocation file + foreign trust records
    try {
      fs.unlinkSync(path.join(REPO, "data", "passport-revocations.json"));
    } catch {
      /* ignore */
    }
    try {
      const tf = path.join(REPO, "data", "trust.json");
      const doc = JSON.parse(fs.readFileSync(tf, "utf8"));
      let changed = false;
      for (const id of Object.keys(doc)) {
        if (id.startsWith("a-f-")) {
          delete doc[id];
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(tf, JSON.stringify(doc));
    } catch {
      /* ignore */
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  return failures;
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
