import { useCallback, useEffect, useMemo, useState } from 'react'
import { BASE, fetchBusinessDayStatus, fetchOrders, type Order } from './lib/deviceServer'
import { forgetPairing, pairWithCode, pairedDevice, remember, type PairedDevice } from './lib/pairing'
import { useTerminalSocket } from './lib/useTerminalSocket'

/** How often to re-ask each watched store which 판매일자 it is on. */
const BUSINESS_DAY_POLL_MS = 30000

const POLL_MS = 15000

/**
 * 부른 번호가 화면에 머무는 시간.
 *
 * <p>DID는 상태를 보여주는 화면이 <b>아닙니다</b>. 조리가 끝난 번호가
 * 잠깐 떴다가 지나가는 <b>흐르는 화면</b>입니다. 안 가져간 번호가
 * 계속 쌓이면 화면이 목록이 되고, 목록이 되면 손님은 자기 번호를
 * 찾느라 한참을 봅니다 — 지나가는 화면이라야 눈에 띕니다.
 *
 * <p>지나간 번호를 다시 올리는 길은 따로 있습니다: KDS의 "다시 부르기".
 * 화면이 스스로 판단하지 않고 사람이 누릅니다 — 손님이 왔는지 아닌지는
 * 주방에서만 압니다.
 *
 * <p>기준은 {@code calledAt} 이고 화면의 기억이 아닙니다. 그래서
 * 새로고침해도, 두 대를 나란히 걸어도 같은 번호가 같은 시간만큼 뜹니다.
 */
const CALL_WINDOW_MS = 90000

/** 막 뜬 번호를 강조하는 시간. 흐르는 화면에서 '방금 나온 것'이 제일 중요합니다. */
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
/**
 * 페어링된 DID 가 볼 매장. 기본은 자기 매장 하나이고, 주소의 {@code ?storeId=}
 * 목록에 <b>자기 매장이 들어 있으면</b> 그 목록 전체(푸드코트처럼 여러 매장을
 * 한 화면에). 서버도 같은 규칙으로 받습니다.
 */
function pairedStores(own: string, fromQuery: string | null): string {
  if (!fromQuery) return own
  const list = fromQuery.split(',').map((s) => s.trim()).filter(Boolean)
  return list.includes(own) ? list.join(',') : own
}

