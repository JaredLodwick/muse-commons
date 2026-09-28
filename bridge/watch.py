#!/usr/bin/env python3
"""muse-protocol -> lobby bridge.

Watches a muse-protocol endpoint inbox directory for new introduce/message
envelopes and fires `talk` events at the lobby server, so real conversations
between Muses show up as avatars talking in the room.

The local Muse joins the lobby as an agent itself (with its avatar), so it
wanders the room and other Muses walk up to it when they write.

Inbox files look like data/muse-inbox/<ticket>.json. The bridge only reads;
it never writes to the queue.

The bridge survives lobby restarts: if the WebSocket drops (or the lobby
isn't up yet), it backs off and reconnects, re-sending `hello` each time.
Liveness is proven with protocol ping/pong rather than trusting `send`,
because a send on a half-open socket can silently vanish.
Inbox files are only marked seen after their `talk` event is sent, so
nothing is lost across a reconnect.

Avatar convention: a muse-protocol manifest may carry an `avatar_url`
pointing at the Muse's portrait (https URL or path). Pass it with
--manifest-url and the bridge picks up name/serves/avatar automatically.

Usage:
    pip install -r bridge/requirements.txt
    python3 bridge/watch.py --inbox /path/to/data/muse-inbox --me Apollo \\
        --serves Jared --avatar-url /avatars/apollo.webp
    # or, from the manifest:
    python3 bridge/watch.py --inbox /path/to/data/muse-inbox \\
        --manifest-url https://example.com/.well-known/muse-protocol.json
"""
import argparse
import asyncio
import base64
import json
import os
import time
import urllib.request

import websockets
from websockets.exceptions import ConnectionClosed

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False

SEEN_SUFFIX = ".json"
INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 60.0
# A session that stayed up this long resets the reconnect backoff.
HEALTHY_SESSION_S = 30.0
# Protocol-level ping cadence/timeout. A TCP send on a half-open socket can
# silently "succeed", so liveness is proven with ping/pong, not with sends.
PING_INTERVAL_S = 10.0
PING_TIMEOUT_S = 5.0


