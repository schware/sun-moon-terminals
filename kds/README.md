# sun-moon-terminal-kds

The **KDS (Kitchen Display System)**: shows accepted orders and reports
조리완료.

React + TypeScript, no server of its own — it builds to static files
served from the `:8000` hub at `/kds/`. Same shape as
[sun-moon-terminal-pos](https://github.com/schware/sun-moon-terminal-pos),
one screen earlier in the order's life.

## How it fits

```
Order(8083) ──ACCEPTED event──▶ Device Server(8087) ──WebSocket──▶ this screen
                                     ▲                                  │
                                     └──── GET /orders, POST /orders/status ┘
```

The Device Server decides who sees what — `ACCEPTED` goes to KDS,
`PLACED` to POS, `PRODUCED` to DID
(`OrderEventSubscriber.audienceFor`). This screen never learns where
Order lives.

**The WebSocket is a nudge, not the data** — see
sun-moon-terminal-pos's README for the reasoning. It also polls every
15 seconds so a missed nudge cannot leave a kitchen staring at an empty
screen.

## 판매일자 (2026-09-15)

The board shows only orders stamped with the **영업일자 the store is
currently on**, which it asks the Device Server for every 30 seconds
(`GET /business-days/status`, the same call POS uses to draw its
개점/마감 bar).

That is what makes 개점 clear the screen. Before this, every `ACCEPTED`
order at the store stayed on the board forever — a ticket nobody
finished last night was still there this morning, in among today's, with
no way to clear it short of finishing an order that no longer existed.

Orders have carried 판매일자 since 2026-09-10. This app's own `Order`
interface simply did not declare the field, so it arrived on every fetch
and was discarded; declaring it and filtering on it is the whole fix.

The filter is **derived, not stored** — there is no reset to run, and so
nothing to forget to run it on. When the polled 판매일자 changes, the
lists re-filter on the next render.

A **closed store** has no open 영업일자 and therefore nothing that
belongs to today: the board empties and says why rather than just going
blank. A *failed* status call is different and leaves the previous
answer in place — a call that did not come back is not evidence a shop
shut, and treating it as one would blank a working kitchen screen in the
middle of service.

## Build

```bash
npm install
npm run build          # → dist/
```

| Variable | Default |
|---|---|
| `VITE_DEVICE_SERVER` | `http://61.73.134.2:8087` |

Build-time, not runtime — see sun-moon-terminal-pos's README for why
the default is the public address rather than the LAN one.

## Deploy

```bash
tar -czf - -C dist . | ssh schware@192.168.0.2 \
  'rm -rf ~/apps/docker/nginx/html/kds/assets && tar xzf - -C ~/apps/docker/nginx/html/kds'
```

No restart — nginx serves that directory from a volume mount. **Check in
a private window** — `index.html` is not content-hashed and nginx sends
no `Cache-Control` for it, so a stale bundle can keep serving after a
deploy. sun-moon-terminal-pos's README has the full story and the log
command to confirm which bundle a browser actually took.

## Store and device id

Identical scheme to sun-moon-terminal-pos: per-tab `sessionStorage`, a
`localStorage` prefill only, `?storeId=&deviceId=` pinning a screen bolted
to a counter. See that repo's README for why.

## Not built yet

- **A second KDS screen in the same kitchen finds out late.** The Device
  Server only pushes `ACCEPTED` events to KDS
  (`OrderEventSubscriber.audienceFor`) — there is no push for "an order
  left the KDS queue." A screen that marks 조리완료 itself removes that
  order immediately (the click's own `reload()`), but a second screen in
  the same store only notices via its own 15s poll. Confirmed live on
  2026-09-13: moving an order to `PRODUCED` from outside the UI left it
  showing on an already-open KDS tab for up to 15s before the poll caught
  up. Fixing it for real means Device Server pushing something on
  `PRODUCED` to KDS too, not just to DID.
- **No authentication**, for the same reason as sun-moon-terminal-pos:
  every order in this system is a sample by design.
- **One item per order.** The kitchen ticket shows `menuName` as a single
  line because an order is one menu item today — no cart yet.
- Device ids are not checked against BO's device list — same open item
  as POS's `AcceptKnownFormatDirectory`.
