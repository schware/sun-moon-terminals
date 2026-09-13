import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchOrders, type Order } from './lib/deviceServer'
import { useTerminalSocket } from './lib/useTerminalSocket'

const DISPLAY_MS = 15000

interface ReadyOrder {
  order: Order
  expiresAt: number
}

/**
 * Which terminal this window is. Identical scheme to sun-moon-terminal-pos
 * — see that repo's App.tsx for the reasoning.
 */
export default function App() {
  const query = new URLSearchParams(window.location.search)
  const [deviceId, setDeviceId] = useState<string>(
    () => query.get('deviceId') ?? sessionStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => query.get('storeId') ?? sessionStorage.getItem('storeId') ?? ''
  )

  if (!deviceId || !storeId) {
    return (
      <TerminalPrompt
        onChosen={(store, device) => {
          sessionStorage.setItem('storeId', store)
          sessionStorage.setItem('deviceId', device)
          localStorage.setItem('lastStoreId', store)
          localStorage.setItem('lastDeviceId', device)
          setStoreId(store)
          setDeviceId(device)
        }}
      />
    )
  }

  return (
    <Did
      deviceId={deviceId}
      storeId={storeId}
      onForget={() => {
        sessionStorage.removeItem('deviceId')
        sessionStorage.removeItem('storeId')
        setDeviceId('')
        setStoreId('')
      }}
    />
  )
}

function Did({ deviceId, storeId, onForget }:
  { deviceId: string; storeId: string; onForget: () => void }) {
  const [ready, setReady] = useState<Map<number, ReadyOrder>>(new Map())
  const [error, setError] = useState<string | null>(null)
  // Read inside the setState updater below, not as a dependency — this
  // must not itself trigger a reload.
  const readyRef = useRef(ready)
  readyRef.current = ready

  // A comma-separated storeId is a food-court style board watching
  // several branches at once — see the Device Server's
  // TerminalHandshakeHandler, which parses the same string the same way.
  // A single store is just the length-1 case of this, unchanged.
  const storeIds = storeId.split(',').map((s) => s.trim()).filter(Boolean)
  const isMultiStore = storeIds.length > 1

  /**
   * Pulls PRODUCED orders across every watched store and merges them in.
   * An order already being shown keeps its original `expiresAt` —
   * re-fetching must not restart its countdown, or a screen that polls
   * every 15s could show the same order forever.
   *
   * <p>PRODUCED is not itself a 15-second state on the server — nothing
   * moves an order past it until the delivery channel exists. The 15s
   * window is this screen's own invention: "show it fresh for 15 seconds
   * after *this screen* first saw it," not "for 15 seconds after Order
   * says so." A screen that reloads after an order has been ready for an
   * hour will still show it fresh for 15s, because there is nowhere
   * (yet) to persist "already shown."
   */
  const reload = useCallback(async () => {
    try {
      const produced = (await fetchOrders('PRODUCED')).filter((o) => storeIds.includes(o.storeId))
      setReady((prev) => {
        const next = new Map<number, ReadyOrder>()
        for (const order of produced) {
          const existing = prev.get(order.id)
          next.set(order.id, existing ?? { order, expiresAt: Date.now() + DISPLAY_MS })
        }
        return next
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
    // storeIds is derived fresh from storeId every render — depending on
    // storeId itself (a primitive) instead keeps this stable across
    // renders the way the array literal would not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

  const connection = useTerminalSocket(deviceId, storeId, 'DID', reload)

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15000)
    return () => window.clearInterval(timer)
  }, [reload])

  // A separate, faster tick just to expire cards — reload() only adds and
  // refreshes, it never removes on a timer of its own.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (![...readyRef.current.values()].some((r) => r.expiresAt <= now)) return
      setReady((prev) => {
        const next = new Map(prev)
        for (const [id, r] of prev) {
          if (r.expiresAt <= now) next.delete(id)
        }
        return next
      })
    }, 500)
    return () => window.clearInterval(timer)
  }, [])

  const cards = [...ready.values()].sort((a, b) => a.order.id - b.order.id)

  return (
    <div className="did-shell">
      <header className="did-bar">
        <span className="muted">
          {isMultiStore ? `매장 ${storeIds.length}개 (${storeIds.join(', ')})` : storeId} · {deviceId}
        </span>
        <span className={`conn ${connection}`}>
          {connection === 'open' ? '연결됨'
            : connection === 'connecting' ? '연결 중'
            : connection === 'displaced' ? '중복 장비'
            : '끊김'}
        </span>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {cards.length === 0 ? (
        <div className="did-empty">준비된 주문을 기다리는 중…</div>
      ) : (
        <div className="did-grid">
          {cards.map(({ order, expiresAt }) => (
            <ReadyCard key={order.id} order={order} expiresAt={expiresAt} showStore={isMultiStore} />
          ))}
        </div>
      )}

      {connection === 'displaced' && (
        <div className="error" role="alert">
          <strong>{storeId} / {deviceId}</strong> 단말을 다른 창에서 열었습니다.
          {' '}<button className="btn link" onClick={onForget}>지금 바꾸기</button>
        </div>
      )}
    </div>
  )
}

function ReadyCard({ order, expiresAt, showStore }: { order: Order; expiresAt: number; showStore: boolean }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()))
    }, 200)
    return () => window.clearInterval(timer)
  }, [expiresAt])

  const fraction = Math.max(0, Math.min(1, remaining / 15000))

  return (
    <article className="ready-card">
      {showStore && <div className="ready-store">{order.storeId}</div>}
      <div className="ready-no">#{order.id}</div>
      <div className="ready-menu">{order.menuName}</div>
      <div className="ready-bar"><div className="ready-bar-fill" style={{ width: `${fraction * 100}%` }} /></div>
    </article>
  )
}

function TerminalPrompt({ onChosen }: { onChosen: (storeId: string, deviceId: string) => void }) {
  const [store, setStore] = useState(() => localStorage.getItem('lastStoreId') ?? '')
  const [device, setDevice] = useState(() => localStorage.getItem('lastDeviceId') ?? '')
  return (
    <div className="prompt">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          onChosen(store.trim(), device.trim())
        }}
      >
        <h1>단말 등록</h1>
        <p className="muted">
          이 화면이 속한 매장과 장비 ID를 입력하세요. <strong>창(탭)마다 따로</strong>
          기억하므로, 새 창을 열어 다른 매장을 함께 볼 수 있습니다. 매장 ID를
          쉼표로 여러 개 적으면(예: <code>store-01,store-02</code>) 이 화면
          하나가 여러 매장의 준비완료 주문을 함께 보여줍니다.
        </p>
        <input
          type="text"
          autoFocus
          placeholder="매장 ID — store-01 또는 store-01,store-02"
          value={store}
          onChange={(e) => setStore(e.target.value)}
        />
        <input
          type="text"
          placeholder="장비 ID — did-01"
          value={device}
          onChange={(e) => setDevice(e.target.value)}
        />
        <button className="btn accept" type="submit" disabled={!store.trim() || !device.trim()}>
          시작
        </button>
      </form>
    </div>
  )
}
