import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchBusinessDayStatus, fetchOrders, type Order } from './lib/deviceServer'
import { useTerminalSocket } from './lib/useTerminalSocket'

/** How often to re-ask each watched store which 판매일자 it is on. */
const BUSINESS_DAY_POLL_MS = 30000

const POLL_MS = 15000

/**
 * 막 조리가 끝난 번호를 잠깐 강조하는 시간.
 *
 * <p>이 화면이 예전에 쓰던 <b>15초 뒤 사라짐</b>과는 다른 것입니다.
 * 그때는 주문이 PRODUCED 에서 영영 안 움직였기 때문에 화면이 스스로
 * 지우는 수밖에 없었습니다. 지금은 수령 확인이 PRODUCED → COMPLETED
 * 로 옮겨 주므로, <b>가져갈 때까지 붙어 있는 것이 맞습니다</b> —
 * 손님이 잠깐 자리를 비운 사이에 자기 번호가 사라지면 그게 사고입니다.
 *
 * <p>그래서 남는 것은 "사라짐"이 아니라 "새로 뜬 것 표시"입니다.
 */
const FRESH_MS = 20000

/**
 * The 판매일자 each watched store is currently on — `null` for a store
 * that is closed, and absent for one not yet asked about.
 *
 * Per store rather than one value for the board, because a food-court
 * DID watches several branches and they do not open and close together.
 * One shop's 마감 must clear only its own cards.
 */
