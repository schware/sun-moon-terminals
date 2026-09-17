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

// The default is the public address on purpose — see sun-moon-terminal-pos's
// README for why a LAN default is the wrong default for a screen opened
// from the :8000 hub's public link.
const BASE = import.meta.env.VITE_DEVICE_SERVER ?? 'http://211.217.183.232:8087'

export type OrderStatus =
  | 'PLACED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'COOKING'
  | 'PRODUCED'
  | 'DELIVERING'
  | 'COMPLETED'

export interface Order {
  id: number
  storeId: string
  customerId: string
  menuName: string
  amount: number
  status: OrderStatus
  acceptedBy: string | null
  kdsDeviceId: string | null
  /**
   * 판매일자 — the 영업일자 that was open when the order arrived, which is
   * not the calendar date of `placedAt`: a shop trading past midnight is
   * still on the same business day. Null only for orders placed before
   * 영업일 existed at all.
   *
   * Order has sent this since 2026-09-10; this interface did not declare
   * it until 2026-09-15, so the kitchen screen was receiving the field
   * and throwing it away — which is exactly why last night's unfinished
   * tickets were still on the board this morning.
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
  /** 거래번호 — 매출 키의 마지막 자리. POS가 채번하고, 수락 전에는 null입니다. */
  tranNo: string | null
  /** 이 주문이 들어온 테이블 QR의 코드. 키의 일부가 아닌 추가 값입니다. */
  qrCode: string | null
  /**
   * POS가 이 주문을 받아 저장한 시각. **상태가 아닙니다** — 주문이
   * 어느 단계인지가 아니라 전달이 됐는지입니다. 비어 있으면 POS가
   * 아직 못 받은 것입니다.
   */
  receivedBy: string | null
  receivedAt: string | null
  /** 매장 주문인가 배달인가. 조리가 끝난 뒤 어디로 갈지를 정합니다. */
  type: 'IN_STORE' | 'DELIVERY' | null
  placedAt: string
  updatedAt: string
}

/** 화면에 붙일 자리 이름. 번호뿐이면 "번"을 붙입니다 — "3 자리"는 어색합니다. */
export function tableLabel(order: { floor: number | null; tableNo: string | null }): string | null {
  if (order.tableNo === null) return null
  const name = /^\d+$/.test(order.tableNo) ? order.tableNo + '번' : order.tableNo
  return order.floor !== null && order.floor > 1 ? order.floor + '층 ' + name : name
}

/** Whether this store has 개점'd, and which 판매일자 it is on. */
export interface BusinessDayStatus {
  storeId: string
  open: boolean
  businessDate?: string
  openedBy?: string
  needsClosing: boolean
}

export async function fetchBusinessDayStatus(storeId: string): Promise<BusinessDayStatus> {
  const res = await fetch(`${BASE}/business-days/status?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as BusinessDayStatus
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PLACED: '접수됨',
  ACCEPTED: '수락됨',
  REJECTED: '거절됨',
  EXPIRED: '시간 초과',
  COOKING: '조리 중',
  PRODUCED: '조리완료',
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
  if (res.status === 403) return new Error('수령번호가 맞지 않습니다')
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
 * because another terminal got there first, or the order moved on already.
 */
export async function changeStatus(
  orderId: number,
  status: OrderStatus,
  deviceId?: string
): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), status })
  if (deviceId) params.set('deviceId', deviceId)

  const res = await fetch(`${BASE}/orders/status?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
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

/**
 * 수령 확인 — 손님이 번호를 내밀고 가져가는 순간.
 *
 * 일반 상태 전이와 따로인 이유: 번호 검사와 전이가 한 덩어리여야
 * 빠뜨릴 수가 없습니다. 답이 셋으로 갈립니다.
 *
 *   403  번호가 맞지 않습니다   — 당신 것이 아닙니다
 *   409  아직 / 이미            — 조리 중이거나 이미 가져갔습니다
 *   200  넘어갔습니다 (COMPLETED)
 *
 * 앞의 둘은 직원이 손님에게 할 말이 다르므로 메시지도 서버가 주는
 * 것을 그대로 씁니다.
 */
export async function handOver(orderId: number, pin: string, deviceId: string): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  if (pin) params.set('pin', pin)

  const res = await fetch(`${BASE}/orders/pickup?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
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
