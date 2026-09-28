/**
 * 이 기기의 페어링 (umbrella docs/design/store-app.md §3).
 *
 * <p>BO 장비 화면에서 받은 6자리 코드를 한 번 넣으면, 서버가 이 기기의
 * 매장·번호·종류·역할과 토큰을 돌려줍니다. 그 뒤로는 <b>토큰이 신원</b>이고,
 * 화면이 매장·번호를 고르지 않습니다.
 *
 * <p>{@code localStorage} 인 이유: 탭이 아니라 <b>기기</b>에 묶이는 값입니다.
 * 창을 닫았다 열어도, 재부팅해도 같은 기기입니다.
 *
 * <p>같은 파일이 POS·KDS·DID 세 저장소에 있습니다 — 단말 코드 공통화
 * (§10, 8단계) 전까지는 복사본입니다. 고치면 셋 다 고치십시오.
 */

export interface PairedDevice {
  storeId: string
  deviceId: string
  deviceType: 'POS' | 'KDS' | 'DID'
  kdsRole: 'MAIN' | 'SUB' | null
}

const TOKEN_KEY = 'sunmoon.deviceToken'
const DEVICE_KEY = 'sunmoon.device'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function deviceToken(): string | null {
  return read(TOKEN_KEY)
}

export function pairedDevice(): PairedDevice | null {
  const raw = read(DEVICE_KEY)
  if (!raw || !deviceToken()) return null
  try {
    return JSON.parse(raw) as PairedDevice
  } catch {
    return null
  }
}

export function remember(device: PairedDevice, token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(DEVICE_KEY, JSON.stringify(device))
}

export function forgetPairing(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(DEVICE_KEY)
  } catch {
    // 지울 수 없는 저장소면 기억할 수도 없었습니다.
  }
}

/** 페어링된 기기면 요청에 {@code Authorization: Device <token>} 을 붙입니다. */
export function withDeviceAuth(init?: RequestInit): RequestInit {
  const token = deviceToken()
  if (!token) return init ?? {}
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Device ${token}`)
  return { ...init, headers }
}

/**
 * 코드를 토큰으로 바꿉니다. 실패하면 서버의 문장을 그대로 던집니다 —
 * "코드가 맞지 않거나 이미 쓰였거나 10분이 지났습니다" 가 매장에서 읽을 말입니다.
 */
export async function pairWithCode(base: string, code: string): Promise<{ device: PairedDevice; token: string }> {
  const res = await fetch(`${base}/pos/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.replace(/\s/g, '') })
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `페어링 실패 (${res.status})`)
  }
  const device: PairedDevice = {
    storeId: String(body.storeId),
    deviceId: String(body.deviceId),
    deviceType: body.deviceType as PairedDevice['deviceType'],
    kdsRole: (body.kdsRole as PairedDevice['kdsRole']) ?? null
  }
  return { device, token: String(body.token) }
}
