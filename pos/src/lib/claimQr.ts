/**
 * 영수증에 찍는 주문 QR (umbrella docs/adr/0007).
 *
 * <p>손님이 이걸 찍으면 자기 주문 상태가 열립니다. 로그인도 회원번호도
 * 없는 길이고, 그래서 <b>종이가 곧 교환권</b>입니다.
 *
 * <p>QR은 <b>단말에서 그립니다</b>. 서버가 이미지로 만들어 내려주면
 * 인쇄할 때마다 왕복이 생기고, 네트워크가 끊긴 매장에서는 QR 없는
 * 영수증이 나갑니다. 값은 이미 주문에 실려 왔으므로 그릴 재료가
 * 여기 다 있습니다.
 */

import QRCode from 'qrcode'

/**
 * QR이 가리키는 주소.
 *
 * <p><b>손님 휴대폰이 LTE로 열 수 있어야 합니다.</b> 인쇄된 스티커는
 * 회수할 수가 없어서, 여기에 내부 주소가 들어가면 그 영수증들은 영영
 * 안 열립니다. 이 플랫폼은 이미 POS 카드에 내부 IP를 넣어 한 번
 * 겪었습니다 — 그건 고칠 수 있었고, 종이는 못 고칩니다.
 *
 * <p>빌드 때 정합니다(`VITE_CLAIM_BASE`). 단말은 정적 파일이라 실행
 * 중에 물어볼 곳이 없습니다.
 */
const CLAIM_BASE = import.meta.env.VITE_CLAIM_BASE
  ?? 'http://sunmoonwork.duckdns.org:8085/channel-order/o'

export function claimUrl(token: string): string {
  return `${CLAIM_BASE}/${encodeURIComponent(token)}`
}

/**
 * QR을 data URL로 그립니다.
 *
 * <p>오류정정 수준을 <b>M</b>으로 둡니다. 영수증 용지는 번지고 접히고
 * 주머니에서 구겨집니다 — L은 그걸 못 견디고, H는 같은 크기에서 칸이
 * 촘촘해져 저해상도 영수증 프린터에서 오히려 안 읽힙니다.
 *
 * <p>여백(margin)을 1로 줄입니다. 기본값 4는 종이에서 너무 큽니다.
 * 0으로 두면 안 됩니다 — QR은 주변 여백이 있어야 인식됩니다.
 */
export async function drawClaimQr(token: string): Promise<string> {
  return QRCode.toDataURL(claimUrl(token), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 160
  })
}
