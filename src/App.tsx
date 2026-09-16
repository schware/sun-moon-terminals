import { useCallback, useEffect, useState } from 'react'
import {
  changeStatus,
  closeBusinessDay,
  fetchMenuBoard,
  fetchOrders,
  formatAmount,
  formatTime,
  isMenuEvent,
  openBusinessDay,
  fetchBusinessDayStatus,
  STATUS_LABEL,
  type BusinessDayStatus,
  type MenuBoardItem,
  type Order,
  type TerminalEvent,
  tableLabel
} from './lib/deviceServer'
import { useTerminalSocket } from './lib/useTerminalSocket'

/**
 * Which terminal this window is.
 *
 * <p>Held in `sessionStorage`, which is **per tab** — that is the whole
 * point. `localStorage` is shared across every tab of an origin, so a
 * second window would silently become the same terminal as the first, and
 * two shops could not be watched side by side. A tab keeps its identity
 * across a reload and forgets it when closed.
 *
 * <p>The last values used are mirrored into `localStorage`, but only to
 * prefill the form. A new window still asks, so opening one for another
 * shop is a matter of editing two fields rather than clearing storage.
 *
 * <p>`?storeId=&deviceId=` in the URL wins over both, which is how a
 * screen bolted to a counter gets pinned without anyone typing.
 */
