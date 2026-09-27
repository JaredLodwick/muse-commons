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
import json
import os
import time
import urllib.request

import websockets
from websockets.exceptions import ConnectionClosed

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


async def run_session(args, name, serves, avatar_url, seen):
    """One connected session. Returns uptime seconds. Raises on disconnect."""
    started = time.monotonic()
    dead = asyncio.Event()
    async with websockets.connect(
        args.lobby, ping_interval=PING_INTERVAL_S, ping_timeout=PING_TIMEOUT_S
    ) as ws:
        hello = {"type": "hello", "name": name, "kind": "agent"}
        if serves:
            hello["serves"] = serves
        if avatar_url:
            hello["avatar"] = {"image": avatar_url}
        if args.manifest_url:
            # ask the lobby to verify the manifest: keeps the verified
            # badge stable across bridge reconnects (a plain re-hello
            # would otherwise downgrade the shared agent entry).
            hello["manifest_url"] = args.manifest_url
        await ws.send(json.dumps(hello))
        print(f"{name} joined the lobby", flush=True)

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
    ap.add_argument("--poll", type=float, default=2.0)
    args = ap.parse_args()

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
            uptime = await run_session(args, name, serves, avatar_url, seen)
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
