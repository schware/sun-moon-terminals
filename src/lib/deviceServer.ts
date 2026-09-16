/**
 * A terminal's view of the platform, through the Device Server.
 *
 * <p>The terminal never learns where the Order service lives — it asks the
 * Device Server, which proxies. That keeps one address to configure on a
 * screen mounted in a shop, and means Order can move without anyone
 * touching a terminal.
 *
 * <p>The base URL is build-time configuration (`VITE_DEVICE_SERVER`)
 * because these apps ship as static files with no server of their own to
 * ask at runtime.
 */

// The default is the public address on purpose: this screen is opened from
// the :8000 hub by its public link, and a LAN default silently produced a
// build that only worked inside the LAN — from outside it loaded fine and
// then reported the Device Server as unreachable.
const BASE = import.meta.env.VITE_DEVICE_SERVER ?? 'http://211.217.183.232:8087'

export type OrderStatus =
  | 'PLACED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'PRODUCED'
  | 'DELIVERING'
  | 'COMPLETED'

export interface Order {
  id: number
  storeId: string
  customerId: string
  /** 영수증에 찍히는 품목. 티켓은 고객 id로 충분했지만 영수증은 아닙니다. */
  menuName: string
  amount: number
  status: OrderStatus
  acceptedBy: string | null
  /**
   * 판매일자 — 매출 키의 한 자리이고, 영수증에 그대로 찍힙니다.
   * placedAt 의 달력 날짜가 아닙니다: 자정을 넘겨 장사한 주문도
   * 그날 영업일에 속합니다.
   */
  businessDate: string | null
  /**
   * 도착지 — "이 메뉴를 저 자리로". 테이블 QR로 들어온 주문에만 있고,
   * 매장 선택 화면이나 (앞으로의) 포장·배달 주문은 null입니다.
   * null이 "모른다"가 아니라 "테이블이 아니다"라는 뜻입니다.
   */
  floor: number | null
  tableNo: string | null
  /**
   * 수령번호 — 손님이 "이거 제 거예요"를 증명하는 값. 두 조각입니다.
   *
   * `pickupNo` 는 **부르는 번호**입니다. DID에 크게 뜨고 손님이 보고
   * 옵니다 — 자리 + 일련번호("7-12", 2층이면 "2-7-12", 테이블이 아니면
   * "P-12"). 층이 2층부터 붙는 것은, 1층 7번과 2층 7번이 같은 번호를
   * 받으면 두 손님이 같은 번호를 들고 오기 때문입니다.
   *
   * `pickupPin` 은 **증명하는 번호**입니다. 4자리이고, 같은 번호를 본
   * 다른 손님이 먼저 가져가는 것을 막는 것이 이 값의 전부라 화면에
   * 크게 띄우지 않습니다.
   *
   * 2026-09-17 이전 주문에는 둘 다 없습니다(null). 그 경우 화면은
   * 수령번호 칸을 아예 그리지 않습니다 — 빈 칸은 누락처럼 읽힙니다.
   */
  pickupNo: string | null
  pickupPin: string | null
  /**
   * 거래번호 — 매출 키의 마지막 자리
   * (판매일자 + 점포코드 + POS번호 + 거래번호).
   * **이 단말이 채번합니다** — 수락할 때 붙고, 그 전에는 null입니다.
   * 아직 거래가 아니기 때문입니다.
   */
  tranNo: string | null
  /** 이 주문이 들어온 테이블 QR의 코드. 키의 일부가 아니라 영수증에 함께 찍히는 값입니다. */
  qrCode: string | null
  placedAt: string
  updatedAt: string
}

/** 화면에 붙일 자리 이름. 번호뿐이면 "번"을 붙입니다 — "3 자리"는 어색합니다. */
export function tableLabel(order: { floor: number | null; tableNo: string | null }): string | null {
  if (order.tableNo === null) return null
  const name = /^\d+$/.test(order.tableNo) ? order.tableNo + '번' : order.tableNo
  return order.floor !== null && order.floor > 1 ? order.floor + '층 ' + name : name
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PLACED: '접수됨',
  ACCEPTED: '수락됨',
  REJECTED: '거절됨',
  EXPIRED: '시간 초과',
  PRODUCED: '생산 완료',
  DELIVERING: '배달 중',
  COMPLETED: '완료'
}

async function failure(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return new Error(body.error)
  } catch {
    // not JSON
  }
  if (res.status === 409) return new Error('이미 처리된 주문입니다')
  if (res.status === 502) return new Error('주문 서비스에 연결할 수 없습니다')
  return new Error(`요청이 실패했습니다 (HTTP ${res.status})`)
}

