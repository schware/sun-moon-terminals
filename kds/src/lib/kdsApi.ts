/**
 * KDS 가 Device Server 에 하는 일 — 공통(@sunmoon/terminal-common)에 주방만의 것을 더한 것.
 * 화면 코드는 이 파일 하나에서 가져갑니다 (umbrella docs/design/terminal-monorepo.md §3-3).
 */
import { BASE, failure, type Order, type OrderLine, type TerminalEvent } from '@sunmoon/terminal-common/device-server'

export * from '@sunmoon/terminal-common/device-server'
export * from '@sunmoon/terminal-common/format'

/** 수령의 403 은 "번호가 맞지 않는다" 입니다 (서버가 문장을 안 줬을 때). */
const PICKUP_FAILURES = { 403: '수령번호가 맞지 않습니다' }

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
  if (!res.ok) throw await failure(res, PICKUP_FAILURES)
  return (await res.json()) as Order
}
