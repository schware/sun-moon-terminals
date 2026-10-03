import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  changeStatus,
  closeBusinessDay,
  fetchMenuBoard,
  fetchOrders,
  formatAmount,
  formatTime,
  acknowledgeNotice,
  fetchNotices,
  isMenuEvent,
  isNoticeEvent,
  openBusinessDay,
  reportReceived,
  fetchBusinessDayStatus,
  findOrder,
  uploadSales,
  STATUS_LABEL,
  type BusinessDayStatus,
  type MenuBoardItem,
  type Notice,
  type Order,
  type TerminalEvent,
  tableLabel
} from './lib/posApi'
import { forgetShellDevice, shellDevice } from '@sunmoon/terminal-common/shell'
import { claimUrl, drawClaimQr } from './lib/claimQr'
import * as ledger from './lib/ledger'
import { buildTrSale } from './lib/trSale'
import { useTerminalSocket } from '@sunmoon/terminal-common/socket'

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
  // 셸 안이면 셸에 설정된 매장·장비가 먼저입니다 (store-app.md §5.2).
  const paired = shellDevice()
  const [deviceId, setDeviceId] = useState<string>(
    () => paired?.deviceId ?? query.get('deviceId') ?? sessionStorage.getItem('deviceId') ?? ''
  )
  const [storeId, setStoreId] = useState<string>(
    () => paired?.storeId ?? query.get('storeId') ?? sessionStorage.getItem('storeId') ?? ''
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
          // 화면마다 따로 — POS·KDS·DID 가 같은 주소(:8000)라 localStorage 를 같이 씁니다.
          localStorage.setItem('pos.lastStoreId', store)
          localStorage.setItem('pos.lastDeviceId', device)
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
        if (shellDevice()) {
          if (!window.confirm('이 기기의 매장·장비 설정을 지웁니다. 셸이 설정 화면으로 돌아갑니다.')) return
          forgetShellDevice()
        }
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
  const [orders, setOrders] = useState<Order[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const [businessDay, setBusinessDay] = useState<BusinessDayStatus | null>(null)
  const [businessDayBusy, setBusinessDayBusy] = useState(false)
  const [businessDayError, setBusinessDayError] = useState<string | null>(null)

  // 단말의 로컬 마스터. BO에서 결품을 걸면 menu-events 가 이 화면을
  // 깨우고, 그때 다시 읽습니다 — 프레임의 내용을 믿지는 않습니다.
  const [menus, setMenus] = useState<MenuBoardItem[]>([])
  const [menuError, setMenuError] = useState<string | null>(null)

  // 방금 수락한 주문의 영수증. 수락 직후 한 번 뜨고, 닫으면 사라집니다
  // — 다시 필요하면 최근 주문에서 다시 엽니다.
  const [receipt, setReceipt] = useState<Order | null>(null)

  // 이 단말에 걸린 공지 (업무 정의서 §3.5).
  const [notices, setNotices] = useState<Notice[]>([])
  // 아직 안 본 긴급 메시지. **화면을 가로막습니다** — 긴급인데
  // 구석에 뜨면 바쁜 카운터에서는 안 읽힙니다.
  const [urgent, setUrgent] = useState<Notice | null>(null)
  // 방금 닫은 것. **서버가 확인 기록의 주인**이고(2026-09-18 고침),
  // 이건 확인을 누른 순간부터 다음 조회까지의 몇 초를 메우는 값입니다 —
  // 그 사이에 폴링이 돌면 방금 닫은 것이 다시 뜹니다.
  const [justClosed, setJustClosed] = useState<Set<number>>(() => new Set())
  // 목록을 펼쳤나. 평소에는 줄 하나로 접혀 있습니다.
  const [noticesOpen, setNoticesOpen] = useState(false)

  /**
   * 아직 못 올린 거래 수 (umbrella docs/adr/0010).
   *
   * <p><b>화면에 있어야 합니다.</b> 이 플랫폼은 이미 조용한 실패에
   * 시간을 잃었습니다 — `EVENTS_REDIS` 가 안 붙은 채로 며칠 동안
   * 실시간 push 가 아무 일도 안 했고, 모든 화면이 자기 폴링으로
   * 멀쩡해 보였습니다. 큐가 안 보이는 곳에서 차오르면 같은 모양의
   * 사고가 됩니다.
   */
  const [unsent, setUnsent] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const loadNotices = useCallback(async () => {
    try {
      const current = await fetchNotices(storeId, 'POS', deviceId)
      setNotices(current)
      // **안 본 긴급만** 띄웁니다. 본 것인지는 서버가 압니다 — 화면이
      // 기억하면 새로고침할 때마다 같은 것이 다시 가로막습니다.
      setUrgent((open) => open
        ?? current.find((n) => n.urgent && !n.acknowledged && !justClosed.has(n.id))
        ?? null)
    } catch {
      // 공지를 못 읽은 것으로 주문 화면을 막지 않습니다. 장사가 먼저입니다.
    }
  }, [storeId, deviceId, justClosed])

  useEffect(() => {
    void loadNotices()
    // 긴급은 소켓이 밀어 넣으므로 이 폴링은 안전망입니다 — 꺼져 있다
    // 켜진 단말이 그때 걸린 글을 보는 길이기도 합니다.
    const timer = window.setInterval(() => void loadNotices(), 60000)
    return () => window.clearInterval(timer)
  }, [loadNotices])

  async function closeUrgent(notice: Notice) {
    setJustClosed((current) => new Set(current).add(notice.id))
    setUrgent(null)
    // 확인을 **기다린 뒤에** 목록을 다시 읽습니다. 기다리지 않으면
    // 그 조회가 아직 기록되기 전의 답을 받아 와서, 같은 것이 한 번 더
    // 뜹니다.
    await acknowledgeNotice(notice.id, storeId, 'POS', deviceId)
    await loadNotices()
  }

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

  /**
   * 밀린 거래를 올립니다 (업무 정의서 §3.1, umbrella docs/adr/0010).
   *
   * <p>주문 흐름과 거래 전송은 <b>다른 경로</b>입니다. 수락은 그
   * 자리에서 서버로 가고(주방이 티켓을 봐야 하니까), 거래 원장은
   * 여기서 따로 올라갑니다. 한 동작이 둘을 냅니다 — 티켓은 지금,
   * 원장은 나중에.
   *
   * <p>한 번에 배열로 보냅니다. 그리고 이미 받은 거래를 다시 보내도
   * 서버가 오류를 내지 않아서, 올렸는지 확신이 없으면 그냥 다시
   * 보내면 됩니다.
   *
   * @returns 올리고도 남은 건수.
   */
  const flush = useCallback(async (): Promise<number> => {
    let queued: ledger.TranRow[]
    try {
      queued = await ledger.pending(storeId, deviceId)
    } catch {
      // IndexedDB 를 못 여는 브라우저·모드가 있습니다. 거래 전송이
      // 안 되는 것과 주문을 못 받는 것은 다른 일이라, 화면은 그대로 둡니다.
      return 0
    }
    if (queued.length === 0) {
      setUnsent(0)
      setUploadError(null)
      return 0
    }
    try {
      await uploadSales(queued.map((r) => r.payload))
      await ledger.markSent(queued.map((r) => r.id))
      setUploadError(null)
    } catch (e) {
      const reason = e instanceof Error ? e.message : '거래를 올리지 못했습니다'
      await ledger.markFailed(queued.map((r) => r.id), reason)
      setUploadError(reason)
    }
    const left = await ledger.unsentCount(storeId, deviceId)
    setUnsent(left)
    return left
  }, [storeId, deviceId])

  /**
   * 시작할 때 한 번 — 옛 채번을 옮겨오고, 열린 창을 닫고, 밀린 것을 올립니다.
   *
   * <p>순서가 중요합니다. 채번을 먼저 옮기지 않으면 번호가 1번부터
   * 다시 시작하고, 창을 닫기 전에 올리면 아직 수락됐는지 모르는
   * 거래가 매출로 올라갑니다.
   */
  useEffect(() => {
    let cancelled = false
    async function settle() {
      try {
        await ledger.adoptLegacyCounters()
        const stuck = await ledger.minted(storeId, deviceId)
        for (const row of stuck) {
          if (cancelled) return
          let order: Order | null
          try {
            order = await findOrder(row.orderId)
          } catch {
            return // 못 물어봤습니다. 다음 기회에 — 지우지 않습니다.
          }
          const accepted = order !== null
            && order.tranNo === row.tranNo
            && order.status !== 'PLACED'
            && order.status !== 'REJECTED'
            && order.status !== 'EXPIRED'
          if (accepted && order) {
            await ledger.confirm(row.id, buildTrSale(
              order, row.storeId, row.deviceId, row.businessDate, row.tranNo, row.mintedAt))
          } else {
            await ledger.discard(row.id, '수락이 확인되지 않았습니다')
          }
        }
      } catch {
        // 로컬 원장을 못 쓰는 환경. 아래 전송도 조용히 0건이 됩니다.
      }
      if (!cancelled) await flush()
    }
    void settle()
    // 배치입니다. 30초는 매출 분해 배치와 같은 주기라, 올린 것이
    // 다음 분해에 곧바로 실립니다.
    const timer = window.setInterval(() => void flush(), 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [storeId, deviceId, flush])

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

  /**
   * 마감은 <b>전송을 검증하는 지점</b>이기도 합니다 (umbrella docs/adr/0010).
   *
   * <p>전송이 비동기가 된 순간부터, 마감은 "오늘 장사 끝"만이 아니라
   * "내 거래가 전부 올라갔는가"에도 답해야 합니다. 못 올린 채로 닫은
   * 매장은 <b>다음 날 아침에</b> 금액이 안 맞는 것을 알게 됩니다.
   *
   * <p>그래서 먼저 올려 보고, 남으면 말합니다. 막지는 않습니다 —
   * 서버가 죽어 있는데 매장을 못 닫게 하면 그게 더 나쁩니다. 남은
   * 거래는 원장에 그대로 있고 다음에 올라갑니다.
   */
  async function closeStore() {
    const left = await flush()
    const warning = left > 0
      ? `\n\n아직 올리지 못한 거래가 ${left}건 있습니다. 마감해도 사라지지 않고, 연결이 돌아오면 올라갑니다.`
      : ''
    if (!window.confirm(
      `${storeId}을(를) 마감할까요? 오늘 접수된 주문은 그대로 남고, 새 주문만 막힙니다.${warning}`
    )) return
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
      //
      // 판매일자로 거르는 일은 여기서 하지 않습니다 — 아래에서 파생시킵니다.
      const mine = (await fetchOrders()).filter((o) => o.storeId === storeId)
      setOrders(mine)
      // 화면에 올린 주문은 "POS가 받았다"입니다 (업무 정의서 §5.3).
      // 아직 답하지 않은 주문만, 그리고 한 번만 보고합니다 — 상태를
      // 바꾸는 호출이 아니라 전달 사실을 남기는 것이라, 두 번째부터는
      // 서버가 처음 시각을 지킵니다.
      for (const order of mine) {
        if (order.status === 'PLACED' && order.receivedAt === null) {
          void reportReceived(order.id, deviceId)
        }
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '주문을 불러오지 못했습니다')
    }
  }, [storeId, deviceId])

  // 프레임 하나에 두 가지가 옵니다. 결품 알림이면 메뉴판만, 그 밖이면
  // 주문만 다시 읽습니다 — 결품 한 번에 주문 목록까지 새로 당길 이유가
  // 없습니다. 프레임을 못 읽었으면(undefined) 둘 다 읽습니다.
  const onEvent = useCallback((event?: TerminalEvent) => {
    if (event === undefined) {
      void reload()
      void loadMenus()
      return
    }
    // 긴급 메시지는 **내용을 싣고 옵니다**. 다시 물어보지 않는 이유:
    // 사람이 지금 읽어야 하는 글이라 한 번 더 왕복할 시간이 아깝고,
    // 그 사이에 소켓이 끊기면 아예 못 보게 됩니다.
    if (isNoticeEvent(event)) {
      if (event.noticeId !== undefined && !justClosed.has(event.noticeId)) {
        setUrgent({
          id: event.noticeId,
          scope: event.storeId ?? storeId,
          deviceType: 'POS',
          title: event.title ?? '긴급 메시지',
          body: event.body ?? '',
          urgent: true,
          startsAt: new Date().toISOString(),
          endsAt: null,
          createdBy: null,
          acknowledged: false
        })
      }
      // 목록도 같이 당깁니다 — 닫은 뒤에 다시 볼 수 있어야 합니다.
      void loadNotices()
      return
    }
    if (isMenuEvent(event)) void loadMenus()
    else void reload()
  }, [reload, loadMenus, loadNotices, justClosed, storeId])

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

  /**
   * 판매일자 scoping — KDS·DID와 같은 규칙입니다.
   *
   * 화면에는 이 매장이 지금 올라타 있는 판매일자의 주문만 둡니다. 그게
   * 개점이 화면을 비우는 방식입니다: 어젯밤에 안 끝난 주문은 어제
   * 판매일자에 속하고, 오늘 아침 카운터의 일이 아닙니다.
   *
   * 다시 읽는 것이 아니라 파생시킵니다. 그래야 "초기화"라는 절차가 없고,
   * 따라서 잊을 절차도 없습니다 — 30초마다 확인하는 판매일자가 바뀌면
   * 다음 렌더에서 목록이 저절로 다시 걸립니다.
   *
   * 마감한 매장은 열린 판매일자가 없으므로 오늘에 속하는 주문도 없습니다.
   * 목록이 비고, 그 이유는 위의 영업 바가 이미 말하고 있습니다. 지나간
   * 날의 주문을 보는 곳은 BO의 매출 조회입니다.
   */
  const today = businessDay?.open ? businessDay.businessDate ?? null : null
  const inToday = useCallback(
    (order: Order) => today !== null && order.businessDate === today,
    [today]
  )

  const waiting = useMemo(
    () => orders.filter((o) => inToday(o) && o.status === 'PLACED'),
    [orders, inToday]
  )

  const recent = useMemo(
    () => orders.filter((o) => inToday(o) && o.status !== 'PLACED').slice(0, 12),
    [orders, inToday]
  )

  // 결품만 따로 뽑아 위에 한 줄로 띄웁니다. 주문을 받는 사람이 제일
  // 먼저 알아야 하는 것이 "오늘 없는 것"이라서요.
  const soldOut = menus.filter((m) => m.soldOut)

  async function decide(order: Order, next: 'ACCEPTED' | 'REJECTED') {
    setBusyId(order.id)
    setError(null)
    // 번호를 끊었다면 그 줄. 실패하면 이 줄을 비워야 합니다.
    let minted: ledger.TranRow | null = null
    try {
      // 거래번호는 수락할 때 이 단말이 끊습니다 (umbrella docs/adr/0009).
      // 거절에는 붙이지 않습니다 — 거절은 매출이 아니고, 번호를 태우면
      // 영수증 번호가 구멍 난 채로 이어집니다.
      //
      // **번호와 거래가 한 트랜잭션에서 납니다** (docs/adr/0010). 예전에는
      // localStorage 에 번호만 올렸는데, 그 직후에 브라우저가 죽으면
      // 번호가 되돌아가 같은 번호가 두 번 올라갔습니다.
      if (next === 'ACCEPTED' && businessDay?.businessDate) {
        minted = await ledger.mint(storeId, deviceId, businessDay.businessDate, order.id)
      }
      const moved = await changeStatus(order.id, next, deviceId, minted?.tranNo)
      if (minted) {
        // 이제 거래입니다. 전문을 적어 두고 올릴 것으로 돌립니다 —
        // 올리는 것은 이 자리에서 기다리지 않습니다. 손님이 서 있습니다.
        await ledger.confirm(minted.id, buildTrSale(
          moved, storeId, deviceId, minted.businessDate, minted.tranNo, minted.mintedAt))
        setUnsent(await ledger.unsentCount(storeId, deviceId))
        void flush()
      }
      if (next === 'ACCEPTED') setReceipt(moved)
    } catch (e) {
      // Usually a 409: it expired, or another terminal took it first.
      // Either way this screen is now out of date, so refresh rather
      // than argue with the server about it.
      const reason = e instanceof Error ? e.message : '처리하지 못했습니다'
      // 번호는 돌려주지 않습니다. 되돌리면 다음 거래가 같은 번호를
      // 쓰는데, 그 사이에 이 번호가 이미 올라갔을 수 있습니다 —
      // 영수증 번호의 구멍이 매출의 중복보다 낫습니다.
      if (minted) await ledger.discard(minted.id, reason).catch(() => undefined)
      setError(reason)
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

      {/*
        공지 줄. 평소에는 **한 줄로 접혀** 있습니다 — 상시 공지가 화면
        위쪽을 차지하면 정작 주문 목록이 밀리고, 며칠 지나면 아무도 안
        읽습니다. 누르면 펴집니다.

        긴급은 여기 말고 화면 전체를 막는 창으로 뜹니다(아래).
      */}
      {notices.length > 0 && (
        <div className={`notice-bar${noticesOpen ? ' open' : ''}`}>
          <button
            className="notice-head"
            onClick={() => setNoticesOpen((open) => !open)}
            aria-expanded={noticesOpen}
          >
            <span className="notice-icon">공지</span>
            <span className="notice-title">
              {noticesOpen ? `${notices.length}건` : notices[0]!.title}
            </span>
            {notices.some((n) => n.urgent) && <span className="notice-flag">긴급</span>}
            <span className="muted">{noticesOpen ? '접기' : '펼치기'}</span>
          </button>
          {noticesOpen && (
            <ul className="notice-list">
              {notices.map((notice) => (
                <li key={notice.id} className={notice.urgent ? 'urgent' : undefined}>
                  <strong>
                    {notice.title}
                    {/* 본 것도 목록에는 남습니다 — 한 번 읽고 사라지는
                        글이면 내용을 되짚을 수가 없습니다. */}
                    {notice.urgent && notice.acknowledged && (
                      <span className="notice-seen">확인함</span>
                    )}
                  </strong>
                  <p>{notice.body}</p>
                  {notice.createdBy && <span className="muted">— {notice.createdBy}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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

      {/* 미전송 건수는 화면에 있어야 합니다 (umbrella docs/adr/0010).
          안 보이는 곳에서 차오르는 큐는 조용한 실패가 됩니다. */}
      {unsent > 0 && (
        <div className="warn" role="status">
          아직 올리지 못한 거래 <strong>{unsent}건</strong>이 이 단말에 남아 있습니다.
          매출은 사라지지 않고, 연결이 돌아오면 30초 안에 올라갑니다.
          {uploadError && <> 마지막 사유: {uploadError}.</>}
          {' '}
          <button className="btn link" onClick={() => void flush()}>지금 올리기</button>
        </div>
      )}

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
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '대기 중인 주문이 없습니다.'}
          </div>
        ) : (
          <div className="cards">
            {waiting.map((order) => (
              <article className="card" key={order.id}>
                <div className="card-head">
                  {/* 수령번호가 카운터와 손님이 공유하는 말입니다. 주문번호는
                      내부 값이라, 수령번호가 있으면 그쪽을 앞에 둡니다. */}
                  <span className="order-no">{order.pickupNo ?? `#${order.id}`}</span>
                  {tableLabel(order) && <span className="table-tag">{tableLabel(order)}</span>}
                  <span className="muted">{formatTime(order.placedAt)}</span>
                </div>
                <div className="customer">{order.customerId}</div>
                {/* 무엇을 시켰는지 수락 전에 보여야 합니다 — 안 그러면
                    POS는 금액만 보고 수락하게 됩니다. */}
                {order.lines.length > 0 && (
                  <ul className="order-lines">
                    {order.lines.map((line) => (
                      <li key={line.seq}>
                        {line.menuName}
                        {line.quantity > 1 && <span className="muted"> × {line.quantity}</span>}
                      </li>
                    ))}
                  </ul>
                )}
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
        {/* 오늘치만 둡니다. 어제 주문이 섞이면 "지금 무슨 일이
            있었나"를 읽을 수가 없고, 지나간 날을 보는 곳은 BO의
            매출 조회입니다. */}
        <h2>
          오늘 주문
          {today && <span className="muted">판매일자 {today}</span>}
        </h2>
        {recent.length === 0 ? (
          <div className="empty">
            {today === null ? '개점된 판매일자가 없습니다.' : '오늘 처리된 주문이 없습니다.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>수령번호</th><th>거래번호</th><th>금액</th><th>상태</th><th>변경</th><th />
                </tr>
              </thead>
              <tbody>
                {recent.map((order) => (
                  <tr key={order.id}>
                    <td className="muted">{order.pickupNo ?? `#${order.id}`}</td>
                    <td className="muted">{order.tranNo ?? ''}</td>
                    <td>{formatAmount(order.amount)}</td>
                    <td>
                      <span className={`status ${order.status.toLowerCase()}`}>
                        {STATUS_LABEL[order.status]}
                      </span>
                    </td>
                    <td className="muted">{formatTime(order.updatedAt)}</td>
                    <td>
                      {/* 거래번호가 붙은 주문만 영수증이 있습니다 —
                          거절·미응답은 매출이 아닙니다. */}
                      {order.tranNo && (
                        <button className="btn link" onClick={() => setReceipt(order)}>영수증</button>
                      )}
                    </td>
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

      {/*
        긴급 메시지. **화면을 가로막습니다** — 긴급인데 구석에 뜨면 바쁜
        카운터에서는 안 읽힙니다. 닫으면 서버에 "이 단말이 봤다"가
        기록되고, 그게 없으면 안 본 단말을 찾을 길이 없어 전 매장에
        전화를 걸게 됩니다.

        닫은 뒤에도 위 공지 줄에서 다시 볼 수 있습니다 — 한 번 읽고
        사라지는 글이면 내용을 되짚을 수가 없습니다.
      */}
      {urgent && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="긴급 메시지">
          <div className="sheet urgent-sheet">
            <div className="urgent-tag">긴급</div>
            <h3>{urgent.title}</h3>
            <p className="urgent-body">{urgent.body}</p>
            <div className="row">
              <button className="btn accept wide" onClick={() => closeUrgent(urgent)}>
                확인했습니다
              </button>
            </div>
          </div>
        </div>
      )}

      {receipt && (
        <Receipt order={receipt} deviceId={deviceId} onClose={() => setReceipt(null)} />
      )}

      <footer>
        <span className="muted">매장 {storeId} · 장비 {deviceId}</span>
        <button className="btn link" onClick={onForget}>매장·장비 변경</button>
      </footer>
    </div>
  )
}

/**
 * 영수증.
 *
 * <p>싣는 값은 매출 키 그대로입니다 — <b>매장코드 + 판매일자 + POS번호 +
 * 거래번호</b> (umbrella docs/adr/0009). 주문번호(#12)는 OMS의 내부
 * 일련번호라 작게 둡니다: 손님이 매장에 전화해서 부를 값이 아닙니다.
 *
 * <p>QR 번호는 <b>추가로</b> 붙습니다. 키의 자리가 아니라, "어느 자리의
 * 스티커로 들어온 주문인가"를 되짚는 값입니다.
 *
 * <p>브라우저 인쇄를 씁니다. 이 단말에는 아직 프린터 드라이버가 없고,
 * 있어야 할 자리(POS 로컬)가 정해지면 그때 옮깁니다 — 지금 여기서
 * 흉내내면 두 번 만들게 됩니다.
 */
/**
 * 셸(SunMoon Store)의 영수증 프린터 (store-app.md §6.3). 있으면 [인쇄] 가 브라우저 인쇄
 * 대신 영수증 프린터(ESC/POS)로 갑니다 — 무엇을 찍을지만 넘기고, 모양과 프린터 주소는 셸이.
 */
interface ShellReceiptPrinter {
  receipt: (content: unknown) => Promise<{ ok: boolean; error?: string }>
}

function shellReceiptPrinter(): ShellReceiptPrinter | undefined {
  const p = (window as unknown as { sunmoon?: { printer?: Partial<ShellReceiptPrinter> } }).sunmoon?.printer
  return p?.receipt ? (p as ShellReceiptPrinter) : undefined
}

function Receipt({ order, deviceId, onClose }:
  { order: Order; deviceId: string; onClose: () => void }) {
  const [printing, setPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  const shellPrinter = shellReceiptPrinter()

  async function print() {
    if (!shellPrinter) {
      window.print()
      return
    }
    setPrinting(true)
    setPrintError(null)
    const result = await shellPrinter.receipt({
      storeName: order.storeId,
      pickupNo: order.pickupNo,
      tranNo: order.tranNo,
      businessDate: order.businessDate,
      lines: order.lines.length > 0
        ? order.lines.map((l) => ({ menuName: l.menuName, quantity: l.quantity, lineAmount: l.lineAmount }))
        : [{ menuName: order.menuName, quantity: 1, lineAmount: order.amount }],
      total: order.amount,
      payment: order.payment ?? null,
      claimUrl: order.claimToken ? claimUrl(order.claimToken) : null
    }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    setPrinting(false)
    // 못 찍었으면 브라우저 인쇄라는 길이 남아 있습니다 — 막다른 길을 두지 않습니다.
    if (!result.ok) setPrintError(result.error ?? '영수증을 찍지 못했습니다')
  }

  // 주문 QR. 값이 없는 주문(2026-09-24 이전)에는 안 그립니다 — 빈
  // 네모가 찍힌 영수증은 고장으로 읽힙니다.
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    if (!order.claimToken) {
      setQr(null)
      return
    }
    let alive = true
    drawClaimQr(order.claimToken)
      .then((url) => { if (alive) setQr(url) })
      // 못 그려도 영수증은 나갑니다. QR은 덤이고, 수령번호가 본체입니다.
      .catch(() => { if (alive) setQr(null) })
    return () => { alive = false }
  }, [order.claimToken])

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true">
      <div className="sheet receipt">
        <div className="receipt-paper">
          <h3>영수증</h3>
          <dl>
            <dt>매장코드</dt><dd>{order.storeId}</dd>
            <dt>판매일자</dt><dd>{order.businessDate ?? '—'}</dd>
            <dt>POS번호</dt><dd>{order.acceptedBy ?? deviceId}</dd>
            <dt>거래번호</dt><dd className="strong">{order.tranNo ?? '—'}</dd>
          </dl>
          <hr />
          {/* 영수증은 줄마다 한 행입니다. 손님이 받는 종이라 "외 2건"으로
              뭉치면 무엇을 얼마에 샀는지 확인할 수가 없습니다. */}
          {order.lines.length > 0 ? (
            <table className="receipt-lines">
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.seq}>
                    <td>{line.menuName}</td>
                    <td className="qty">{line.quantity}</td>
                    <td className="amt">{formatAmount(line.lineAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <dl><dt>메뉴</dt><dd>{order.menuName}</dd></dl>
          )}
          <dl>
            <dt>금액</dt><dd className="strong">{formatAmount(order.amount)}</dd>
            {tableLabel(order) && <><dt>자리</dt><dd>{tableLabel(order)}</dd></>}
            {order.pickupNo && <><dt>수령번호</dt><dd className="strong">{order.pickupNo}</dd></>}
            {order.qrCode && <><dt>QR번호</dt><dd className="mono">{order.qrCode}</dd></>}
          </dl>
          {/* 주문 QR (umbrella docs/adr/0007). 손님이 찍으면 자기 주문
              상태가 열립니다 — 로그인도 회원번호도 필요 없습니다.
              주소를 글자로도 적지 않습니다: 128비트 난수라 사람이 옮겨
              칠 수 있는 값이 아니고, 적어 두면 종이만 길어집니다. */}
          {qr && (
            <div className="receipt-qr">
              <img src={qr} alt="주문 상태 조회 QR" width={120} height={120} />
              <p>주문 상태를 보려면 QR을 찍으세요</p>
            </div>
          )}
          <p className="receipt-foot">주문 #{order.id} · {formatTime(order.placedAt)}</p>
        </div>
        {printError && (
          <div className="error no-print" role="alert">
            {printError}{' '}
            <button className="btn link" onClick={() => window.print()}>브라우저로 인쇄</button>
          </div>
        )}
        <div className="row no-print">
          <button className="btn accept" disabled={printing} onClick={() => void print()}>
            {printing ? '인쇄 중…' : '인쇄'}
          </button>
          <button className="btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}

function TerminalPrompt({ onChosen }: { onChosen: (storeId: string, deviceId: string) => void }) {
  // Prefilled from the last window, not applied automatically — this
  // screen always asks, so a second window can be a different shop.
  const [store, setStore] = useState(() => localStorage.getItem('pos.lastStoreId') ?? '')
  const [device, setDevice] = useState(() => localStorage.getItem('pos.lastDeviceId') ?? '')
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