type BusinessDays = Record<string, string | null>

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
  const [cooking, setCooking] = useState<Order[]>([])
  const [ready, setReady] = useState<Order[]>([])
  const [days, setDays] = useState<BusinessDays>({})
  const [error, setError] = useState<string | null>(null)

  /**
   * 조리 완료로 <b>막 넘어온</b> 주문과 그 시각.
   *
   * <p>ref 인 이유: 이 값이 바뀐다고 화면을 다시 그릴 필요가 없습니다.
   * 강조가 꺼지는 것은 아래의 느린 tick 이 맡습니다.
   */
  const freshRef = useRef<Map<number, number>>(new Map())
  const [, forceTick] = useState(0)

  // A comma-separated storeId is a food-court style board watching
  // several branches at once — see the Device Server's
  // TerminalHandshakeHandler, which parses the same string the same way.
  // A single store is just the length-1 case of this, unchanged.
  const storeIds = storeId.split(',').map((s) => s.trim()).filter(Boolean)
  const isMultiStore = storeIds.length > 1

  /**
   * 조리 중과 조리 완료를 <b>함께</b> 가져옵니다.
   *
   * <p>두 번 부르는 것이 아깝지 않은 이유: 이 화면이 답해야 하는 질문이
   * 둘이기 때문입니다 — "내 것이 만들어지고 있나"와 "가져가도 되나".
   * 앞의 것이 없으면 손님은 주문이 들어갔는지조차 모르고 카운터에
   * 다시 물으러 옵니다.
   */
  const reload = useCallback(async () => {
    try {
      const [inProgress, done] = await Promise.all([
        fetchOrders('COOKING'),
        fetchOrders('PRODUCED')
      ])
      const mine = (orders: Order[]) => orders.filter((o) => storeIds.includes(o.storeId))

      const nextReady = mine(done)
      // 조리 완료로 처음 넘어온 것만 강조 대상입니다. 이미 떠 있던
      // 번호가 폴링할 때마다 다시 번쩍이면 화면이 시끄럽고, 손님은
      // 어느 것이 방금 나온 것인지 구분할 수 없습니다.
      const now = Date.now()
      const known = new Set(ready.map((o) => o.id))
      for (const order of nextReady) {
        if (!known.has(order.id) && !freshRef.current.has(order.id)) {
          freshRef.current.set(order.id, now)
        }
      }

      setCooking(mine(inProgress))
      setReady(nextReady)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
    // storeIds is derived fresh from storeId every render — depending on
    // storeId itself (a primitive) instead keeps this stable across
    // renders the way the array literal would not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, ready])

  /**
   * Asks every watched store which 판매일자 it is on. Failures leave the
   * previous answer in place rather than recording "closed" — a status
   * call that did not come back is not evidence a shop shut, and treating
   * it as one would blank a working board mid-service.
   */
  const reloadBusinessDays = useCallback(async () => {
    const answers = await Promise.all(storeIds.map(async (id) => {
      try {
        const status = await fetchBusinessDayStatus(id)
        return [id, status.open ? status.businessDate ?? null : null] as const
      } catch {
        return null
      }
    }))
    setDays((prev) => {
      const next = { ...prev }
      for (const answer of answers) {
        if (answer) next[answer[0]] = answer[1]
      }
      return next
    })
    // Same reasoning as reload's own dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

  const connection = useTerminalSocket(deviceId, storeId, 'DID', reload)

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [reload])

  useEffect(() => {
    void reloadBusinessDays()
    const timer = window.setInterval(() => void reloadBusinessDays(), BUSINESS_DAY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [reloadBusinessDays])

  // 강조를 끄는 tick. 화면을 다시 그리기만 하면 되므로 느려도 됩니다.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, at] of freshRef.current) {
        if (now - at > FRESH_MS) {
          freshRef.current.delete(id)
          changed = true
        }
      }
      if (changed) forceTick((n) => n + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * 판매일자 scoping, added 2026-09-15.
   *
   * Filtered here rather than in `reload`, so that a 개점 or 마감 clears
   * the board on the next render instead of waiting for the next fetch.
   *
   * A store not yet asked about (`undefined`) shows nothing rather than
   * everything: the first paint after a reload should not flash
   * yesterday's orders for the half second before the status call lands.
   */
  const ofToday = useCallback((orders: Order[]) => orders
    .filter((o) => o.businessDate != null && days[o.storeId] === o.businessDate)
    .sort((a, b) => a.id - b.id), [days])

  const cookingCards = useMemo(() => ofToday(cooking), [cooking, ofToday])
  const readyCards = useMemo(() => ofToday(ready), [ready, ofToday])

  /** Shops this board watches that are not trading right now. */
  const closedStores = storeIds.filter((id) => days[id] === null)
  const allClosed = closedStores.length === storeIds.length

  return (
    <div className="did-shell">
      <header className="did-bar">
        <span className="muted">
          {isMultiStore ? `매장 ${storeIds.length}개 (${storeIds.join(', ')})` : storeId} · {deviceId}
          {!isMultiStore && (
            days[storeId] ? ` · 판매일자 ${days[storeId]}` : ' · 판매일자 없음'
          )}
          {isMultiStore && closedStores.length > 0 && ` · 마감 ${closedStores.join(', ')}`}
        </span>
        <span className={`conn ${connection}`}>
          {connection === 'open' ? '연결됨'
            : connection === 'connecting' ? '연결 중'
            : connection === 'displaced' ? '중복 장비'
            : '끊김'}
        </span>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {allClosed ? (
        <div className="did-empty">
          {isMultiStore ? '지켜보는 매장이 모두 마감 상태입니다.' : '매장이 개점 전이거나 마감되었습니다.'}
        </div>
      ) : (
        /*
          두 칸으로 나눕니다.

          손님이 이 화면 앞에서 갖는 질문은 둘입니다 — "내 것이 지금
          만들어지고 있나"와 "가져가도 되나". 한 칸에 섞으면 둘 다
          흐려집니다: 조리 중인 번호를 보고 카운터로 갔다가 돌아오고,
          나온 번호를 못 보고 계속 서 있습니다.

          오른쪽(조리 완료)이 더 큽니다. 왼쪽은 "기다리세요"이고
          오른쪽은 "오세요"라서, 멀리서 읽혀야 하는 쪽이 오른쪽입니다.
        */
        <div className="did-columns">
          <section className="did-col cooking">
            <h2 className="did-col-head">
              조리 중 <span className="did-count">{cookingCards.length}</span>
            </h2>
            {cookingCards.length === 0 ? (
              <div className="did-empty small">만들고 있는 주문이 없습니다.</div>
            ) : (
              <div className="did-grid cooking">
                {cookingCards.map((order) => (
                  <NumberCard key={order.id} order={order} showStore={isMultiStore} tone="cooking" />
                ))}
              </div>
            )}
          </section>

          <section className="did-col ready">
            <h2 className="did-col-head">
              조리 완료 <span className="did-count">{readyCards.length}</span>
            </h2>
            {readyCards.length === 0 ? (
              <div className="did-empty small">준비된 주문을 기다리는 중…</div>
            ) : (
              <div className="did-grid ready">
                {readyCards.map((order) => (
                  <NumberCard
                    key={order.id}
                    order={order}
                    showStore={isMultiStore}
                    tone="ready"
                    fresh={freshRef.current.has(order.id)}
                  />
                ))}
              </div>
            )}
          </section>
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

function NumberCard({ order, showStore, tone, fresh = false }:
  { order: Order; showStore: boolean; tone: 'cooking' | 'ready'; fresh?: boolean }) {
  return (
    <article className={`ready-card ${tone}${fresh ? ' fresh' : ''}`}>
      {showStore && <div className="ready-store">{order.storeId}</div>}
      {/* 수령번호가 주인공입니다 — 손님은 이걸 보고 옵니다. 주문번호는
          내부 값이라, 수령번호가 있으면 작게 밀어둡니다. 없는 옛 주문은
          예전처럼 주문번호가 그 자리를 맡습니다: 빈 칸을 남기면
          누락처럼 읽힙니다. */}
      <div className="ready-no">{order.pickupNo ?? `#${order.id}`}</div>
      {order.pickupNo && <div className="ready-sub">주문 #{order.id}</div>}
      <div className="ready-menu">{order.menuName}</div>
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
          하나가 여러 매장의 주문을 함께 보여줍니다.
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
