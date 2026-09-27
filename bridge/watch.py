#!/usr/bin/env python3
"""muse-protocol -> lobby bridge.

Watches a muse-protocol endpoint inbox directory for new introduce/message
envelopes and fires `talk` events at the lobby server, so real conversations
between Muses show up as avatars talking in the room.

Inbox files look like data/muse-inbox/<ticket>.json. The bridge only reads;
it never writes to the queue.

Usage:
    pip install -r bridge/requirements.txt
    python3 bridge/watch.py --inbox /path/to/data/muse-inbox --me Apollo
"""
import argparse
import asyncio
import json
import os

import websockets

SEEN_SUFFIX = ".json"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inbox", required=True, help="muse-protocol inbox dir to watch")
    ap.add_argument("--lobby", default="ws://localhost:8080")
    ap.add_argument("--me", default="me", help="this Muse's name (recipient of incoming mail)")
    ap.add_argument("--poll", type=float, default=2.0)
    args = ap.parse_args()

    seen = {f for f in os.listdir(args.inbox) if f.endswith(SEEN_SUFFIX)}
    print(f"bridge watching {args.inbox} ({len(seen)} existing files ignored)")

    async with websockets.connect(args.lobby) as ws:
        await ws.send(json.dumps({"type": "hello", "kind": "viewer"}))
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
                        "to": args.me,
                        "text": str(text)[:280],
                    }))
                    print(f"talk: {frm} -> {args.me}")
            except Exception as e:  # noqa: BLE001
                print(f"watch error: {e}")
            await asyncio.sleep(args.poll)


if __name__ == "__main__":
    asyncio.run(main())
