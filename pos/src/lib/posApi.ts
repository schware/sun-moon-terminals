/**
 * POS 가 Device Server 에 하는 일 — 공통(@sunmoon/terminal-common)에 POS 만의 것을 더한 것.
 * 화면 코드는 이 파일 하나에서 가져갑니다 (umbrella docs/design/terminal-monorepo.md §3-3).
 */
import {
  BASE, failure, fetchOrders, STATUS_LABEL as COMMON_STATUS_LABEL,
  type Order, type OrderStatus, type TerminalEvent
} from '@sunmoon/terminal-common/device-server'

export * from '@sunmoon/terminal-common/device-server'
export * from '@sunmoon/terminal-common/format'

/** POS 는 PRODUCED 를 "생산 완료" 라고 부릅니다. */
export const STATUS_LABEL: Record<OrderStatus, string> = { ...COMMON_STATUS_LABEL, PRODUCED: '생산 완료' }

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

/** 이 프레임이 긴급 메시지인가. */
export function isNoticeEvent(event?: TerminalEvent): boolean {
  return event?.type === 'NOTICE'
}

/**
 * 단말에 걸린 공지 (업무 정의서 §3.5).
 *
 * 일반 공지는 물어봐서 가져오고, 긴급은 서버가 밀어 넣습니다. 그런데
 * **둘 다 여기로 옵니다** — 밀기만 하면 그때 꺼져 있던 단말은 영영
 * 모르기 때문에, 긴급도 조회로 다시 읽힙니다.
 */
export interface Notice {
  id: number
  /** 'ALL_STORES' 또는 매장 코드. */
  scope: string
  deviceType: string | null
  title: string
  body: string
  urgent: boolean
  startsAt: string
  endsAt: string | null
  createdBy: string | null
  /**
   * **이 단말이** 이미 확인했는가.
   *
   * 서버가 판단합니다(`pos_notice_receipt`). 화면이 기억하면 새로고침
   * 할 때마다 같은 긴급 메시지가 다시 화면을 가로막습니다 — 2026-09-18에
   * 실제로 그랬습니다.
   */
  acknowledged: boolean
}

/**
 * 지금 이 단말에 걸려 있는 공지. 긴급이 먼저 옵니다.
 *
 * **장비 번호를 함께 보냅니다.** 이게 없으면 서버가 "이 단말이 봤는지"를
 * 알 수 없어서, 확인을 눌러도 다음 조회에 같은 긴급이 또 옵니다.
 */
export async function fetchNotices(
  storeId: string, deviceType: string, deviceNo: string
): Promise<Notice[]> {
  const q = new URLSearchParams({ storeId, deviceType, deviceNo })
  const res = await fetch(`${BASE}/pos/notices?${q}`)
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { notices: Notice[] }).notices
}

/**
 * 이 단말이 그 공지를 봤다고 알립니다.
 *
 * 긴급에만 뜻이 있습니다 — 안 본 단말이 있으면 전화를 걸어야 하고,
 * 그 목록이 없으면 전부에게 걸게 됩니다. 실패해도 조용히 넘어갑니다:
 * 확인 기록을 못 남긴 것이 사람이 글을 읽은 것을 되돌리지는 않습니다.
 */
export async function acknowledgeNotice(
  noticeId: number, storeId: string, deviceType: string, deviceNo: string
): Promise<void> {
  try {
    await fetch(`${BASE}/pos/notices/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noticeId, storeId, deviceType, deviceNo })
    })
  } catch {
    // 위 주석대로 — 삼킵니다.
  }
}

/**
 * POS가 이 주문을 받아 화면에 올렸다고 알립니다 (업무 정의서 §5.3).
 *
 * **상태를 바꾸지 않습니다** — 주문은 여전히 수락을 기다립니다.
 * 이 기록이 있어야 "POS가 아예 못 받았다"와 "받고도 매장이 답을
 * 안 했다"가 갈립니다. 실패해도 삼킵니다: 이건 진단을 돕는 값이고,
 * 이것 때문에 주문 받는 화면이 멈추면 안 됩니다.
 */
export async function reportReceived(orderId: number, deviceId: string): Promise<void> {
  const params = new URLSearchParams({ id: String(orderId), deviceId })
  try {
    await fetch(`${BASE}/orders/received?${params}`, { method: 'POST' })
  } catch {
    // 기록이 빠지면 나중에 "POS가 못 받았다"로 보일 뿐, 주문 처리에는
    // 영향이 없습니다.
  }
}

/** 서버가 받아 준 결과. 이미 받은 것은 <b>실패가 아닙니다</b>. */
export interface SaleUploadResult {
  received: number
  duplicates: number
}

/**
 * 밀린 거래를 한 번에 올립니다 (업무 정의서 §3.1, umbrella docs/adr/0010).
 *
 * <p>배열로 보냅니다 — 로컬 원장이 쌓아 둔 것을 건마다 왕복하면
 * 느리고, 서버가 애초에 배열을 받도록 만들어져 있습니다.
 *
 * <p>이미 받은 거래를 다시 보내도 서버는 `duplicates` 로 셀 뿐
 * 오류를 내지 않습니다. 그래서 <b>재시도가 안전합니다</b> — 올렸는지
 * 확신이 없으면 그냥 다시 보내면 됩니다.
 */
export async function uploadSales(payloads: unknown[]): Promise<SaleUploadResult> {
  const res = await fetch(`${BASE}/sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloads)
  })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as SaleUploadResult
}

/**
 * 주문 하나를 번호로 찾습니다.
 *
 * <p>시작할 때 <b>번호만 끊고 끊긴</b> 거래를 정리하는 데 씁니다
 * (`ledger.reconcile`). 서버에 그 주문이 이 번호로 수락돼 있는지가
 * 유일한 답입니다.
 *
 * <p>목록을 받아서 고릅니다 — {@code GET /orders} 에 단건 조회가
 * 없습니다. 시작할 때 한 번이고 화면이 어차피 같은 목록을 읽으므로
 * 그것 때문에 서버에 주소를 하나 더 낼 이유는 없습니다.
 */
export async function findOrder(orderId: number): Promise<Order | null> {
  const all = await fetchOrders()
  return all.find((o) => o.id === orderId) ?? null
}
