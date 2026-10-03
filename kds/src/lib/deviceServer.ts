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
import { shellServerUrl } from './shell'

// 셸(Electron) 안이면 셸에 설정된 서버 주소가 먼저입니다 (store-app.md §5.2).
export const BASE = shellServerUrl() ?? import.meta.env.VITE_DEVICE_SERVER ?? 'http://sunmoonwork.duckdns.org:8087'


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
   * 이 줄을 만드는 주방.
   *
   * 주문이 아니라 **줄**에 붙습니다. 한 주문이 두 주방에 걸칠 수
   * 있습니다 — 중식과 일식을 같이 파는 매장에서 짜장면과 초밥을 함께
   * 시킨 경우. null 은 "아무 주방이나"이고, 주방이 하나인 매장이 그렇습니다.
   */
  kdsDeviceId: string | null
  /**
   * 이 줄이 만들어진 시각. null 이면 아직입니다.
   *
   * 주문이 PRODUCED 로 가는 것은 **모든 줄이 끝났을 때**입니다 —
   * 먼저 끝낸 주방이 주문 전체를 끝내면 DID가 번호를 부르고, 손님은
   * 반만 만들어진 주문을 받으러 옵니다.
   */
  producedAt: string | null
  /** 이 줄의 조리를 시작한 시각 (store-app.md §4.1). 옛 주문에는 없습니다. */
  startedAt?: string | null
}

/**
 * 이 KDS가 하는 일.
 *
 * 매장에서 나온 정리(2026-09-18): 생산하는 KDS와 그 흐름을 관리하는
 * KDS를 가릅니다.
 *
 * - `PRODUCTION` — kds-01, kds-02… **자기 줄만** 보고 만듭니다.
 * - `MAIN` — 전체 흐름을 봅니다. 어느 주방이 붙잡고 있는지, 다 된
 *   주문을 누가 내주는지가 여기 일입니다. 두 주방이 걸린 주문을 손님에게
 *   건네는 것도 메인입니다 — 생산 주방은 자기 것밖에 모릅니다.
 */
export type KdsRole = 'PRODUCTION' | 'MAIN'

/** 이 줄이 그 주방 것인가. 주방이 안 달린 줄은 아무나 만듭니다. */
export function lineBelongsTo(line: OrderLine, deviceId: string): boolean {
  return line.kdsDeviceId === null || line.kdsDeviceId === deviceId
}

export interface Order {
  id: number
  storeId: string
  /** KDS-MAIN 이 남은 줄을 강제로 끝냈으면 그 기기 (§4.1). */
  forceProducedBy?: string | null
  /** MAIN 이 끊긴 동안 SUB 가 내준 수령인가 (§4.2). */
  pickupEmergency?: boolean
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

/** 그 주방의 줄만 조리 시작 (store-app.md §4.1). 주문은 한 줄이라도 시작되면 조리 중. */
export async function startLines(orderId: number, deviceId: string): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  const res = await fetch(`${BASE}/orders/start?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

/** KDS-MAIN 의 강제 전부 완료. 누가 눌렀는지 주문에 남습니다. 서버가 역할을 확인합니다. */
export async function forceProduced(orderId: number, deviceId: string): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  const res = await fetch(`${BASE}/orders/force-produced?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

export interface KdsMode {
  storeId: string
  /** 그 매장의 KDS-MAIN(BO 가 정한)이 3분 넘게 안 붙어 있음 — 생산 KDS 가 대신 수령할 수 있음. */
  emergency: boolean
  since: string | null
}

export async function fetchKdsMode(storeId: string): Promise<KdsMode> {
  const res = await fetch(`${BASE}/kds/mode?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as KdsMode
}

/** 라벨 작업 하나 (store-app.md §7). content 는 만든 순간 고정 — 재출력은 이걸 복사합니다. */
export interface PrintJob {
  id: number
  orderId: number
  lineSeq: number | null
  unitNo: number | null
  unitTotal: number | null
  copyNo: number
  originalId: number | null
  status: 'QUEUED' | 'PRINTED' | 'FAILED'
  error: string | null
  content: { menuName?: string | null; pickupNo?: string | null }
}

export async function fetchPrintJobs(storeId: string, orderId: number): Promise<PrintJob[]> {
  const res = await fetch(`${BASE}/pos/print-jobs?storeId=${encodeURIComponent(storeId)}&orderId=${orderId}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as PrintJob[]
}

/** 라벨 다시 — 서버가 새 작업을 만들고 이 KDS-MAIN 에 PRINT 로 알립니다. */
export async function reprintLabel(storeId: string, deviceId: string, jobId: number): Promise<PrintJob> {
  const params = new URLSearchParams({ storeId, deviceId, id: String(jobId) })
  const res = await fetch(`${BASE}/pos/print-jobs/reprint?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as PrintJob
}

/** 이 프레임이 라벨을 찍으라는 것인가. */
export function isPrintEvent(event?: TerminalEvent): boolean {
  return event?.type === 'PRINT'
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
  /** 'MENU_SOLD_OUT' | 'MENU_RESTORED' | 'PRINT' — 주문 이벤트에는 없습니다. */
  type?: string
  /** WELCOME 프레임: BO 장비에 정해진 이 KDS 의 역할 (MAIN | SUB). */
  kdsRole?: string
  /** PRINT 프레임: 찍을 라벨 작업들 (store-app.md §7.2). */
  jobIds?: number[]
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
/**
 * 번호를 다시 부릅니다 — DID에 한 번 더 띄우기 위해.
 *
 * DID는 상태를 보여주는 화면이 아니라 **흐르는 화면**입니다. 조리가
 * 끝난 번호가 잠깐 떴다가 지나갑니다. 그 뒤에 손님이 오면 다시 불러야
 * 하고, 그 버튼이 여기 KDS에 있습니다 — 화면은 DID지만 상황을 아는
 * 사람은 주방에 있습니다.
 *
 * 상태는 바뀌지 않습니다. 주문은 여전히 PRODUCED 입니다.
 */
export async function recall(orderId: number, deviceId: string): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  const res = await fetch(`${BASE}/orders/recall?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

export async function handOver(
  orderId: number, pin: string, deviceId: string, override = false
): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  if (pin) params.set('pin', pin)
  // 강제 진행. 번호를 못 대는 손님은 실제로 있고(화면을 껐고, 일행이
  // 대신 왔고, 종이를 잃어버렸고), 그때 내줄 방법이 없으면 매장이
  // 줄을 세운 채 막힙니다. 검사를 끄는 것이 아니라 건너뛴 사실이
  // 주문에 남습니다.
  if (override) params.set('override', 'true')

  const res = await fetch(`${BASE}/orders/pickup?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

export function socketUrl(deviceId: string, storeId: string, type: 'POS' | 'KDS' | 'DID', role?: 'MAIN'): string {
  const ws = BASE.replace(/^http/, 'ws')
  return `${ws}/ws?deviceId=${encodeURIComponent(deviceId)}`
    + `&storeId=${encodeURIComponent(storeId)}&type=${type}`
    + (role ? `&role=${role}` : '')
}

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount)
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ko-KR', { timeStyle: 'medium' })
}
