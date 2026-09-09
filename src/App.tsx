import { useCallback, useEffect, useState } from 'react'
import {
  changeStatus,
  fetchOrders,
  formatAmount,
  formatTime,
  STATUS_LABEL,
  type Order
} from './lib/deviceServer'
import { useTerminalSocket } from './lib/useTerminalSocket'

/**
 * A terminal is a fixed thing in a shop, so it is asked for its device id
 * once and then remembers. Baking the id into a build per screen would
 * mean a rebuild to move one between counters.
 */
export default function App() {
  const query = new URLSearchParams(window.location.search)
  const [deviceId, setDeviceId] = useState<string>(
    () => query.get('deviceId') ?? localStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => query.get('storeId') ?? localStorage.getItem('storeId') ?? ''
  )

  // Both, or neither. A device id without a shop cannot be routed to, so
  // there is no useful half-configured state to sit in.
  if (!deviceId || !storeId) {
    return (
      <TerminalPrompt
        onChosen={(store, device) => {
          localStorage.setItem('storeId', store)
          localStorage.setItem('deviceId', device)
          setStoreId(store)
          setDeviceId(device)
        }}
      />
    )
  }

  return (
    <Pos
      deviceId={deviceId}
      storeId={storeId}
      onForget={() => {
        localStorage.removeItem('deviceId')
        localStorage.removeItem('storeId')
        setDeviceId('')
        setStoreId('')
      }}
    />
  )
}

function Pos({ deviceId, storeId, onForget }:
  { deviceId: string; storeId: string; onForget: () => void }) {
  const [waiting, setWaiting] = useState<Order[]>([])
  const [recent, setRecent] = useState<Order[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      // Filtered here rather than at the API, which has no per-store query
      // yet. It is a screen in one shop, so anything else is not its
      // business — and showing it would be worse than showing nothing.
      const all = (await fetchOrders()).filter((o) => o.storeId === storeId)
      setWaiting(all.filter((o) => o.status === 'PLACED'))
      setRecent(all.filter((o) => o.status !== 'PLACED').slice(0, 12))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
  }, [storeId])

  const connection = useTerminalSocket(deviceId, storeId, 'POS', reload)

  // Polling as well as the socket. A nudge that never arrives must not
  // leave a shop staring at an empty screen while orders pile up — the
  // socket makes it immediate, this makes it certain.
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15000)
    return () => window.clearInterval(timer)
  }, [reload])

  async function decide(order: Order, next: 'ACCEPTED' | 'REJECTED') {
    setBusyId(order.id)
    setError(null)
    try {
      await changeStatus(order.id, next, deviceId)
    } catch (e) {
      // Usually a 409: it expired, or another terminal took it first.
      // Either way this screen is now out of date, so refresh rather
      // than argue with the server about it.
      setError(e instanceof Error ? e.message : '처리하지 못했습니다')
    } finally {
      setBusyId(null)
      await reload()
    }
  }

  return (
    <div className="shell">
      <header className="bar">
        <div>
          <h1>POS 단말</h1>
          <span className="muted">{storeId} · {deviceId}</span>
        </div>
        <span className={`conn ${connection}`}>
          {connection === 'open' ? '연결됨' : connection === 'connecting' ? '연결 중' : '끊김'}
        </span>
      </header>

      {connection === 'closed' && (
        <div className="warn" role="status">
          Device Server와 연결이 끊겼습니다. 재연결을 시도하는 동안 주문은 15초마다 새로 읽습니다.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <section>
        <h2>
          수락 대기
          {waiting.length > 0 && <span className="count">{waiting.length}</span>}
        </h2>
        {waiting.length === 0 ? (
          <div className="empty">대기 중인 주문이 없습니다.</div>
        ) : (
          <div className="cards">
            {waiting.map((order) => (
              <article className="card" key={order.id}>
                <div className="card-head">
                  <span className="order-no">#{order.id}</span>
                  <span className="muted">{formatTime(order.placedAt)}</span>
                </div>
                <div className="customer">{order.customerId}</div>
                <div className="amount">{formatAmount(order.amount)}</div>
                <div className="row">
                  <button
                    className="btn accept"
                    disabled={busyId === order.id}
                    onClick={() => void decide(order, 'ACCEPTED')}
                  >
                    수락
                  </button>
                  <button
                    className="btn reject"
                    disabled={busyId === order.id}
                    onClick={() => void decide(order, 'REJECTED')}
                  >
                    거절
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>최근 주문</h2>
        {recent.length === 0 ? (
          <div className="empty">아직 처리된 주문이 없습니다.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>번호</th><th>고객</th><th>금액</th><th>상태</th><th>변경</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((order) => (
                  <tr key={order.id}>
                    <td className="muted">#{order.id}</td>
                    <td>{order.customerId}</td>
                    <td>{formatAmount(order.amount)}</td>
                    <td>
                      <span className={`status ${order.status.toLowerCase()}`}>
                        {STATUS_LABEL[order.status]}
                      </span>
                    </td>
                    <td className="muted">{formatTime(order.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer>
        <span className="muted">매장 {storeId} · 장비 {deviceId}</span>
        <button className="btn link" onClick={onForget}>장비 변경</button>
      </footer>
    </div>
  )
}

function TerminalPrompt({ onChosen }: { onChosen: (storeId: string, deviceId: string) => void }) {
  const [store, setStore] = useState('')
  const [device, setDevice] = useState('')
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
          이 화면이 속한 매장과 장비 ID를 입력하세요. 한 번만 입력하면 기억합니다.
        </p>
        <input
          type="text"
          autoFocus
          placeholder="매장 ID — store-01"
          value={store}
          onChange={(e) => setStore(e.target.value)}
        />
        <input
          type="text"
          placeholder="장비 ID — pos-01"
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
