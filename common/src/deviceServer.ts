/**
 * 단말 화면이 Device Server 를 통해 보는 플랫폼 — POS · KDS · DID 가 함께 쓰는 부분.
 *
 * <p>단말은 Order 가 어디 있는지 모릅니다. Device Server 에 묻고, 서버가 대신 부릅니다. 매장에 걸린
 * 화면에 설정할 주소가 하나뿐이고, Order 가 옮겨도 단말을 건드리지 않아도 됩니다.
 *
 * <p>여기에는 <b>세 화면에 모두 있는 것</b>만 둡니다(umbrella docs/design/terminal-monorepo.md §3).
 * 한 화면만 쓰는 것은 그 화면의 `posApi.ts`·`kdsApi.ts` 에 있습니다.
 */

import { shellServerUrl } from './shell'

// 기본값이 공개 주소인 이유: 이 화면은 :8000 의 공개 링크로 열립니다. LAN 기본값은 LAN 안에서만
// 되는 빌드를 조용히 만들었습니다 — 밖에서는 화면은 뜨는데 Device Server 에 못 닿았습니다.
// 셸(Electron) 안이면 셸에 설정된 서버 주소가 먼저입니다 (store-app.md §5.2). DID 는 셸에서 돌지
// 않아서 늘 뒤의 두 값입니다.
export const BASE = shellServerUrl() ?? import.meta.env.VITE_DEVICE_SERVER ?? 'http://61.73.134.2:8087'

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
   * 이 줄을 만드는 주방. 주문이 아니라 **줄**에 붙습니다 — 한 주문이 두 주방에 걸칠 수 있습니다.
   * null 은 "아무 주방이나"이고, 주방이 하나인 매장이 그렇습니다.
   */
  kdsDeviceId: string | null
  /**
   * 이 줄이 만들어진 시각. null 이면 아직입니다. 주문이 PRODUCED 로 가는 것은 **모든 줄이
   * 끝났을 때**입니다 — 먼저 끝낸 주방이 주문 전체를 끝내면 손님이 반만 받아 갑니다.
   */
  producedAt: string | null
  /** 이 줄의 조리를 시작한 시각 (store-app.md §4.1). 옛 주문에는 없습니다. */
  startedAt?: string | null
}

/**
 * 주문 하나. 서버는 세 화면에 같은 JSON 을 보내고, 화면마다 읽는 필드가 다를 뿐입니다.
 */
