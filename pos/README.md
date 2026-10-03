# sun-moon-terminal-pos

The **POS terminal**: shows orders waiting to be accepted, and accepts or
refuses them. Also where a store 개점 (opens) and 마감 (closes) for the
day — see [영업일](#영업일-개점--마감) below.

React + TypeScript, no server of its own — it builds to static files
served from the `:8000` hub at `/pos/`.

## How it fits

```
Order(8083) ──event──▶ Device Server(8087) ──WebSocket──▶ this screen
                            ▲                                  │
                            └──── GET /orders, POST /orders/status ┘
```

Everything goes through the **Device Server**. This app never learns where
Order lives, so Order can move without anyone touching a screen mounted in
a shop.

**The WebSocket is a nudge, not the data.** A frame means *something
changed*; the app then asks for the current list. That is what makes a
terminal that was unplugged for a minute come back correct instead of
showing whatever frames it happened to catch. It also polls every 15
seconds, so a nudge that never arrives cannot leave a shop staring at an
empty screen.

## 영업일 (개점 / 마감)

Order stamps every order with the 영업일자 that was open when it arrived,
and refuses to place one at all for a store that hasn't 개점'd — see the
Order repo's README and umbrella `docs/adr/0006`. That state has to be
reachable from *somewhere real*, and this screen is it: the bar under
the header shows whether the store is open and lets a POS operator press
개점 or 마감, proxied through the Device Server exactly like everything
else here (`GET /business-days/status`, `POST /business-days/{open,close}`).

This existed as a backend-only feature for three days before anyone
noticed no screen could actually reach it — every store on the deploy
server had only ever been opened by a direct API call, never a button
press, until this was added 2026-09-13.

**개점 on a day left open from a stale 영업일자** closes that day first
and starts today fresh (the response says `rolled: true`); **개점 twice
on the same day** (e.g. after a 마감 pressed by mistake) just resumes
that day rather than erroring. Neither needs special handling here — the
screen shows whatever came back and reloads its status either way.

## Build

```bash
npm install
npm run build          # → dist/
```

| Variable | Default |
|---|---|
| `VITE_DEVICE_SERVER` | `http://sunmoonwork.duckdns.org:8087` |

Build-time, not runtime: these are static files with no server of their
own to ask. **That makes the default load-bearing** — a build that picks
up the wrong one still loads, and only fails later with "Device Server와
연결이 끊겼습니다". The default was the LAN address until 2026-09-10,
which meant the deployed screen worked from inside the LAN and nowhere
else.

Use the LAN address only for a build that will be opened on the LAN:

```bash
VITE_DEVICE_SERVER=http://192.168.0.2:8087 npm run build
```

## Deploy

Copy `dist/` to the hub's static directory as `pos/`. **`scp` does not
work against this host** — its sshd answers `subsystem request failed` —
so pipe a tar over plain ssh instead:

```bash
tar -czf - -C dist . | ssh schware@192.168.0.2 \
  'rm -rf ~/apps/docker/nginx/html/pos/assets && tar xzf - -C ~/apps/docker/nginx/html/pos'
```

Removing `assets/` first keeps old hashed bundles from piling up.

No restart — nginx serves that directory from a volume mount.

**Then load it in a private window to check.** Asset filenames are
content-hashed, but `index.html` is not, and nginx sends no
`Cache-Control` for it — so a browser can keep serving the previous
`index.html` and with it the previous bundle, long after a deploy. On
2026-09-10 that made a fixed screen look unfixed for half an hour. The
server side of that is easy to confirm: nginx's access log names the
exact bundle each browser took.

```bash
ssh schware@192.168.0.2 "docker logs --tail 40 sun-moon-landing 2>&1 | grep 'GET /pos'"
```

## Store and device id

Asked for once **per browser window** and kept in `sessionStorage`.

That is deliberate: `localStorage` is shared across every tab of an
origin, so a second window would silently become the same terminal as the
first — and watching two shops side by side is exactly what this is for.
A tab keeps its identity across a reload and forgets it when closed. The
last values used are mirrored into `localStorage` only to prefill the
form, so opening a window for another shop is two edits rather than
clearing storage.

`?storeId=store-01&deviceId=pos-01` in the URL wins over both, which is
how a screen bolted to a counter gets pinned without anyone typing.

Both are required. A device id without a store cannot be routed to — the
Device Server refuses the handshake — and defaulting the store would mean
guessing which counter an order belongs to.

The id is presented at the WebSocket handshake and the Device Server
refuses anything malformed. **It is not yet checked against BO's device
list** — see the Device Server's `AcceptKnownFormatDirectory`.

## Not built yet

- **No authentication, and this is reachable from the internet.** The hub
  that serves this page is public, and the Device Server it calls is open
  on 8087, so anyone who finds the URL can list orders — customer ids and
  amounts included — and press 수락 or 거절. The device id is typed in by
  whoever opens the page; it identifies a screen, it does not authenticate
  one.

  This is acceptable because **every order in this system is a sample by
  design** — the order channel offers a fixed set of demo orders and has
  no way to enter a real one. That is a boundary, not an oversight: the
  platform is built to be shown, and nothing in it belongs to anybody.

  If that ever stops being true, authentication comes first. The cheapest
  route is already scaffolded — the Device Server checks device ids
  through a `DeviceDirectory` port whose real implementation asks BO,
  which owns the device list. What is missing there is a decision about
  service-to-service credentials, not code. One direction for this
  screen specifically: log in with an id/password instead of typing a
  store and device id, and let the server resolve both from that
  credential — which would remove the two free-text fields the
  "단말 등록" prompt asks for today.
- Delivery progress is shown as a status column, not as the live tracking
  the flow eventually wants.
