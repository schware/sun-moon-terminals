/**
 * 이 기기의 페어링 (umbrella docs/design/store-app.md §3).
 *
 * <p>BO 장비 화면에서 받은 6자리 코드를 한 번 넣으면, 서버가 이 기기의
 * 매장·번호·종류·역할과 토큰을 돌려줍니다. 그 뒤로는 <b>토큰이 신원</b>이고,
 * 화면이 매장·번호를 고르지 않습니다.
 *
 * <p><b>브라우저에서는 페어링을 쓰지 않습니다</b> (2026-09-29, Sun&Moon 결정 — 단말 첫
 * 화면은 매장·장비 입력이고, 페어링은 다시 설계합니다). 신원은 셸 안에서만 셸이 줍니다.
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

/**
 * Electron 셸(sun-moon-store-app) 안이면 셸이 신원을 줍니다 (store-app.md §5.2).
 * 셸은 페어링을 자기 화면에서 하고 토큰을 암호화해 둡니다 — 화면은 받아 쓰기만 합니다.
 * 셸 밖(브라우저)이면 undefined 이고, 이 기기는 페어링된 기기가 아닙니다.
 */
interface ShellIdentity extends PairedDevice {
  token: string
  serverUrl: string
}

interface ShellBridge {
  identity: { get: () => ShellIdentity | null; forget: () => Promise<boolean> }
}

function shell(): ShellBridge | undefined {
  return (window as unknown as { sunmoon?: ShellBridge }).sunmoon
}

/** 셸 안에서 돌고 있나. 셸 밖에서는 KDS-MAIN 이 될 수 없습니다(§3.6). */
export function inShell(): boolean {
  return shell() !== undefined
}

/** 셸이 알려준 서버 주소. 셸 밖이면 null — 빌드 때 정한 주소를 씁니다. */
export function shellServerUrl(): string | null {
  return shell()?.identity.get()?.serverUrl ?? null
}

/**
 * 09-29 전에 브라우저로 페어링해 둔 기록(토큰·기기)은 읽지 않고 지웁니다. 남겨 두면
 * 같은 주소(:8000)의 POS·KDS·DID 가 모두 그 기기로 매장·장비 입력을 건너뜁니다.
 */
function dropBrowserPairing(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(DEVICE_KEY)
  } catch {
    // 지울 수 없는 저장소면 남아 있을 것도 없습니다.
  }
}

export function deviceToken(): string | null {
  return shell()?.identity.get()?.token ?? null
}

export function pairedDevice(): PairedDevice | null {
  const fromShell = shell()?.identity.get()
  if (!fromShell) {
    dropBrowserPairing()
    return null
  }
  const { storeId, deviceId, deviceType, kdsRole } = fromShell
  return { storeId, deviceId, deviceType, kdsRole }
}

export function forgetPairing(): void {
  const bridge = shell()
  if (bridge) {
    // 셸이 설정을 지우고 셋업 화면으로 갑니다.
    void bridge.identity.forget()
    return
  }
  dropBrowserPairing()
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
