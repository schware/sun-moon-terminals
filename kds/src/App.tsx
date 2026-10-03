import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  changeStatus,
  fetchBusinessDayStatus,
  fetchKdsMode,
  fetchPrintJobs,
  forceProduced,
  isPrintEvent,
  reprintLabel,
  type PrintJob,
  startLines,
  fetchMenuBoard,
  fetchOrders,
  formatAmount,
  formatTime,
  handOver,
  isMenuEvent,
  lineBelongsTo,
  recall,
  STATUS_LABEL,
  type BusinessDayStatus,
  type KdsMode,
  type KdsRole,
  type MenuBoardItem,

  type Order,
  type TerminalEvent,
  tableLabel
} from './lib/kdsApi'
import { forgetShellDevice, shellDevice } from '@sunmoon/terminal-common/shell'
import { useTerminalSocket } from '@sunmoon/terminal-common/socket'

/** How often to re-ask which 판매일자 this store is on. Same cadence as POS. */
const BUSINESS_DAY_POLL_MS = 30000

/**
 * Which terminal this window is. Identical scheme to sun-moon-terminal-pos
 * — see that repo's App.tsx for the reasoning (per-tab identity, ?storeId=
 * &deviceId= pinning). Duplicated rather than shared because these ship as
 * independent static bundles with no server of their own.
 */
/**
 * 티켓에 그리는 것 — <b>만들 것들</b>.
 *
 * <p>주방에 "짜장면 외 1건"을 보여주면 요리를 못 합니다. 줄이 있으면
 * 줄을 전부 펴서 그리고, 없는 옛 주문만 요약으로 되돌아갑니다.
 *
 * <p>수량은 1일 때 안 씁니다 — "짜장면 ×1"은 읽는 사람에게 아무것도
 * 더 말해주지 않고, 바쁜 주방에서는 읽을 것이 적을수록 좋습니다.
 *
 * <p>금액도 메뉴 코드도 안 그립니다. 만드는 데 필요 없는 값이 섞이면
 * 필요한 값이 늦게 읽힙니다.
 */