export interface Order {
  id: number
  storeId: string
  customerId: string
  /** 한 줄 요약("짜장면 외 1건") — 진짜는 `lines` 입니다. */
  menuName: string
  amount: number
  status: OrderStatus
  acceptedBy: string | null
  /** 주문 전체를 한 주방에 보낼 때의 그 주방. 줄마다 다르면 `lines[].kdsDeviceId`. */
  kdsDeviceId: string | null
  /**
   * 판매일자 — 주문이 들어왔을 때 열려 있던 영업일자. `placedAt` 의 달력 날짜가 아닙니다:
   * 자정을 넘겨 장사한 주문도 그날 영업일에 속합니다. 영업일이 생기기 전의 주문만 null.
   */
  businessDate: string | null
  /**
   * 도착지 — "이 메뉴를 저 자리로". 테이블 QR로 들어온 주문에만 있고, 그 밖에는 null 입니다.
   * null 이 "모른다"가 아니라 "테이블이 아니다"라는 뜻입니다.
   */
  floor: number | null
  tableNo: string | null
  /**
   * 수령번호 — `pickupNo` 는 **부르는 번호**(DID 에 크게 뜸: "7-12", 2층이면 "2-7-12", 테이블이
   * 아니면 "P-12"), `pickupPin` 은 **증명하는 번호**(4자리, 크게 띄우지 않음).
   * 2026-09-17 이전 주문에는 없습니다 — 그때 화면은 수령번호 칸을 아예 그리지 않습니다.
   */
  pickupNo: string | null
  pickupPin: string | null
  /**
   * 거래번호 — 매출 키의 마지막 자리(판매일자 + 점포 + POS번호 + 거래번호). **POS 가 채번**하고
   * 수락할 때 붙습니다. 그 전에는 아직 거래가 아니라 null 입니다.
   */
  tranNo: string | null
  /** 이 주문이 들어온 테이블 QR의 코드. 키의 일부가 아니라 영수증에 함께 찍히는 값입니다. */
  qrCode: string | null
  /**
   * 영수증 QR 이 나르는 값 (umbrella docs/adr/0007) — 손님이 찍으면 로그인 없이 자기 주문을 봅니다.
   * 테이블 스티커의 `qrCode` 와 다른 것이고, 주문이 생길 때 정해져 끝까지 안 바뀝니다.
   * 2026-09-24 이전 주문에는 없습니다.
   */
  claimToken: string | null
  /** 채널이 승인한 결제 (store-app.md §6.2). 앱·QR 주문에만 있습니다 — 지어 넣지 않습니다. */
  payment?: { method: string; approvalNo: string | null; amount: number } | null
  /**
   * POS가 이 주문을 받아 저장한 시각. **상태가 아닙니다** — 주문이 어느 단계인지가 아니라
   * 전달이 됐는지입니다. 비어 있으면 POS가 아직 못 받은 것입니다.
   */
  receivedBy: string | null
  receivedAt: string | null
  /**
   * 이 번호를 마지막으로 부른 시각. 조리가 끝나는 순간 처음 채워지고 "다시 부르기"로 밀립니다.
   * DID 가 **흐르는 화면**인 근거입니다. 2026-09-17 이전 주문에는 없습니다.
   */
  calledAt: string | null
  /** KDS-MAIN 이 남은 줄을 강제로 끝냈으면 그 기기 (§4.1). */
  forceProducedBy?: string | null
  /** MAIN 이 끊긴 동안 생산 KDS 가 내준 수령인가 (§4.2). */
  pickupEmergency?: boolean
  /** 매장 주문인가 배달인가. 조리가 끝난 뒤 어디로 갈지를 정합니다. */
  type: 'IN_STORE' | 'DELIVERY' | null
  placedAt: string
  updatedAt: string
  /**
   * 주문의 줄들 (§4.4.2). **여기가 진짜입니다.** 2026-09-18 이전 주문은 비어 있고, 그때는
   * 화면이 `menuName` 으로 되돌아갑니다.
   */
  lines: OrderLine[]
}

/**
 * 상태 이름 기본값. 표시는 화면의 일이라 다르게 부르고 싶은 화면은 덮어씁니다
 * (POS 는 PRODUCED 를 "생산 완료" 로).
 */
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

/**
 * 실패한 응답을 사람이 읽을 문장으로. 서버가 준 `error` 가 먼저이고, 없으면 상태 코드로.
 * 화면마다 같은 코드에 다른 말을 하고 싶으면 `overrides` 로 (KDS 수령의 403 = "수령번호가 맞지 않습니다").
 */
export async function failure(res: Response, overrides: Record<number, string> = {}): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) return new Error(body.error)
  } catch {
    // not JSON
  }
  const special = overrides[res.status]
  if (special) return new Error(special)
  if (res.status === 409) return new Error('이미 처리된 주문입니다')
  if (res.status === 502) return new Error('주문 서비스에 연결할 수 없습니다')
  return new Error(`요청이 실패했습니다 (HTTP ${res.status})`)
}