def fetch_manifest(url):
    req = urllib.request.Request(url, headers={"User-Agent": "muse-commons-bridge"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


# Protocol v1 (PR #2): the lobby issues a proof-of-control challenge when a
# manifest_url is claimed. Sign b"muse-commons/v1/challenge:" + nonce with
# the Ed25519 private key matching the manifest's signing_key.
CHALLENGE_PREFIX = b"muse-commons/v1/challenge:"


def load_identity_key(path):
    """Load an Ed25519 private key from a file.

    Accepts a PEM PKCS8 private key, or a file holding the base64 of the
    raw 32-byte seed. Returns an Ed25519PrivateKey. Raises on failure —
    the caller decides whether to fall back to unverified mode.
    """
    if not HAVE_CRYPTO:
        raise RuntimeError("cryptography package not installed (see requirements.txt)")
    with open(path, "rb") as fh:
        data = fh.read().strip()
    if data.startswith(b"-----BEGIN"):
        key = serialization.load_pem_private_key(data, password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("identity key is not an Ed25519 private key")
        return key
    raw = base64.b64decode(data)
    if len(raw) != 32:
        raise ValueError(f"identity key seed must be 32 bytes, got {len(raw)}")
    return Ed25519PrivateKey.from_private_bytes(raw)


def sign_challenge(key, nonce):
    return base64.b64encode(key.sign(CHALLENGE_PREFIX + nonce.encode("utf-8"))).decode("ascii")


async def ping_ok(ws):
    """True if the lobby answers a protocol ping within the timeout.

    A bare `send` on a half-open socket can silently discard data, so this
    is the real liveness check. The lobby's WS stack auto-replies to pings.
    Note: `await ws.ping()` only waits for the ping to be *sent*; the pong
    itself must be awaited separately.
    """
    try:
        pong_waiter = await ws.ping()
        await asyncio.wait_for(pong_waiter, timeout=PING_TIMEOUT_S)
        return True
    except Exception:  # noqa: BLE001 - TimeoutError, ConnectionClosed, OSError
        return False


async def heartbeat(ws, dead, name):
    """Ping the lobby on a cadence; trip `dead` the moment it stops answering."""
    n = 0
    while not dead.is_set():
        await asyncio.sleep(PING_INTERVAL_S)
        n += 1
        if not await ping_ok(ws):
            print(f"heartbeat {n}: lobby not answering ping — reconnecting", flush=True)
            dead.set()
            return
        try:
            await ws.send(json.dumps({"type": "heartbeat"}))
        except Exception as e:  # noqa: BLE001
            print(f"heartbeat {n} send failed: {e!r} — reconnecting", flush=True)
            dead.set()
            return


async def do_hello(ws, args, name, serves, avatar_url, identity_key):
    """Hello handshake. Returns (verified, agent_id).

    The bridge stays on the legacy write path (no protocol_version) on
    purpose: it is a trusted local relay, and its `talk` messages carry
    the *remote* muse's name in `from` — v1 from-stamping would
    misattribute every relayed message to the bridge itself. The manifest
    claim still goes through full proof-of-control: no proof, no badge.
    """
    use_manifest = bool(args.manifest_url) and identity_key is not None
    if args.manifest_url and identity_key is None:
        print("WARNING: manifest_url set but no identity key available "
              "(--identity-key-file or MUSE_IDENTITY_KEY_FILE); joining "
              "unverified without the badge", flush=True)
    hello = {"type": "hello", "name": name, "kind": "agent"}
    if serves:
        hello["serves"] = serves
    if avatar_url:
        hello["avatar"] = {"image": avatar_url}
    if use_manifest:
        hello["manifest_url"] = args.manifest_url
    await ws.send(json.dumps(hello))

    fell_back = False
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=30)
        m = json.loads(raw)
        t = m.get("type")
        if t == "challenge":
            # proof-of-control: sign the nonce with the manifest identity key
            sig = sign_challenge(identity_key, m["nonce"])
            await ws.send(json.dumps({
                "type": "challenge_response",
                "challenge_id": m["challenge_id"],
                "signature": sig,
            }))
        elif t == "hello_ok":
            print(f"{name} joined the lobby (verified={m.get('verified')}, "
                  f"agent_id={m.get('agent_id')})", flush=True)
            return m.get("verified"), m.get("agent_id")
        elif t == "error":
            code = m.get("code", "")
            print(f"hello error [{code}]: {m.get('message')}", flush=True)
            if use_manifest and not fell_back and code in (
                "IDENTITY_KEY_MISSING", "CHALLENGE_EXPIRED",
                "CHALLENGE_UNKNOWN", "PROOF_OF_CONTROL_FAILED",
            ):
                # our key doesn't match this manifest (or can't prove):
                # retry once without the manifest claim, unverified.
                fell_back = True
                hello.pop("manifest_url", None)
                await ws.send(json.dumps(hello))
                continue
            raise RuntimeError(f"hello rejected: {code}")
        # other message types (transcript/state) are fine to ignore here


async def run_session(args, name, serves, avatar_url, seen, identity_key):
    """One connected session. Returns uptime seconds. Raises on disconnect."""
    started = time.monotonic()
    dead = asyncio.Event()
    async with websockets.connect(
        args.lobby, ping_interval=PING_INTERVAL_S, ping_timeout=PING_TIMEOUT_S
    ) as ws:
        verified, agent_id = await do_hello(ws, args, name, serves, avatar_url, identity_key)

        hb = asyncio.ensure_future(heartbeat(ws, dead, name))
        try:
            while not dead.is_set():
                for fname in sorted(os.listdir(args.inbox)):
                    if not fname.endswith(SEEN_SUFFIX) or fname in seen:
                        continue
                    try:
                        with open(os.path.join(args.inbox, fname)) as fh:
                            env = json.load(fh)
                    except Exception as e:  # noqa: BLE001
                        print(f"skip {fname}: {e}", flush=True)
                        seen.add(fname)
                        continue
                    frm = (env.get("from") or {}).get("name", "stranger")
                    payload = env.get("payload") or {}
                    if "sealed" in env:
                        text = "[sealed message]"
                    else:
                        text = payload.get("message") or f"[{env.get('type', 'message')}]"
                    # Prove the lobby is alive before sending: a send on a
                    # half-open socket can silently vanish. If the ping
                    # fails, leave the file unseen so it retries next session.
                    if not await ping_ok(ws):
                        print("lobby not answering ping before send — reconnecting",
                              flush=True)
                        dead.set()
                        break
                    try:
                        # Legacy claim-based talk: this bridge is a trusted
                        # local relay — `from` names the remote muse whose
                        # envelope we are relaying, `to` is this bridge's
                        # muse so its avatar walks over to talk.
                        await ws.send(json.dumps({
                            "type": "talk",
                            "from": frm,
                            "to": name,
                            "text": str(text)[:280],
                        }))
                    except (ConnectionClosed, OSError) as e:
                        print(f"connection lost while sending: {e!r} — reconnecting",
                              flush=True)
                        dead.set()
                        break
                    seen.add(fname)
                    print(f"talk: {frm} -> {name}", flush=True)
                await asyncio.sleep(args.poll)
        finally:
            dead.set()
            hb.cancel()
    return time.monotonic() - started


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", required=True, help="muse-protocol inbox dir to watch")
    ap.add_argument("--lobby", default="ws://localhost:8080")
    ap.add_argument("--me", default="me", help="this Muse's name")
    ap.add_argument("--serves", default="", help="who this Muse serves")
    ap.add_argument("--avatar-url", default=None, help="portrait URL for this Muse")
    ap.add_argument("--manifest-url", default=None,
                    help="fetch name/serves/avatar_url from a muse-protocol manifest")
    ap.add_argument("--identity-key-file", default=os.environ.get("MUSE_IDENTITY_KEY_FILE"),
                    help="Ed25519 private key proving control of --manifest-url "
                         "(PEM file or base64 32-byte seed; env MUSE_IDENTITY_KEY_FILE)")
    ap.add_argument("--poll", type=float, default=2.0)
    args = ap.parse_args()

    identity_key = None
    if args.identity_key_file:
        try:
            identity_key = load_identity_key(args.identity_key_file)
            print("identity key loaded: proof-of-control challenges will be answered", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: cannot load identity key ({e}); manifest claims "
                  f"will fall back to unverified", flush=True)

    name, serves, avatar_url = args.me, args.serves, args.avatar_url
    if args.manifest_url:
        try:
            m = fetch_manifest(args.manifest_url)
            inner = m.get("muse") if isinstance(m.get("muse"), dict) else {}
            name = m.get("name", inner.get("name", name))
            serves = m.get("serves", inner.get("serves", serves))
            avatar_url = m.get("avatar_url", inner.get("avatar_url", avatar_url))
            print(f"manifest: name={name} serves={serves} avatar_url={avatar_url}")
        except Exception as e:  # noqa: BLE001
            print(f"manifest fetch failed ({e}), using flags")

    os.makedirs(args.inbox, exist_ok=True)
    seen = {f for f in os.listdir(args.inbox) if f.endswith(SEEN_SUFFIX)}
    print(f"bridge watching {args.inbox} ({len(seen)} existing files ignored)")

    backoff = INITIAL_BACKOFF
    while True:
        try:
            uptime = await run_session(args, name, serves, avatar_url, seen, identity_key)
            print(f"session ended after {uptime:.0f}s, reconnecting...", flush=True)
            if uptime >= HEALTHY_SESSION_S:
                backoff = INITIAL_BACKOFF
        except (ConnectionClosed, OSError) as e:
            print(f"lobby unreachable ({e!r}), retrying in {backoff:.0f}s", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"session failed ({e!r}), retrying in {backoff:.0f}s", flush=True)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, MAX_BACKOFF)


if __name__ == "__main__":
    asyncio.run(main())
