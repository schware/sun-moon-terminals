/**
 * Electron 셸(sun-moon-store-app) 안에서 돌 때 셸이 주는 이 기기의 매장·장비
 * (umbrella docs/design/store-app.md §5.2).
 *
 * <p>셸은 첫 실행 때 매장·장비를 입력받아 기억합니다 — 브라우저 화면의 단말 등록과
 * 같은 값입니다. 셸 밖(브라우저)이면 없고, 화면의 단말 등록을 씁니다.
 *
 * <p>단말 화면들이 함께 쓰는 공통 코드입니다(sun-moon-terminals/common).
 */

export interface ShellDevice {
  storeId: string
  deviceId: string
  deviceType: 'POS' | 'KDS' | 'DID' | 'KIOSK'
  kdsRole: 'MAIN' | 'SUB' | null
}

interface ShellIdentity extends ShellDevice {
  serverUrl: string
}

interface ShellBridge {
  identity: { get: () => ShellIdentity | null; forget: () => Promise<boolean> }
}

function shell(): ShellBridge | undefined {
  return (window as unknown as { sunmoon?: ShellBridge }).sunmoon
}

/** 셸이 알려준 서버 주소. 셸 밖이면 null — 빌드 때 정한 주소를 씁니다. */
export function shellServerUrl(): string | null {
  return shell()?.identity.get()?.serverUrl ?? null
}

/** 셸에 기억된 이 기기. 셸 밖이거나 아직 설정 전이면 null. */
export function shellDevice(): ShellDevice | null {
  const id = shell()?.identity.get()
  if (!id) return null
  const { storeId, deviceId, deviceType, kdsRole } = id
  return { storeId, deviceId, deviceType, kdsRole }
}

/** 셸의 매장·장비 설정을 지웁니다 — 셸이 설정 화면으로 돌아갑니다. */
export function forgetShellDevice(): void {
  void shell()?.identity.forget()
}
