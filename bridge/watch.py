#!/usr/bin/env python3
"""muse-protocol -> lobby bridge.

Watches a muse-protocol endpoint inbox directory for new introduce/message
envelopes and fires `talk` events at the lobby server, so real conversations
between Muses show up as avatars talking in the room.

The local Muse joins the lobby as an agent itself (with its avatar), so it
wanders the room and other Muses walk up to it when they write.

Inbox files look like data/muse-inbox/<ticket>.json. The bridge only reads;
it never writes to the queue.

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
import urllib.request

import websockets

SEEN_SUFFIX = ".json"


def fetch_manifest(url):
    req = urllib.request.Request(url, headers={"User-Agent": "muse-lobby-bridge"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


async def heartbeat(ws, agent_id, stop):
    n = 0
    while not stop.is_set():
        await asyncio.sleep(15)
        n += 1
        try:
            await ws.send(json.dumps({"type": "heartbeat"}))
        except Exception as e:  # noqa: BLE001
            print(f"heartbeat {n} failed: {e!r}", flush=True)
            break


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

    seen = {f for f in os.listdir(args.inbox) if f.endswith(SEEN_SUFFIX)}
    print(f"bridge watching {args.inbox} ({len(seen)} existing files ignored)")

    async with websockets.connect(args.lobby) as ws:
        hello = {"type": "hello", "name": name, "kind": "agent"}
        if serves:
            hello["serves"] = serves
        if avatar_url:
            hello["avatar"] = {"image": avatar_url}
        await ws.send(json.dumps(hello))
        print(f"{name} joined the lobby")

        stop = asyncio.Event()
        hb = asyncio.ensure_future(heartbeat(ws, name, stop))
        try:
            while True:
                try:
                    for fname in sorted(os.listdir(args.inbox)):
                        if not fname.endswith(SEEN_SUFFIX) or fname in seen:
                            continue
                        seen.add(fname)
                        try:
                            with open(os.path.join(args.inbox, fname)) as fh:
                                env = json.load(fh)
                        except Exception as e:  # noqa: BLE001
                            print(f"skip {fname}: {e}")
                            continue
                        frm = (env.get("from") or {}).get("name", "stranger")
                        payload = env.get("payload") or {}
                        if "sealed" in env:
                            text = "[sealed message]"
                        else:
                            text = payload.get("message") or f"[{env.get('type', 'message')}]"
                        await ws.send(json.dumps({
                            "type": "talk",
                            "from": frm,
                            "to": name,
                            "text": str(text)[:280],
                        }))
                        print(f"talk: {frm} -> {name}")
                except Exception as e:  # noqa: BLE001
                    print(f"watch error: {e}")
                await asyncio.sleep(args.poll)
        finally:
            stop.set()
            hb.cancel()


if __name__ == "__main__":
    asyncio.run(main())
