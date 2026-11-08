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

### Which is why it has to remember what it has shown (2026-09-15)

The first version of that idea had a bug bad enough to be visible from
across the room: cards came back. An order's 15 seconds ended, the
expiry tick deleted the card, and then the very next poll fetched the
same order — still `PRODUCED`, because nothing moves it past that —
found no record of it, and gave it a fresh 15 seconds. Show, vanish,
show, vanish, all day.

So an order id is recorded **as its card leaves** and skipped on every
later fetch. Recorded on the way out rather than on the way in, so an
order still on screen when the tab closes gets its window again, while
one that has had it never comes back.

Kept in `sessionStorage` (per tab, like the terminal's own identity, so
two windows watching different shops do not share it) and capped at 500
ids — a wall display runs for weeks, and this set is the one thing here
that would otherwise only grow. Losing it costs one replayed card, which
is why every access is wrapped rather than relied on.

The real fix is upstream: once a delivery channel moves orders past
`PRODUCED`, the server stops handing this screen the same order forever.
Until then this is what keeps the board still.

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
| `VITE_DEVICE_SERVER` | `http://61.73.134.2:8087` |

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

## 판매일자, per store (2026-09-15)

A card is shown only while its order's **판매일자 matches the one its own
store is currently on** — asked for per store every 30 seconds
(`GET /business-days/status`), because this board can watch several
branches and **a food court does not close as a unit**. One shop's 마감
clears only its own cards; the rest keep trading.

Filtered at render rather than at fetch, so 개점 and 마감 take effect on
the next tick instead of the next poll, and so there is no separate
reset step to remember. A store not yet asked about shows nothing rather
than everything — the first paint after a reload should not flash
yesterday's orders for the half second before the status call lands.

## Not built yet

- **Nothing moves an order past PRODUCED.** That is the delivery channel,
  which does not exist yet — see the umbrella's roadmap. Until it does,
  this screen's 15-second window is the only thing that ever makes an
  order stop being shown as ready.
- **No authentication**, same reasoning as sun-moon-terminal-pos: every
  order in this system is a sample by design.
- Device ids are not checked against BO's device list yet.
