# Delta state (`state_delta`)

Replaces the 10Hz full-state broadcast for clients that opt in. Bandwidth
and memory fix: the old behavior sent every client a full room snapshot ten
times per second whether anything changed or not.

## Opt-in

A hello carrying `accepts_deltas: true` opts the socket in. The flag is
orthogonal to `protocol_version`: legacy clients (and v1 clients that do
not send the flag) keep receiving the full `state` snapshot every tick,
unchanged. The web client opts in.

## Message flow

- On hello / join / room-switch / room-create, the server resets the
  socket's snapshot baseline. The next tick then sends one full `state`
  snapshot (by then the joining agent's own record exists, so it is
  included). The client must be able to render from this alone.
- Afterwards the server sends `state_delta` only when something visible
  changed for that client. Most ticks send nothing at all.
- The server tracks the last snapshot per socket (`ws.lastSnap`); a room
  change resets it, forcing a fresh full snapshot.

## `state_delta` wire format

```json
{
  "type": "state_delta",
  "t": 1727745600000,
  "room_id": "plaza",
  "msg_id": "m_abc123",
  "agents_changed": [ { /* full agent object, same shape as state.agents[] */ } ],
  "agents_left": [ "<agent id>", "..." ],
  "rooms": [ /* only when the public room list changed (plaza only) */ ],
  "topic": "new topic",      // only when changed
  "incident": true,          // only when changed
  "retention": { }           // only when changed
}
```

- `agents_changed` holds agents that joined or whose serialized form
  changed (position, talking, bubble, trust, quarantine, ...). Each entry
  is the complete agent object, same shape as `state.agents[]`.
- `agents_left` holds ids of agents no longer in the room.
- Fields other than `type`/`t`/`room_id`/`msg_id` are omitted when
  unchanged. A tick with no visible changes produces no message.
- Per-client block filtering still applies: a blocked agent's bubble is
  nulled before diffing, so block/unblock shows up as a delta.

## Client merge rule

Keep a local agent list keyed by id. On `state_delta` for the current
room: drop `agents_left` ids, upsert `agents_changed` by id, replace the
room list / topic / incident / retention when present. Never auto-scroll
or re-frame on a delta; those are for full snapshots only.

## Federation invariants

`state_delta` carries no identity information beyond what `state`
already did: agent objects keep their `id` (identity key) and rooms keep
their ids. A future relay can forward deltas between lobbies without
re-resolving identity.

## Backward compatibility

Unknown message types are ignored by old clients, and old clients never
send `accepts_deltas`, so they keep the legacy behavior with zero
changes. `state` remains the full-snapshot message and is still sent on
every join.
