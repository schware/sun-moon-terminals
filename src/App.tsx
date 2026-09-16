import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  changeStatus,
  fetchBusinessDayStatus,
  fetchOrders,
  formatAmount,
  formatTime,
  STATUS_LABEL,
  type BusinessDayStatus,
  type Order,
  tableLabel
} from './lib/deviceServer'
import { useTerminalSocket } from './lib/useTerminalSocket'

/** How often to re-ask which 판매일자 this store is on. Same cadence as POS. */
const BUSINESS_DAY_POLL_MS = 30000

/**
 * Which terminal this window is. Identical scheme to sun-moon-terminal-pos
 * — see that repo's App.tsx for the reasoning (per-tab identity, ?storeId=
 * &deviceId= pinning). Duplicated rather than shared because these ship as
 * independent static bundles with no server of their own.
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
    <Kds
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

function Kds({ deviceId, storeId, onForget }:
  { deviceId: string; storeId: string; onForget: () => void }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [businessDay, setBusinessDay] = useState<BusinessDayStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      // Filtered here rather than at the API, which has no per-store query
      // yet — same reasoning as sun-moon-terminal-pos.
      setOrders((await fetchOrders()).filter((o) => o.storeId === storeId))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
  }, [storeId])

  const reloadBusinessDay = useCallback(async () => {
    try {
      setBusinessDay(await fetchBusinessDayStatus(storeId))
    } catch {
      // Left as it was rather than cleared to "closed": a failed status
      // call is not evidence the store shut, and treating it as one would
      // blank a working kitchen screen mid-service.
    }
  }, [storeId])

  const connection = useTerminalSocket(deviceId, storeId, 'KDS', reload)

  // Polling as well as the socket — a nudge that never arrives must not
  // leave a kitchen staring at an empty screen while tickets pile up.
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15000)
    return () => window.clearInterval(timer)
  }, [reload])

  useEffect(() => {
    void reloadBusinessDay()
    const timer = window.setInterval(() => void reloadBusinessDay(), BUSINESS_DAY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [reloadBusinessDay])

  /**
   * 판매일자 scoping, added 2026-09-15.
   *
   * The board shows only orders stamped with the 영업일자 the store is
   * currently on. That is what makes 개점 clear the screen: a ticket
   * nobody finished last night belongs to yesterday's 판매일자 and stops
   * being this morning's problem the moment the day rolls.
   *
   * Derived rather than held in state, so there is no "reset" to run and
   * nothing to forget to run it on — when the polled 판매일자 changes, the
   * lists re-filter on the next render without re-fetching anything.
   *
   * A closed store has no open 영업일자 and therefore no orders that
   * belong to today. The board goes empty and says why, rather than
   * quietly showing nothing.
   */
  const today = businessDay?.open ? businessDay.businessDate ?? null : null
  const inToday = useCallback(
    (order: Order) => today !== null && order.businessDate === today,
    [today]
  )

  const cooking = useMemo(
    // The Device Server's push already targets one KDS when a menu is
    // assigned to one — this mirrors that on the list itself, because a
    // 15s poll or a fresh page load fetches every ACCEPTED order at the
    // store with no filtering of its own. No assignment (null) means
    // every KDS should see it, matching the push's own fallback.
    () => orders.filter((o) => inToday(o)
      && o.status === 'ACCEPTED'
      && (o.kdsDeviceId == null || o.kdsDeviceId === deviceId)),
    [orders, inToday, deviceId]
  )

  const recent = useMemo(
    () => orders.filter((o) => inToday(o)
      && (o.status === 'PRODUCED' || o.status === 'DELIVERING' || o.status === 'COMPLETED'))
      .slice(0, 12),
    [orders, inToday]
  )

  async function complete(order: Order) {
    setBusyId(order.id)
    setError(null)
    try {
      await changeStatus(order.id, 'PRODUCED', deviceId)
    } catch (e) {
      // Usually a 409: another KDS screen in the same kitchen got there
      // first. Either way this screen is now out of date, so refresh
      // rather than argue with the server about it.
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
          <h1>KDS 주방 화면</h1>
          <span className="muted">
            {storeId} · {deviceId}
            {today && <> · 판매일자 {today}</>}
          </span>
        </div>
        <span className={`conn ${connection}`}>
          {connection === 'open' ? '연결됨'
            : connection === 'connecting' ? '연결 중'
            : connection === 'displaced' ? '중복 장비'
            : '끊김'}
        </span>
      </header>

      {connection === 'closed' && (
        <div className="warn" role="status">
          Device Server와 연결이 끊겼습니다. 재연결을 시도하는 동안 주문은 15초마다 새로 읽습니다.
        </div>
      )}
      {connection === 'displaced' && (
        <div className="error" role="alert">
          <strong>{storeId} / {deviceId}</strong> 단말을 다른 창에서 열었습니다.
          한 단말은 한 연결만 가질 수 있어서 이 창의 연결은 닫혔습니다.
          {' '}
          <button className="btn link" onClick={onForget}>지금 바꾸기</button>
        </div>
      )}
      {businessDay !== null && !businessDay.open && (
        <div className="warn" role="status">
          <strong>{storeId}</strong> 매장이 개점 전이거나 마감된 상태입니다.
          판매일자가 없으므로 이 화면에는 주문이 표시되지 않습니다 — POS에서 개점하면
          그 판매일자의 주문부터 다시 올라옵니다.
        </div>
      )}
      {businessDay?.open && businessDay.needsClosing && (
        <div className="warn" role="status">
          판매일자 <strong>{businessDay.businessDate}</strong>가 아직 열려 있습니다.
          POS에서 마감하면 이 화면도 새 판매일자로 넘어갑니다.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}

      <section>
        <h2>
          조리 대기
          {cooking.length > 0 && <span className="count">{cooking.length}</span>}
        </h2>
        {cooking.length === 0 ? (
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '조리할 주문이 없습니다.'}
          </div>
        ) : (
          <div className="cards">
            {cooking.map((order) => (
              <article className="card" key={order.id}>
                <div className="card-head">
                  <span className="order-no">#{order.id}</span>
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
                  <span className="muted">{formatTime(order.updatedAt)}</span>
                </div>
                <div className="customer">{order.menuName}</div>
                <div className="amount">{formatAmount(order.amount)}</div>
                <div className="row">
                  <button
                    className="btn accept"
                    disabled={busyId === order.id}
                    onClick={() => void complete(order)}
                  >
                    조리완료
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>최근 완료</h2>
        {recent.length === 0 ? (
          <div className="empty">아직 완료한 주문이 없습니다.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>번호</th><th>메뉴</th><th>금액</th><th>상태</th><th>시각</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((order) => (
                  <tr key={order.id}>
                    <td className="muted">#{order.id}</td>
                    <td>{order.menuName}</td>
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
        <span className="muted">
          매장 {storeId} · 장비 {deviceId}
          {today ? ` · 판매일자 ${today}` : ' · 판매일자 없음'}
        </span>
        <button className="btn link" onClick={onForget}>매장·장비 변경</button>
      </footer>
    </div>
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
          기억하므로, 새 창을 열어 다른 매장을 함께 볼 수 있습니다.
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
          placeholder="장비 ID — kds-01"
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