/** "가져오기" 쪽 — WebSocket 은 바뀌었다고만 말하고, 무엇이 참인지는 여기서 묻습니다. */
export async function fetchOrders(status?: OrderStatus): Promise<Order[]> {
  const res = await fetch(`${BASE}/orders${status ? `?status=${status}` : ''}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order[]
}

/**
 * 주문을 다음 상태로. Device Server 가 Order 의 답을 그대로 넘기므로 409 는 상태 기계가 거절한
 * 것입니다 — 보통 다른 단말이 먼저 했거나 주문이 이미 넘어갔습니다.
 *
 * `tranNo` 는 POS 가 수락할 때만 싣습니다. 뒤의 전이에서 보내도 서버가 무시합니다 — 매출의 키가
 * 조리·배달 과정에서 움직이면 그건 더 이상 키가 아닙니다.
 */
export async function changeStatus(
  orderId: number,
  status: OrderStatus,
  deviceId?: string,
  tranNo?: string
): Promise<Order> {
  const params = new URLSearchParams({ id: String(orderId), status })
  if (deviceId) params.set('deviceId', deviceId)
  if (tranNo) params.set('tranNo', tranNo)

  const res = await fetch(`${BASE}/orders/status?${params}`, { method: 'POST' })
  if (!res.ok) throw await failure(res)
  return (await res.json()) as Order
}

/** 그 매장이 개점했는가, 어느 판매일자인가, 영업일자가 오래돼 마감이 필요한가. */
export interface BusinessDayStatus {
  storeId: string
  open: boolean
  businessDate?: string
  openedBy?: string
  needsClosing: boolean
}

/** 매장마다 묻습니다 — DID 는 여러 매장을 함께 볼 수 있고, 매장마다 영업일자가 따로입니다. */
export async function fetchBusinessDayStatus(storeId: string): Promise<BusinessDayStatus> {
  const res = await fetch(`${BASE}/business-days/status?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as BusinessDayStatus
}

/**
 * 소켓으로 오는 프레임. 주문 이벤트는 `orderId` 를 들고 오고, 그 밖은 `type` 으로 갈립니다:
 * `MENU_*`(결품), `NOTICE`(긴급 공지 — POS), `PRINT`(라벨 — KDS 메인), `WELCOME`(연결 인사).
 *
 * 주문·결품은 **바뀌었다는 신호일 뿐**이고 화면이 믿는 값이 아닙니다 — 무엇이 참인지는 다시 묻습니다.
 * 긴급 공지만 내용을 싣고 옵니다: 사람이 지금 읽어야 하는 글이라 한 번 더 왕복할 시간이 아깝습니다.
 */
export interface TerminalEvent {
  orderId?: number
  status?: string
  storeId?: string
  type?: string
  menuCode?: string
  businessDate?: string
  /** NOTICE 프레임 (POS). */
  noticeId?: number
  title?: string
  body?: string
  urgent?: boolean
  /** WELCOME 프레임: BO 장비에 정해진 이 KDS 의 역할 (MAIN | SUB). */
  kdsRole?: string
  /** PRINT 프레임: 찍을 라벨 작업들 (store-app.md §7.2). */
  jobIds?: number[]
}

/** 이 프레임이 기준 정보(결품) 알림인가. 아니면 주문 쪽입니다. */
export function isMenuEvent(event?: TerminalEvent): boolean {
  return typeof event?.type === 'string' && event.type.startsWith('MENU_')
}

/**
 * 단말의 로컬 마스터 한 줄 — 오늘 이 매장이 파는 것과, 떨어진 것.
 *
 * `soldOut` 은 "오늘 없다"이지 메뉴를 내린 것이 아닙니다(내린 메뉴는 목록에 없습니다).
 * `estimatedMinutes` 는 기준 조리시간 × (대기열 + 1)이고, 모르면 null — 0 으로 읽으면 안 됩니다.
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

/** 오늘의 메뉴판. Device Server 가 APP-SERVER 에 물어봐 줍니다 — 단말은 주소를 하나만 압니다. */
export async function fetchMenuBoard(storeId: string): Promise<MenuBoard> {
  const res = await fetch(`${BASE}/menus?storeId=${encodeURIComponent(storeId)}`)
  if (!res.ok) throw await failure(res)
  return (await res.json()) as MenuBoard
}

/** 단말의 WebSocket 주소. KDS 메인은 `role` 을 싣습니다 — 서버는 BO 의 역할을 먼저 봅니다. */
export function socketUrl(deviceId: string, storeId: string, type: 'POS' | 'KDS' | 'DID', role?: 'MAIN'): string {
  const ws = BASE.replace(/^http/, 'ws')
  return `${ws}/ws?deviceId=${encodeURIComponent(deviceId)}`
    + `&storeId=${encodeURIComponent(storeId)}&type=${type}`
    + (role ? `&role=${role}` : '')
}
