---
name: partforge-request-pick
description: Use when editing a partforge part for a user who has the live app open and you need them to point at geometry — ask for one or more clicks and get the Selection(s) back.
---

# partforge: request-a-pick

When you're editing a partforge part and you're unsure *which* face, edge, hole, or
sub-part the user means, don't guess — ask them to click it in the live app. Their
click comes back to you as a structured `Selection` (sub-part, local CAD point,
surface normal, the parameters they were viewing).

## When to use

- The user's request is geometrically ambiguous ("make this thicker", "fillet that
  edge", "move the hole") and more than one feature could match.
- You need a concrete location/normal to drive an edit.

## One-time setup (per session)

Start the pick-server (it bridges the app and this CLI). The user must have the app
open with `?pickserver` (e.g. `http://localhost:5173/?pickserver`).

```bash
partforge pick-serve &     # default http://127.0.0.1:4518
```

## Requesting clicks

Ask for one or many — they're collected in order and returned together:

```bash
partforge pick "click the face you want filleted"
partforge pick "click the mounting hole" "click the top edge" "click the boss"
```

Tell the user out loud to check their browser ("I've put a prompt in your browser —
click the face you want filleted"). The command **blocks** until they click (or
timeout), then prints a summary plus JSON:

```json
{ "status": "done", "picks": [ { "prompt": "...", "selection": { "subPart": "...", "point": [...], "normal": [...], "params": {...} } } ] }
```

Picks come back **in request order**, each echoing its prompt, so you can map them.

## Handling outcomes

- `done` — proceed with the returned `selection`(s).
- `timeout` — the user didn't click in time; `picks` holds any collected so far. Ask
  again or fall back to asking in words.
- `cancelled` — the user clicked "Can't find it"; reconsider what you're asking for.
- `busy` (exit non-zero) — a request is already in flight; wait and retry.

## Notes

- This only *reads* a click — it never edits files. You make the edits yourself after.
- The server is localhost-only and holds one request at a time.
