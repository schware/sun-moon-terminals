# sun-moon-terminal-pos

The **POS terminal**: shows orders waiting to be accepted, and accepts or
refuses them.

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

## Build

```bash
npm install
npm run build          # → dist/
```

| Variable | Default |
|---|---|
| `VITE_DEVICE_SERVER` | `http://192.168.0.2:8087` |

Build-time, not runtime: these are static files with no server of their
own to ask.

```bash
VITE_DEVICE_SERVER=http://192.168.0.2:8087 npm run build
```

## Deploy

Copy `dist/` to the hub's static directory as `pos/`:

```bash
scp -r dist/* schware@192.168.0.2:~/apps/docker/nginx/html/pos/
```

No restart — nginx serves that directory from a volume mount.

## Device id

Asked for once and kept in `localStorage`; `?deviceId=pos-01` sets it
without typing. A terminal is a fixed thing in a shop, so baking the id
into a build per screen would mean rebuilding to move one between
counters.

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

  That is a deliberate choice while every order in the system is invented
  for a demo. **It has to change before any real order exists.** The
  cheapest fix is already scaffolded: the Device Server checks device ids
  through a `DeviceDirectory` port whose real implementation asks BO,
  which owns the device list — what is missing is a decision about
  service-to-service credentials, not code.
- Delivery progress is shown as a status column, not as the live tracking
  the flow eventually wants.