function TicketBody({ order, deviceId, isMain }:
  { order: Order; deviceId: string; isMain: boolean }) {
  if (order.lines.length === 0) {
    return <div className="customer">{order.menuName}</div>
  }
  // 생산 주방은 **자기 줄만** 봅니다. 남의 주방 것까지 보이면 무엇을
  // 만들어야 하는지가 흐려지고, 다 된 줄 알고 넘깁니다.
  const shown = isMain ? order.lines : order.lines.filter((l) => lineBelongsTo(l, deviceId))
  return (
    <ul className="ticket-lines">
      {shown.map((line) => (
        <li key={line.seq} className={line.producedAt ? 'done' : isMain && line.startedAt ? 'cooking' : undefined}>
          <span className="ticket-menu">{line.menuName}</span>
          {line.quantity > 1 && <span className="ticket-qty">×{line.quantity}</span>}
          {/* 메인은 어느 주방 것인지와 끝났는지를 함께 봅니다 — 그게
              "지금 누가 붙잡고 있나"에 답하는 유일한 값입니다. */}
          {isMain && line.kdsDeviceId && (
            <span className="ticket-kitchen">{line.kdsDeviceId}</span>
          )}
          {/* 생산 주방이 가져간 줄은 "조리 중" — 대기와 섞이면 메인이 누구를 기다리는지 모릅니다. */}
          {isMain && (
            <span className="ticket-mark">
              {line.producedAt ? '완료' : line.startedAt ? '조리 중' : '대기'}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 아직 안 끝난 주방들 — 메인이 "누구를 기다리나"를 보는 값. */
function pendingKitchens(order: Order): string[] {
  return [...new Set(order.lines
    .filter((l) => l.producedAt === null && l.kdsDeviceId !== null)
    .map((l) => l.kdsDeviceId!))]
}

/** 이 주방이 자기 줄을 다 끝냈는가 — 옆 주방을 기다리는 중인지 알려면 필요합니다. */
/** 내 줄 중 하나라도 조리를 시작했나. 옆 주방이 시작한 주문도 내 것은 아직 대기일 수 있습니다. */
/**
 * 셸(SunMoon Store)의 라벨 프린터 — KDS-MAIN 으로 페어링된 셸에만 있습니다 (store-app.md §7).
 * 어디로 찍을지는 셸이 BO 장비 목록에서 정하고, 화면은 작업 번호만 넘깁니다.
 */
interface ShellLabelPrinter {
  label: (jobId: number) => Promise<{ ok: boolean; error?: string }>
  queuedLabels: () => Promise<{ printed: number; failed: number }>
}

function shellLabelPrinter(): ShellLabelPrinter | undefined {
  const printer = (window as unknown as { sunmoon?: { printer?: Partial<ShellLabelPrinter> } }).sunmoon?.printer
  return printer?.label && printer.queuedLabels ? printer as ShellLabelPrinter : undefined
}

function myLinesStarted(order: Order, deviceId: string): boolean {
  return order.lines.some((l) => lineBelongsTo(l, deviceId) && (l.startedAt || l.producedAt))
}

function myLinesDone(order: Order, deviceId: string): boolean {
  const mineLines = order.lines.filter((l) => lineBelongsTo(l, deviceId))
  return mineLines.length > 0 && mineLines.every((l) => l.producedAt !== null)
}

export default function App() {
  const query = new URLSearchParams(window.location.search)
  // 셸 안이면 셸에 설정된 매장·장비가 먼저입니다 (store-app.md §5.2).
  const paired = shellDevice()
  const [deviceId, setDeviceId] = useState<string>(
    () => paired?.deviceId ?? query.get('deviceId') ?? sessionStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => paired?.storeId ?? query.get('storeId') ?? sessionStorage.getItem('storeId') ?? ''
  )
  /**
   * 이 화면이 하는 일 — 만드는 주방인가, 흐름을 보는 메인인가.
   *
   * 창(탭)마다 따로 기억합니다. 한 대의 기기에서 메인을 띄우고 옆
   * 창에서 주방을 보는 것이 실제로 있을 일이라서요.
   */
  const [role, setRole] = useState<KdsRole>(() => {
    if (paired) return paired.kdsRole === 'MAIN' ? 'MAIN' : 'PRODUCTION'
    return (query.get('role') ?? sessionStorage.getItem('kdsRole') ?? 'PRODUCTION') === 'MAIN'
      ? 'MAIN' : 'PRODUCTION'
  })

  if (!deviceId || !storeId) {
    return (
      <TerminalPrompt
        onChosen={(store, device, chosenRole) => {
          sessionStorage.setItem('storeId', store)
          sessionStorage.setItem('deviceId', device)
          sessionStorage.setItem('kdsRole', chosenRole)
          // 화면마다 따로 — POS·KDS·DID 가 같은 주소(:8000)라 localStorage 를 같이 씁니다.
          localStorage.setItem('kds.lastStoreId', store)
          localStorage.setItem('kds.lastDeviceId', device)
          setStoreId(store)
          setDeviceId(device)
          setRole(chosenRole)
        }}
      />
    )
  }

  return (
    <Kds
      deviceId={deviceId}
      storeId={storeId}
      role={role}
      onRole={(serverRole) => {
        // BO 장비의 KDS 역할이 정합니다 — 단말 등록에서 고른 것과 다르면 BO 를 따릅니다.
        sessionStorage.setItem('kdsRole', serverRole)
        setRole(serverRole)
      }}
      onForget={() => {
        if (shellDevice()) {
          if (!window.confirm('이 기기의 매장·장비 설정을 지웁니다. 셸이 설정 화면으로 돌아갑니다.')) return
          forgetShellDevice()
        }
        sessionStorage.removeItem('deviceId')
        sessionStorage.removeItem('storeId')
        sessionStorage.removeItem('kdsRole')
        setDeviceId('')
        setStoreId('')
      }}
    />
  )
}

function Kds({ deviceId, storeId, role, onRole, onForget }:
  { deviceId: string; storeId: string; role: KdsRole; onRole: (role: KdsRole) => void; onForget: () => void }) {
  const isMain = role === 'MAIN'
  const [orders, setOrders] = useState<Order[]>([])
  const [businessDay, setBusinessDay] = useState<BusinessDayStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  // 주방이 결품을 알아야 하는 이유는 주문을 막기 위해서가 아닙니다 —
  // 그건 손님 화면에서 이미 막힙니다. 이미 들어와 있는 티켓 중에 그
  // 메뉴가 있으면 지금 카운터에 말해야 하기 때문입니다.
  const [soldOut, setSoldOut] = useState<MenuBoardItem[]>([])

  // 수령 확인 중인 주문과, 손님이 불러준 번호.
  const [handingOver, setHandingOver] = useState<Order | null>(null)
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  // 방금 다시 부른 주문. 버튼이 잠깐 "불렀습니다"로 바뀝니다.
  const [recalled, setRecalled] = useState<number | null>(null)

  // 라벨 (§7). 셸 밖(웹 KDS)에는 프린터가 없습니다 — 버튼도 없습니다.
  const [labelError, setLabelError] = useState<string | null>(null)
  const [labelsFor, setLabelsFor] = useState<Order | null>(null)
  const [labelJobs, setLabelJobs] = useState<PrintJob[]>([])
  const canPrintLabels = isMain && shellLabelPrinter() !== undefined

  // 꺼져 있던 동안 쌓인 라벨 — 켜질 때 한 번 (§7.2).
  useEffect(() => {
    const printer = shellLabelPrinter()
    if (!isMain || !printer) return
    void printer.queuedLabels().then((r) => {
      if (r.failed > 0) setLabelError(`쌓여 있던 라벨 ${r.failed}장을 찍지 못했습니다 — 프린터를 확인하십시오`)
    })
  }, [isMain])

  async function openLabels(order: Order) {
    setLabelsFor(order)
    setLabelJobs([])
    try {
      setLabelJobs(await fetchPrintJobs(storeId, order.id))
    } catch (e) {
      setLabelError(e instanceof Error ? e.message : '라벨 작업을 읽지 못했습니다')
    }
  }

  async function reprint(job: PrintJob) {
    try {
      await reprintLabel(storeId, deviceId, job.id)
      if (labelsFor) setLabelJobs(await fetchPrintJobs(storeId, labelsFor.id))
    } catch (e) {
      setLabelError(e instanceof Error ? e.message : '다시 찍지 못했습니다')
    }
  }

  /**
   * 비상 모드 (store-app.md §4.2) — BO 가 MAIN 으로 정한 KDS 가 3분 넘게 끊기면
   * 생산 KDS 가 대신 수령합니다. 메인 화면은 묻지 않습니다.
   */
  const [kdsMode, setKdsMode] = useState<KdsMode | null>(null)
  useEffect(() => {
    if (isMain) return
    const read = () => { fetchKdsMode(storeId).then(setKdsMode).catch(() => { /* 모르면 그대로 */ }) }
    read()
    const timer = window.setInterval(read, 15000)
    return () => window.clearInterval(timer)
  }, [isMain, storeId])
  const emergency = !isMain && kdsMode?.emergency === true

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

  const loadMenus = useCallback(async () => {
    try {
      setSoldOut((await fetchMenuBoard(storeId)).menus.filter((m) => m.soldOut))
    } catch {
      // 메뉴판을 못 읽는 것은 주방을 세울 이유가 아닙니다. 결품 띠만
      // 안 보이고 티켓은 그대로 흐릅니다.
    }
  }, [storeId])

  // 프레임 하나에 두 가지가 옵니다 — 결품이면 메뉴판만, 그 밖이면
  // 주문만 다시 읽습니다. 못 읽은 프레임이면 둘 다입니다.
  const onEvent = useCallback((event?: TerminalEvent) => {
    // 연결 인사 — 서버가 BO 장비의 KDS 역할을 알려 줍니다.
    if (event?.type === 'WELCOME') {
      const serverRole: KdsRole | null =
        event.kdsRole === 'MAIN' ? 'MAIN' : event.kdsRole === 'SUB' ? 'PRODUCTION' : null
      if (serverRole && serverRole !== role) onRole(serverRole)
    }
    // 라벨 (store-app.md §7.2) — 셸의 KDS-MAIN 만 찍습니다. 주문 목록은 다시 읽지 않습니다.
    if (isPrintEvent(event)) {
      const printer = shellLabelPrinter()
      if (printer) {
        void (async () => {
          for (const id of event?.jobIds ?? []) {
            const result = await printer.label(id)
            if (!result.ok) setLabelError(result.error ?? '라벨을 찍지 못했습니다')
          }
        })()
      }
      return
    }
    if (event === undefined) {
      void reload()
      void loadMenus()
      return
    }
    if (isMenuEvent(event)) void loadMenus()
    else void reload()
  }, [reload, loadMenus, role, onRole])

  const connection = useTerminalSocket(deviceId, storeId, 'KDS', onEvent, isMain ? 'MAIN' : undefined)

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

  // 소켓이 즉시 알려주므로 이 폴링은 안전망입니다 — 영업일 확인과 같은 간격.
  useEffect(() => {
    void loadMenus()
    const timer = window.setInterval(() => void loadMenus(), BUSINESS_DAY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadMenus])

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

  /**
   * 이 주방이 봐야 할 주문인가.
   *
   * The Device Server's push already targets one KDS when a menu is
   * assigned to one — this mirrors that on the list itself, because a
   * 15s poll or a fresh page load fetches every order at the store with
   * no filtering of its own. No assignment (null) means every KDS should
   * see it, matching the push's own fallback.
   */
  /**
   * 이 화면이 봐야 할 주문인가.
   *
   * **메인은 전부 봅니다** — 전체 흐름을 보는 것이 그 화면의 일입니다.
   *
   * 생산 주방은 <b>자기 줄이 하나라도 있는</b> 주문을 봅니다. 주문
   * 전체의 주방 하나로 거르면, 첫 메뉴가 남의 주방 것인 주문에서 내
   * 줄을 통째로 못 봅니다 — 2026-09-18에 매장에서 나온 보고가 그것이고,
   * 주방이 줄에 붙은 뒤로 이 필터도 줄을 봅니다.
   */
  const mine = useCallback(
    (order: Order) => inToday(order)
      && (isMain
        || order.lines.length === 0
        || order.lines.some((line) => lineBelongsTo(line, deviceId))),
    [inToday, deviceId, isMain]
  )

  /** 조리 대기 — 매장이 받았지만 주방이 아직 안 집은 주문. */
  const waiting = useMemo(
    () => orders.filter((o) => mine(o) && (o.status === 'ACCEPTED'
      // 조리 시작은 줄 단위입니다 (§4.1). 옆 주방이 시작해서 주문은 조리 중이어도
      // 내 줄은 아직 대기입니다.
      || (!isMain && o.status === 'COOKING' && o.lines.length > 0
        && !myLinesStarted(o, deviceId) && !myLinesDone(o, deviceId)))),
    [orders, mine, isMain, deviceId]
  )

  /**
   * 조리 중 — 주방이 가져간 주문.
   *
   * 대기와 갈라 둔 이유는 카운터가 손님에게 할 말이 다르기
   * 때문입니다: "아직 안 들어갔습니다"와 "만들고 있습니다"는 같은
   * 답이 아닙니다.
   */
  const cooking = useMemo(
    () => orders.filter((o) => mine(o) && o.status === 'COOKING'
      && (isMain || o.lines.length === 0 || myLinesStarted(o, deviceId) || myLinesDone(o, deviceId))),
    [orders, mine, isMain, deviceId]
  )

  /**
   * 수령 대기 — 조리는 끝났고 아직 아무도 안 가져간 주문.
   *
   * DID에 지금 떠 있는(또는 떠 있었던) 것들이고, 손님이 번호를 들고
   * 오면 여기서 찾습니다. 최근 완료와 갈라 둔 이유: 저쪽은 지나간
   * 기록이고 이쪽은 <b>지금 할 일</b>입니다.
   */
  const waitingPickup = useMemo(
    () => orders.filter((o) => mine(o) && o.status === 'PRODUCED'),
    [orders, mine]
  )

  const recent = useMemo(
    () => orders.filter((o) => inToday(o)
      && (o.status === 'DELIVERING' || o.status === 'COMPLETED'))
      .slice(0, 12),
    [orders, inToday]
  )

  /**
   * 번호를 다시 부릅니다.
   *
   * DID는 흐르는 화면이라 조리 완료 번호가 잠깐 떴다가 지나갑니다.
   * 손님이 그 뒤에 오면 다시 띄워 줘야 하는데, 화면은 DID지만 상황을
   * 아는 사람은 주방에 있습니다 — 그래서 버튼이 여기 있습니다.
   *
   * 눌렀다는 것을 잠깐 보여줍니다. 아무 반응이 없으면 직원은 눌렸는지
   * 몰라서 다시 누르고, DID에는 같은 번호가 두 번 튑니다.
   */
  async function callAgain(order: Order) {
    setBusyId(order.id)
    try {
      await recall(order.id, deviceId)
      setRecalled(order.id)
      window.setTimeout(() => setRecalled((current) => (current === order.id ? null : current)), 2500)
    } catch (e) {
      setPinError(e instanceof Error ? e.message : '다시 부르지 못했습니다')
    } finally {
      setBusyId(null)
      await reload()
    }
  }

  async function confirmPickup(override = false) {
    if (handingOver === null) return
    setBusyId(handingOver.id)
    setPinError(null)
    try {
      await handOver(handingOver.id, pin.trim(), deviceId, override)
      setHandingOver(null)
      setPin('')
    } catch (e) {
      // 403(번호 불일치)과 409(이미 가져감)는 직원이 손님에게 할 말이
      // 다릅니다. 창을 닫지 않고 그 자리에 띄워야 다시 물어볼 수
      // 있습니다.
      setPinError(e instanceof Error ? e.message : '수령 확인을 하지 못했습니다')
    } finally {
      setBusyId(null)
      await reload()
    }
  }

  /**
   * 주방이 이 주문을 가져갑니다 — 조리 중.
   *
   * 업무 정의서의 "조리 중"은 KDS가 주문을 집는 순간의 이벤트입니다.
   * 시간을 재는 버튼이 아니라, 이 티켓이 누구 손에 있는지를 말하는
   * 표시입니다.
   */
  async function startCooking(order: Order) {
    setBusyId(order.id)
    setError(null)
    try {
      // 내 줄만 시작합니다 — 옆 주방 화면의 그 주문은 대기로 남습니다 (§4.1).
      await startLines(order.id, deviceId)
    } catch (e) {
      // 대개 409: 같은 주방의 다른 화면이 먼저 집었습니다. 어느 쪽이든
      // 이 화면이 낡은 것이므로 서버와 다투지 말고 다시 읽습니다.
      setError(e instanceof Error ? e.message : '처리하지 못했습니다')
    } finally {
      setBusyId(null)
      await reload()
    }
  }

  async function complete(order: Order) {
    // 메인의 "전부 조리완료" 는 남은 줄을 강제로 끝냅니다 (§4.1). 생산 주방이 끝낸
    // 것과 기록이 갈리므로, 누르기 전에 무엇을 하는지 말합니다.
    if (isMain && !order.lines.every((l) => l.producedAt)
        && !window.confirm('아직 안 끝난 줄까지 전부 완료로 적습니다. 누가 눌렀는지 주문에 남습니다.')) {
      return
    }
    setBusyId(order.id)
    setError(null)
    try {
      if (isMain) await forceProduced(order.id, deviceId)
      else await changeStatus(order.id, 'PRODUCED', deviceId)
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
          <h1>{isMain ? 'KDS 메인 — 전체 흐름' : 'KDS 주방 화면'}</h1>
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
      {soldOut.length > 0 && (
        <div className="warn" role="status">
          오늘 <strong>결품 {soldOut.length}개</strong> — {soldOut.map((m) => m.name).join(', ')}.
          새 주문은 이미 막혀 있습니다. 이미 받은 티켓에 있으면 카운터에 알려주세요.
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {labelError && (
        <div className="error" role="alert">
          라벨: {labelError}{' '}
          <button className="btn link" onClick={() => setLabelError(null)}>닫기</button>
        </div>
      )}

      <section>
        <h2>
          조리 대기
          {waiting.length > 0 && <span className="count">{waiting.length}</span>}
        </h2>
        {waiting.length === 0 ? (
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '새로 들어온 주문이 없습니다.'}
          </div>
        ) : (
          <div className="cards">
            {waiting.map((order) => (
              <article className="card" key={order.id}>
                <div className="card-head">
                  <span className="order-no">{order.pickupNo ?? `#${order.id}`}</span>
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
                  <span className="muted">{formatTime(order.updatedAt)}</span>
                </div>
                <TicketBody order={order} deviceId={deviceId} isMain={isMain} />
                <div className="amount">{formatAmount(order.amount)}</div>
                <div className="row">
                  <button
                    className="btn accept"
                    disabled={busyId === order.id}
                    onClick={() => void startCooking(order)}
                  >
                    가져가기
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 조리 중 — 이 주방이 집은 주문. 대기와 갈라 둔 이유는 카운터가
          손님에게 할 말이 다르기 때문입니다: "아직 안 들어갔습니다"와
          "만들고 있습니다"는 같은 답이 아닙니다. */}
      <section>
        <h2>
          조리 중
          {cooking.length > 0 && <span className="count">{cooking.length}</span>}
        </h2>
        {cooking.length === 0 ? (
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '조리 중인 주문이 없습니다.'}
          </div>
        ) : (
          <div className="cards">
            {cooking.map((order) => (
              <article className="card cooking" key={order.id}>
                <div className="card-head">
                  <span className="order-no">{order.pickupNo ?? `#${order.id}`}</span>
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
                  <span className="muted">{formatTime(order.updatedAt)}</span>
                </div>
                <TicketBody order={order} deviceId={deviceId} isMain={isMain} />
                <div className="amount">{formatAmount(order.amount)}</div>
                {/*
                  내 줄은 끝났는데 주문이 아직 COOKING 이면, **옆 주방을
                  기다리는 중**입니다. 그때 조리완료 버튼을 그대로 두면
                  주방은 눌러도 아무 일이 안 일어나는 것을 보고 고장인 줄
                  압니다. 무엇을 기다리는지 말해 줍니다.
                */}
                {!isMain && myLinesDone(order, deviceId) ? (
                  <div className="waiting-others">
                    내 것은 끝났습니다 — {pendingKitchens(order).join(', ')} 를 기다리는 중
                  </div>
                ) : (
                  <div className="row">
                    <button
                      className="btn accept"
                      disabled={busyId === order.id}
                      onClick={() => void complete(order)}
                    >
                      {isMain ? '전부 조리완료' : '조리완료'}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/*
        수령은 **메인의 일**입니다 (2026-09-18).

        두 주방이 걸린 주문을 손님에게 건네려면 둘 다 끝났는지 알아야
        하는데, 생산 주방은 자기 것밖에 모릅니다. 짜장면을 만든 주방이
        초밥이 나왔는지 모르는 채로 내주면 손님은 반만 받아 갑니다.
      */}
      {emergency && (
        <div className="warn" role="status">
          <strong>KDS-MAIN 이 끊겨 있습니다</strong>
          {kdsMode?.since && <> ({formatTime(kdsMode.since)} 부터)</>}. 그동안 여기서 수령할 수
          있고, 수령은 <strong>비상 수령</strong>으로 기록됩니다. MAIN 이 돌아오면 이 칸은 사라집니다.
        </div>
      )}
      {(isMain || emergency) && (
      <section>
        <h2>
          수령 대기
          {waitingPickup.length > 0 && <span className="count">{waitingPickup.length}</span>}
        </h2>
        {waitingPickup.length === 0 ? (
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '가져갈 주문이 없습니다.'}
          </div>
        ) : (
          <div className="cards">
            {waitingPickup.map((order) => (
              <article className="card ready" key={order.id}>
                <div className="card-head">
                  <span className="order-no">{order.pickupNo ?? `#${order.id}`}</span>
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
                  <span className="muted">{formatTime(order.updatedAt)}</span>
                </div>
                <TicketBody order={order} deviceId={deviceId} isMain={isMain} />
                <div className="row">
                  <button
                    className="btn accept"
                    disabled={busyId === order.id}
                    onClick={() => { setPin(''); setPinError(null); setHandingOver(order) }}
                  >
                    수령 확인
                  </button>
                  {canPrintLabels && (
                    <button
                      className="btn"
                      onClick={() => void openLabels(order)}
                      title="라벨을 다시 찍습니다 — 처음과 같은 내용에 '재출력' 이 붙습니다"
                    >
                      라벨 다시
                    </button>
                  )}
                  {isMain && (
                    <button
                      className="btn recall"
                      disabled={busyId === order.id}
                      onClick={() => void callAgain(order)}
                      title="DID에 이 번호를 다시 띄웁니다"
                    >
                      {recalled === order.id ? '불렀습니다' : '다시 부르기'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      )}

      {labelsFor && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet">
            <h3>{labelsFor.pickupNo ?? `#${labelsFor.id}`} 라벨</h3>
            {labelJobs.length === 0 ? (
              <p className="muted">이 주문의 라벨 작업이 없습니다 (라벨 프린터가 없는 매장이거나 아직 완료 전).</p>
            ) : (
              <ul className="label-list">
                {labelJobs.filter((j) => j.copyNo === 0).map((j) => {
                  const copies = labelJobs.filter((c) => c.originalId === j.id).length
                  return (
                    <li key={j.id}>
                      <span>
                        {j.content.menuName ?? ''} {j.unitTotal && j.unitTotal > 1 ? `${j.unitNo}/${j.unitTotal}` : ''}
                        {' · '}{j.status === 'PRINTED' ? '찍힘' : j.status === 'FAILED' ? `실패 (${j.error ?? ''})` : '대기'}
                        {copies > 0 && ` · 재출력 ${copies}`}
                      </span>
                      <button className="btn" onClick={() => void reprint(j)}>다시</button>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="row">
              <button className="btn" onClick={() => setLabelsFor(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {handingOver && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet">
            <h3>{handingOver.pickupNo ?? `#${handingOver.id}`} 수령</h3>
            <p className="muted">
              {handingOver.menuName}
              {tableLabel(handingOver) && <> · {tableLabel(handingOver)}</>}
            </p>
            <p className="muted">
              손님 화면의 <strong>네 자리 수령번호</strong>를 물어보고 그대로 입력하세요.
              {handingOver.pickupPin === null && <> 이 주문은 수령번호가 없던 시절의 것이라 비워두고 확인하면 됩니다.</>}
            </p>
            <input
              className="pin-input"
              type="text"
              inputMode="numeric"
              autoFocus
              maxLength={4}
              placeholder="0000"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmPickup() }}
            />
            {pinError && <div className="error" role="alert">{pinError}</div>}
            <div className="row">
              <button className="btn accept" disabled={busyId === handingOver.id}
                      onClick={() => void confirmPickup()}>
                {busyId === handingOver.id ? '확인 중…' : '내주기'}
              </button>
              <button className="btn" onClick={() => { setHandingOver(null); setPinError(null) }}>
                취소
              </button>
            </div>

            {/*
              강제 진행. 번호를 못 대는 손님은 실제로 있습니다 — 화면을
              껐고, 일행이 대신 왔고, 종이를 잃어버렸습니다. 그때 내줄
              방법이 없으면 매장은 줄을 세운 채로 막힙니다.

              그렇다고 번호 칸을 지우지는 않습니다. 필수 입력이 거슬리면
              사람들은 그것을 무의미하게 만드는 방법을 찾습니다 — 전
              직원이 아는 고정 번호를 쓰거나, 손님에게 안 묻고 화면의
              번호를 그대로 칩니다. 그러면 기록에는 "확인함"만 남고
              실제로는 아무도 확인하지 않게 됩니다.

              그래서 아래에 따로 둡니다: 기본은 번호를 맞춰 보는 것이고,
              이건 한 번 더 누르는 다른 버튼이며, 누른 건은 표시가 남습니다.
            */}
            <div className="force-row">
              <button
                className="btn force"
                disabled={busyId === handingOver.id}
                onClick={() => void confirmPickup(true)}
              >
                번호 없이 내주기
              </button>
              <span className="muted">
                번호를 못 대는 손님일 때. 이 건은 <strong>번호 확인 없음</strong>으로 남습니다.
              </span>
            </div>
          </div>
        </div>
      )}

      <section>
        <h2>최근 완료</h2>
        {recent.length === 0 ? (
          <div className="empty">아직 완료한 주문이 없습니다.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>수령번호</th><th>메뉴</th><th>금액</th><th>상태</th><th>시각</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((order) => (
                  <tr key={order.id}>
                    <td className="muted">{order.pickupNo ?? `#${order.id}`}</td>
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

function TerminalPrompt({ onChosen }:
  { onChosen: (storeId: string, deviceId: string, role: KdsRole) => void }) {
  const [store, setStore] = useState(() => localStorage.getItem('kds.lastStoreId') ?? '')
  const [device, setDevice] = useState(() => localStorage.getItem('kds.lastDeviceId') ?? '')
  const [role, setRole] = useState<KdsRole>('PRODUCTION')
  return (
    <div className="prompt">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          onChosen(store.trim(), device.trim(), role)
        }}
      >
        <h1>단말 등록</h1>
        <p className="muted">
          이 화면이 속한 매장과 장비 ID를 입력하세요. <strong>창(탭)마다 따로</strong>
          기억하므로, 새 창을 열어 다른 매장을 함께 볼 수 있습니다.
        </p>

        {/*
          하는 일을 고릅니다 (2026-09-18).

          생산 주방은 **자기 줄만** 만듭니다. 메인은 전체 흐름을 보고,
          다 된 주문을 손님에게 건넵니다 — 두 주방이 걸린 주문을 생산
          주방이 내주면 반만 나간 것을 모릅니다.
        */}
        <div className="role-pick">
          <label className={role === 'PRODUCTION' ? 'picked' : undefined}>
            <input
              type="radio"
              checked={role === 'PRODUCTION'}
              onChange={() => setRole('PRODUCTION')}
            />
            <span>
              <strong>생산 주방</strong>
              <em>내 줄만 만듭니다 (kds-01, kds-02…)</em>
            </span>
          </label>
          <label className={role === 'MAIN' ? 'picked' : undefined}>
            <input
              type="radio"
              checked={role === 'MAIN'}
              onChange={() => setRole('MAIN')}
            />
            <span>
              <strong>메인</strong>
              <em>전체 흐름을 보고 손님에게 내줍니다</em>
            </span>
          </label>
        </div>
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