export default function App() {
  const query = new URLSearchParams(window.location.search)
  const [deviceId, setDeviceId] = useState<string>(
    () => query.get('deviceId') ?? sessionStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => query.get('storeId') ?? sessionStorage.getItem('storeId') ?? ''
  )

  // Both, or neither. A device id without a shop cannot be routed to, so
  // there is no useful half-configured state to sit in.
  if (!deviceId || !storeId) {
    return (
      <TerminalPrompt
        onChosen={(store, device) => {
          sessionStorage.setItem('storeId', store)
          sessionStorage.setItem('deviceId', device)
          // Convenience only — the next window prefills from these and
          // still asks.
          localStorage.setItem('lastStoreId', store)
          localStorage.setItem('lastDeviceId', device)
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
        sessionStorage.removeItem('deviceId')
        sessionStorage.removeItem('storeId')
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

  const [businessDay, setBusinessDay] = useState<BusinessDayStatus | null>(null)
  const [businessDayBusy, setBusinessDayBusy] = useState(false)
  const [businessDayError, setBusinessDayError] = useState<string | null>(null)

  // 단말의 로컬 마스터. BO에서 결품을 걸면 menu-events 가 이 화면을
  // 깨우고, 그때 다시 읽습니다 — 프레임의 내용을 믿지는 않습니다.
  const [menus, setMenus] = useState<MenuBoardItem[]>([])
  const [menuError, setMenuError] = useState<string | null>(null)

  const loadBusinessDay = useCallback(async () => {
    try {
      setBusinessDay(await fetchBusinessDayStatus(storeId))
    } catch (e) {
      setBusinessDayError(e instanceof Error ? e.message : '영업 상태를 불러오지 못했습니다')
    }
  }, [storeId])

  useEffect(() => {
    void loadBusinessDay()
    // Business-day state changes rarely — a 30s poll is plenty, and the
    // socket carries no nudge for it (개점/마감 is this screen's own
    // action, so it already knows to reload right after pressing either).
    const timer = window.setInterval(() => void loadBusinessDay(), 30000)
    return () => window.clearInterval(timer)
  }, [loadBusinessDay])

  async function openStore() {
    setBusinessDayBusy(true)
    setBusinessDayError(null)
    try {
      await openBusinessDay(storeId, deviceId)
    } catch (e) {
      setBusinessDayError(e instanceof Error ? e.message : '개점하지 못했습니다')
    } finally {
      setBusinessDayBusy(false)
      await loadBusinessDay()
    }
  }

  async function closeStore() {
    if (!window.confirm(`${storeId}을(를) 마감할까요? 오늘 접수된 주문은 그대로 남고, 새 주문만 막힙니다.`)) return
    setBusinessDayBusy(true)
    setBusinessDayError(null)
    try {
      await closeBusinessDay(storeId, deviceId)
    } catch (e) {
      setBusinessDayError(e instanceof Error ? e.message : '마감하지 못했습니다')
    } finally {
      setBusinessDayBusy(false)
      await loadBusinessDay()
    }
  }

  const loadMenus = useCallback(async () => {
    try {
      setMenus((await fetchMenuBoard(storeId)).menus)
      setMenuError(null)
    } catch (e) {
      // 메뉴판을 못 읽는 것과 주문을 못 받는 것은 다른 일입니다 —
      // 주문 화면은 그대로 두고 이 칸만 사정을 말합니다.
      setMenuError(e instanceof Error ? e.message : '메뉴를 불러오지 못했습니다')
    }
  }, [storeId])

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

  // 프레임 하나에 두 가지가 옵니다. 결품 알림이면 메뉴판만, 그 밖이면
  // 주문만 다시 읽습니다 — 결품 한 번에 주문 목록까지 새로 당길 이유가
  // 없습니다. 프레임을 못 읽었으면(undefined) 둘 다 읽습니다.
  const onEvent = useCallback((event?: TerminalEvent) => {
    if (event === undefined) {
      void reload()
      void loadMenus()
      return
    }
    if (isMenuEvent(event)) void loadMenus()
    else void reload()
  }, [reload, loadMenus])

  const connection = useTerminalSocket(deviceId, storeId, 'POS', onEvent)

  // Polling as well as the socket. A nudge that never arrives must not
  // leave a shop staring at an empty screen while orders pile up — the
  // socket makes it immediate, this makes it certain.
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), 15000)
    return () => window.clearInterval(timer)
  }, [reload])

  // 메뉴판은 주문만큼 자주 바뀌지 않습니다. 소켓이 즉시 알려주므로
  // 폴링은 안전망이고, 영업 상태와 같은 30초면 충분합니다.
  useEffect(() => {
    void loadMenus()
    const timer = window.setInterval(() => void loadMenus(), 30000)
    return () => window.clearInterval(timer)
  }, [loadMenus])

  // 결품만 따로 뽑아 위에 한 줄로 띄웁니다. 주문을 받는 사람이 제일
  // 먼저 알아야 하는 것이 "오늘 없는 것"이라서요.
  const soldOut = menus.filter((m) => m.soldOut)

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
          {connection === 'open' ? '연결됨'
            : connection === 'connecting' ? '연결 중'
            : connection === 'displaced' ? '중복 장비'
            : '끊김'}
        </span>
      </header>

      <div className="bizday-bar">
        <span className={businessDay?.open ? 'bizday-open' : 'muted'}>
          {businessDay === null ? '영업 상태 확인 중…'
            : businessDay.open ? `영업 중 · 영업일자 ${businessDay.businessDate}`
            : '영업 준비 — 개점하면 주문을 받을 수 있습니다'}
        </span>
        <div className="row">
          {businessDay && !businessDay.open && (
            <button className="btn accept" disabled={businessDayBusy} onClick={() => void openStore()}>
              {businessDayBusy ? '처리 중…' : '개점'}
            </button>
          )}
          {businessDay?.open && (
            <button className="btn reject" disabled={businessDayBusy} onClick={() => void closeStore()}>
              {businessDayBusy ? '처리 중…' : '마감'}
            </button>
          )}
        </div>
      </div>
      {businessDay?.needsClosing && (
        <div className="warn" role="status">
          지난 영업일이 아직 마감되지 않았습니다. 마감 후 다시 개점하면 오늘 날짜로 새로 시작합니다.
        </div>
      )}
      {businessDayError && <div className="error" role="alert">{businessDayError}</div>}

      {soldOut.length > 0 && (
        <div className="warn" role="status">
          오늘 <strong>결품 {soldOut.length}개</strong> — {soldOut.map((m) => m.name).join(', ')}.
          손님 화면에서는 고를 수 없습니다. 푸는 곳은 BO의 결품 화면입니다.
        </div>
      )}

      {connection === 'closed' && (
        <div className="warn" role="status">
          Device Server와 연결이 끊겼습니다. 재연결을 시도하는 동안 주문은 15초마다 새로 읽습니다.
        </div>
      )}
      {connection === 'displaced' && (
        <div className="error" role="alert">
          <strong>{storeId} / {deviceId}</strong> 단말을 다른 창에서 열었습니다.
          한 단말은 한 연결만 가질 수 있어서 이 창의 연결은 닫혔습니다.
          같은 매장에서 창을 더 열려면 장비 ID를 다르게 하세요.
          {' '}
          <button className="btn link" onClick={onForget}>지금 바꾸기</button>
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
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
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

      <section>
        <h2>
          오늘의 메뉴
          {soldOut.length > 0 && <span className="count out">{soldOut.length}</span>}
        </h2>
        {menuError ? (
          <div className="error" role="alert">{menuError}</div>
        ) : menus.length === 0 ? (
          <div className="empty">메뉴가 없습니다. BO의 메뉴 화면에서 먼저 등록하세요.</div>
        ) : (
          <div className="menu-grid">
            {menus.map((menu) => (
              <div className={`menu-chip${menu.soldOut ? ' out' : ''}`} key={menu.menuCode}>
                <span className="chip-name">{menu.name}</span>
                <span className="chip-meta">
                  {menu.price === null ? '가격 미등록' : formatAmount(menu.price)}
                  {menu.estimatedMinutes !== null && ` · 약 ${menu.estimatedMinutes}분`}
                </span>
                {menu.soldOut && <span className="chip-flag">결품</span>}
              </div>
            ))}
          </div>
        )}
        <p className="muted hint">
          읽기 전용입니다 — 결품을 걸고 푸는 곳은 BO입니다. 여기는 걸린 결과가 바로 비칩니다.
        </p>
      </section>

      <footer>
        <span className="muted">매장 {storeId} · 장비 {deviceId}</span>
        <button className="btn link" onClick={onForget}>매장·장비 변경</button>
      </footer>
    </div>
  )
}

function TerminalPrompt({ onChosen }: { onChosen: (storeId: string, deviceId: string) => void }) {
  // Prefilled from the last window, not applied automatically — this
  // screen always asks, so a second window can be a different shop.
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
          장비 ID는 <strong>매장 안에서만</strong> 구별되면 되므로, 매장이 다르면
          같은 <code>pos-01</code> 을 써도 됩니다.
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