/** The "Get" half: the WebSocket only says something changed, this asks what is true. */
export async function fetchOrders(status?: OrderStatus): Promise<Order[]> {
  const res = await fetch(`${BASE}/orders${status ? `?status=${status}` : ''}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order[]
}

/**
 * Asks Order to move the order on. The Device Server passes the answer
 * through unchanged, so a 409 here is the state machine refusing — usually
 * because another terminal got there first, or it already expired.
 */
export async function changeStatus(
  orderId: number,
  status: OrderStatus,
  deviceId?: string,
  tranNo?: string
): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), status })
  if (deviceId) params.set('deviceId', deviceId)
  // 수락할 때만 실립니다. 뒤의 전이에서 보내도 서버가 무시합니다 —
  // 매출의 키가 조리·배달 과정에서 움직이면 그건 더 이상 키가 아닙니다.
  if (tranNo) params.set('tranNo', tranNo)

  const res = await fetch(`${BASE}/orders/status?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

export interface BusinessDayStatus {
  storeId: string
  open: boolean
  businessDate?: string
  openedBy?: string
  needsClosing: boolean
}

export interface BusinessDay {
  storeId: string
  businessDate: string
  openedAt: string
  openedBy: string
  closedAt: string | null
  closedBy: string | null
}

export interface OpenResult {
  day: BusinessDay
  rolled: boolean
  closedDate?: string
  reopened?: boolean
}

/** Whether this store has 개점'd, and whether its 영업일자 has gone stale (needsClosing). */
export async function fetchBusinessDayStatus(storeId: string): Promise<BusinessDayStatus> {
  const res = await fetch(`${BASE}/business-days/status?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as BusinessDayStatus
}

/**
 * 개점. If the store was left open on a stale 영업일자, Order closes that
 * day first and opens today instead — `rolled`/`closedDate` say so. If
 * today is already open, `reopened` says this resumed a same-day 마감
 * rather than starting a new day.
 */
export async function openBusinessDay(storeId: string, deviceId: string): Promise<OpenResult> {
  const res = await fetch(`${BASE}/business-days/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId, deviceId })
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as OpenResult
}

/** 마감. 409 if the store was not open — surfaced via `failure()`'s own error-message handling. */
export async function closeBusinessDay(storeId: string, deviceId: string): Promise<BusinessDay> {
  const res = await fetch(`${BASE}/business-days/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId, deviceId })
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as BusinessDay
}

/**
 * 소켓으로 오는 프레임. 지금 두 종류입니다.
 *
 * 주문 이벤트는 `orderId`를 들고 오고, 기준 정보 이벤트는 `type`이
 * `MENU_`로 시작합니다. 둘 다 **바뀌었다는 신호일 뿐**이고 화면이 믿는
 * 값이 아닙니다 — 무엇이 참인지는 다시 물어봅니다.
 */
export interface TerminalEvent {
  orderId?: number
  status?: string
  storeId?: string
  /** 'MENU_SOLD_OUT' | 'MENU_RESTORED' — 주문 이벤트에는 없습니다. */
  type?: string
  menuCode?: string
  businessDate?: string
}

/** 이 프레임이 기준 정보(결품) 알림인가. 아니면 주문 쪽입니다. */
export function isMenuEvent(event?: TerminalEvent): boolean {
  return typeof event?.type === 'string' && event.type.startsWith('MENU_')
}

/**
 * 단말의 로컬 마스터 한 줄 — 오늘 이 매장이 파는 것과, 떨어진 것.
 *
 * `soldOut`은 "오늘 없다"이지 메뉴를 내린 것이 아닙니다. 내린 메뉴는
 * 애초에 목록에 없습니다.
 *
 * `estimatedMinutes`는 기준 조리시간 x (대기열 + 1)이고, 모르면
 * null입니다 — 0으로 읽으면 안 됩니다.
 */
export interface MenuBoardItem {
  menuCode: string
  name: string
  imageUrl: string | null
  description: string | null
  kdsDeviceId: string | null
  price: number | null
  soldOut: boolean
  orderable: boolean
  cookMinutes: number | null
  estimatedMinutes: number | null
}

export interface MenuBoard {
  storeId: string
  businessDate: string
  menus: MenuBoardItem[]
}

/**
 * 오늘의 메뉴판. Device Server가 APP-SERVER에 물어봐 줍니다 — 단말은
 * 주소를 하나만 압니다.
 */
export async function fetchMenuBoard(storeId: string): Promise<MenuBoard> {
  const res = await fetch(`${BASE}/menus?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as MenuBoard
}

export function socketUrl(deviceId: string, storeId: string, type: 'POS' | 'KDS' | 'DID'): string {
  const ws = BASE.replace(/^http/, 'ws')
  return `${ws}/ws?deviceId=${encodeURIComponent(deviceId)}`
    + `&storeId=${encodeURIComponent(storeId)}&type=${type}`
}

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount)
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ko-KR', { timeStyle: 'medium' })
}
