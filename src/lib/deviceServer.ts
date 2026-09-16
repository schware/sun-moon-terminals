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
  amount: number
  status: OrderStatus
  acceptedBy: string | null
  /**
   * 도착지 — "이 메뉴를 저 자리로". 테이블 QR로 들어온 주문에만 있고,
   * 매장 선택 화면이나 (앞으로의) 포장·배달 주문은 null입니다.
   * null이 "모른다"가 아니라 "테이블이 아니다"라는 뜻입니다.
   */
  floor: number | null
  tableNo: string | null
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
  deviceId?: string
): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), status })
  if (deviceId) params.set('deviceId', deviceId)

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
