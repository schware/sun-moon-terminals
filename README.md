# sun-moon-terminal-did

The **DID (store-facing display)**: shows an order for 15 seconds once
the kitchen marks it 조리완료.

React + TypeScript, no server of its own — it builds to static files
served from the `:8000` hub at `/did/`. Same shape as
[sun-moon-terminal-pos](https://github.com/schware/sun-moon-terminal-pos)
and
[sun-moon-terminal-kds](https://github.com/schware/sun-moon-terminal-kds),
purely a display — no button anywhere presses anything.

## How it fits

```
Order(8083) ──PRODUCED event──▶ Device Server(8087) ──WebSocket──▶ this screen
```

`OrderEventSubscriber.audienceFor` routes `PRODUCED` here specifically.
This screen never learns where Order lives, and never calls
`changeStatus` — see [Not built yet](#not-built-yet) for what advances an
order past PRODUCED.

## The 15-second window is this screen's invention, not Order's

`PRODUCED` is not itself a 15-second server state — nothing moves an
order past it until a delivery channel exists, so an order can sit
`PRODUCED` for as long as nobody builds one. This screen tracks, in its
own memory, when it *first* saw each order and shows it for 15 seconds
from that moment, independent of how long the order has actually been
`PRODUCED` for.

Consequence: a screen that reloads mid-shift will show every currently
`PRODUCED` order fresh for 15 seconds, even ones that have been ready for
an hour, because "already shown" is not persisted anywhere. Acceptable
today because nothing yet lets `PRODUCED` orders pile up for long — worth
revisiting once the delivery channel exists and that stops being true.

**The WebSocket is a nudge, not the data** — see sun-moon-terminal-pos's
README for the reasoning. It also polls every 15 seconds; that call only
adds and refreshes cards, a separate 500ms tick is what actually expires
them, so a missed nudge costs a delay in *appearing*, never in
*disappearing* late.

## Build

```bash
npm install
npm run build          # → dist/
```

| Variable | Default |
|---|---|
| `VITE_DEVICE_SERVER` | `http://211.217.183.232:8087` |

Build-time, not runtime — see sun-moon-terminal-pos's README for why the
default is the public address rather than the LAN one.

## Deploy

```bash
tar -czf - -C dist . | ssh schware@192.168.0.2 \
  'rm -rf ~/apps/docker/nginx/html/did/assets && tar xzf - -C ~/apps/docker/nginx/html/did'
```

No restart. **Check in a private window** — sun-moon-terminal-pos's
README has the full story on why a stale `index.html` can survive a
deploy, and the log command to confirm which bundle a browser took.

## Store and device id

Identical scheme to sun-moon-terminal-pos: per-tab `sessionStorage`, a
`localStorage` prefill only, `?storeId=&deviceId=` pinning a screen
mounted on a wall.

## Watching several stores at once (2026-09-13)

`storeId` may be a comma-separated list —
`?storeId=store-01,store-02&deviceId=did-mall-01` — a food-court style
board rather than one branch's screen. Each ready card shows which store
it belongs to once more than one is being watched.

The Device Server's `TerminalHandshakeHandler` parses the same string
the same way and registers this connection into every one of those
stores' DID groups, so it receives the push the moment *any* of them has
a `PRODUCED` order — nothing about the push path changed for this. A
single store is just the one-element case; POS and KDS still require
exactly one, since a counter is physically at one store and a list there
is rejected as a mistake rather than silently truncated.

## Not built yet

- **Nothing moves an order past PRODUCED.** That is the delivery channel,
  which does not exist yet — see the umbrella's roadmap. Until it does,
  this screen's 15-second window is the only thing that ever makes an
  order stop being shown as ready.
- **No authentication**, same reasoning as sun-moon-terminal-pos: every
  order in this system is a sample by design.
- Device ids are not checked against BO's device list yet.