export default function App() {
  const query = new URLSearchParams(window.location.search)
  const paired = pairedDevice()
  const [deviceId, setDeviceId] = useState<string>(
    () => paired?.deviceId ?? query.get('deviceId') ?? sessionStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => paired
      ? pairedStores(paired.storeId, query.get('storeId'))
      : query.get('storeId') ?? sessionStorage.getItem('storeId') ?? ''
  )

  if (!deviceId || !storeId) {
    return (
      <TerminalPrompt
        onPaired={(device) => {
          setStoreId(pairedStores(device.storeId, query.get('storeId')))
          setDeviceId(device.deviceId)
        }}
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
        if (pairedDevice()) {
          if (!window.confirm('이 기기의 페어링을 지웁니다. 다시 쓰려면 BO 에서 코드를 새로 받아야 합니다.')) return
          forgetPairing()
        }
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
   * 화면이 흐르게 하는 시계.
   *
   * <p>몇 초마다 다시 그립니다 — 부른 지 오래된 번호가 서버를 다시
   * 묻지 않고도 스스로 빠지도록. 폴링에만 맡기면 창이 닫히는 순간이
   * 폴링 주기에 묶여서 번호마다 최대 15초씩 더 붙어 있습니다.
   */
  const [now, setNow] = useState(() => Date.now())

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

      setCooking(mine(inProgress))
      setReady(mine(done))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
    // storeIds is derived fresh from storeId every render — depending on
    // storeId itself (a primitive) instead keeps this stable across
    // renders the way the array literal would not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId])

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

  // 화면을 흐르게 하는 tick. 서버를 다시 묻지 않고 시간만 흘립니다.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
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

  /**
   * 부른 지 얼마 안 된 번호만. <b>안 가져갔다고 계속 두지 않습니다</b> —
   * 그러면 화면이 목록이 되고, 목록에서는 방금 나온 번호가 안 보입니다.
   *
   * <p>지나간 번호는 KDS에서 다시 부를 수 있습니다. 화면이 스스로
   * 판단하지 않는 이유: 손님이 왔는지 아닌지는 주방에서만 압니다.
   */
  const readyCards = useMemo(
    () => ofToday(ready)
      .filter((o) => o.calledAt != null && now - new Date(o.calledAt).getTime() < CALL_WINDOW_MS)
      .sort((a, b) => new Date(b.calledAt!).getTime() - new Date(a.calledAt!).getTime()),
    [ready, ofToday, now]
  )

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
                    fresh={now - new Date(order.calledAt!).getTime() < FRESH_MS}
                    // 남은 시간을 띠로 보여줍니다. 흐르는 화면이라는
                    // 것이 눈에 보여야, 번호가 사라졌을 때 손님이
                    // "없어졌다"가 아니라 "지나갔다"로 읽습니다.
                    remaining={1 - (now - new Date(order.calledAt!).getTime()) / CALL_WINDOW_MS}
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

function NumberCard({ order, showStore, tone, fresh = false, remaining }:
  { order: Order; showStore: boolean; tone: 'cooking' | 'ready'
    fresh?: boolean; remaining?: number }) {
  return (
    <article className={`ready-card ${tone}${fresh ? ' fresh' : ''}`}>
      {showStore && <div className="ready-store">{order.storeId}</div>}
      {/* 수령번호가 주인공입니다 — 손님은 이걸 보고 옵니다. 주문번호는
          내부 값이라, 수령번호가 있으면 작게 밀어둡니다. 없는 옛 주문은
          예전처럼 주문번호가 그 자리를 맡습니다: 빈 칸을 남기면
          누락처럼 읽힙니다. */}
      <div className="ready-no">{order.pickupNo ?? `#${order.id}`}</div>
      {order.pickupNo && <div className="ready-sub">주문 #{order.id}</div>}
      {/* 손님은 자기 번호를 찾으러 옵니다. 메뉴는 "맞나?"를 한 번 더
          확인하는 값이라 줄을 다 펴지 않고 요약으로 둡니다 — 줄을 전부
          그리면 카드가 길어지고 번호가 작아집니다. 개수만 덧붙입니다. */}
      <div className="ready-menu">
        {order.menuName}
        {order.lines.length > 1 && (
          <span className="ready-items">
            {' '}{order.lines.reduce((n, line) => n + line.quantity, 0)}개
          </span>
        )}
      </div>
      {remaining !== undefined && (
        <div className="ready-bar">
          <div
            className="ready-bar-fill"
            style={{ width: `${Math.max(0, Math.min(1, remaining)) * 100}%` }}
          />
        </div>
      )}
    </article>
  )
}

/**
 * 첫 화면 — 페어링 코드 (store-app.md §3.6). 예전 직접 입력은 표시된 우회로로
 * 남깁니다: 서버가 warn 인 동안 동작하고, enforce 가 되면 서버에서 막힙니다.
 */
function TerminalPrompt({ onChosen, onPaired }: {
  onChosen: (storeId: string, deviceId: string) => void
  onPaired: (device: PairedDevice) => void
}) {
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)

  async function submitCode() {
    setPairing(true)
    setPairError(null)
    try {
      const { device, token } = await pairWithCode(BASE, code)
      if (device.deviceType !== 'DID') {
        setPairError(`이 코드는 ${device.deviceType} 용입니다. BO 에서 DID 장비의 코드를 새로 받으십시오.`)
        return
      }
      remember(device, token)
      onPaired(device)
    } catch (e) {
      setPairError(e instanceof Error ? e.message : '페어링하지 못했습니다')
    } finally {
      setPairing(false)
    }
  }

  if (!manual) {
    return (
      <div className="prompt">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault()
            void submitCode()
          }}
        >
          <h1>기기 페어링</h1>
          <p className="muted">
            BO <strong>장비</strong> 화면에서 이 DID 의 <strong>[코드]</strong> 를 눌러 받은
            6자리를 넣으십시오. 매장과 장비는 BO 에 적힌 대로 정해집니다. 여러 매장을
            함께 보려면 주소에 <code>?storeId=store-01,store-02</code> 를 붙이십시오
            (자기 매장이 들어 있어야 합니다).
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            maxLength={7}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            style={{ fontSize: '2rem', letterSpacing: '0.3em', textAlign: 'center' }}
          />
          {pairError && <div className="error" role="alert">{pairError}</div>}
          <button className="btn accept" type="submit"
                  disabled={pairing || code.replace(/\s/g, '').length !== 6}>
            {pairing ? '확인 중…' : '페어링'}
          </button>
          <button className="btn link" type="button" onClick={() => setManual(true)}>
            코드 없이 직접 입력 (페어링 전 임시)
          </button>
        </form>
      </div>
    )
  }

  return <ManualPrompt onChosen={onChosen} onBack={() => setManual(false)} />
}

/** 페어링 전의 방식. 서버가 enforce 가 되면 연결이 거절됩니다. */
function ManualPrompt({ onChosen, onBack }: {
  onChosen: (storeId: string, deviceId: string) => void
  onBack: () => void
}) {
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
        <h1>단말 등록 (임시)</h1>
        <div className="warn" role="status">
          페어링하지 않은 기기입니다. 서버가 페어링을 요구하기 시작하면 이 방식은 막힙니다.
        </div>
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
        <button className="btn link" type="button" onClick={onBack}>페어링 코드로 돌아가기</button>
      </form>
    </div>
  )
}
