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
export const BASE = import.meta.env.VITE_DEVICE_SERVER ?? 'http://sunmoonwork.duckdns.org:8087'

export type OrderStatus =
  | 'PLACED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'COOKING'
  | 'PRODUCED'
  | 'DELIVERING'
  | 'COMPLETED'

/** 주문 한 줄 — 메뉴 하나와 수량. */
export interface OrderLine {
  seq: number
  menuCode: string | null
  menuName: string
  quantity: number
  unitPrice: number
  lineAmount: number
  /**
   * 이 줄을 만드는 주방, 그리고 만들어진 시각.
   *
   * DID는 둘 다 안 씁니다 — 손님에게는 어느 주방이 만들었는지가 아무
   * 뜻이 없고, 화면에 뜨는 것은 **다 된 주문**뿐이라 줄마다의 시각도
   * 볼 이유가 없습니다. 서버가 주는 값이라 타입에만 적어 둡니다.
   */
  kdsDeviceId: string | null
  producedAt: string | null
}

export interface Order {
  id: number
  storeId: string
  customerId: string
  menuName: string
  amount: number
  status: OrderStatus
  acceptedBy: string | null
  /**
   * 판매일자 — the 영업일자 that was open when the order arrived, not the
   * calendar date of `placedAt`: a shop trading past midnight is still on
   * the same business day. Null only for orders placed before 영업일
   * existed at all.
   */
  businessDate: string | null
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
  /**
   * 주문의 줄들 (§4.4.2).
   *
   * **여기가 진짜입니다** — `menuName` 은 이 목록에서 뽑은 한 줄 요약
   * ("짜장면 외 1건")이고, 금액은 줄들의 합입니다.
   *
   * 2026-09-18 이전 주문은 비어 있습니다. 그때는 주문 하나가 메뉴
   * 하나였고 그 이름이 `menuName` 에 그대로 있어서, 화면은 줄이 비면
   * 그 값으로 되돌아갑니다.
   */
  lines: OrderLine[]

  /**
   * 이 번호를 마지막으로 부른 시각.
   *
   * 조리가 끝나는 순간 처음 채워지고, KDS에서 "다시 부르기"를 누르면
   * 그때로 밀립니다. DID가 **흐르는 화면**인 근거가 이 값입니다 —
   * 화면이 스스로 무엇을 보여줬는지 기억하는 대신, 언제 불렸는지를
   * 서버에 물어보면 새로고침해도 두 대를 걸어도 같은 것이 뜹니다.
   *
   * 2026-09-17 이전 주문에는 없습니다(null). 그 경우 안 뜹니다 —
   * 어제 주문이 오늘 화면에 다시 나타나는 것이 더 나쁩니다.
   */
  calledAt: string | null
}

/** Whether a store has 개점'd, and which 판매일자 it is on. */
export interface BusinessDayStatus {
  storeId: string
  open: boolean
  businessDate?: string
  openedBy?: string
  needsClosing: boolean
}

/**
 * Asked per store, because this board can watch several at once and each
 * one keeps its own 영업일자 — a food court does not close as a unit.
 */
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

export function socketUrl(deviceId: string, storeId: string, type: 'POS' | 'KDS' | 'DID'): string {
  const ws = BASE.replace(/^http/, 'ws')
  return `${ws}/ws?deviceId=${encodeURIComponent(deviceId)}`
    + `&storeId=${encodeURIComponent(storeId)}&type=${type}`
}

export { formatAmount } from '@sunmoon/terminal-common/format'

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ko-KR', { timeStyle: 'medium' })
}
