/**
 * 화면에 숫자·시각·자리를 보이는 모양 — 단말 화면들이 같은 모양을 씁니다.
 */

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount)
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString('ko-KR', { timeStyle: 'medium' })
}

/** 화면에 붙일 자리 이름. 번호뿐이면 "번"을 붙입니다 — "3 자리"는 어색합니다. */
export function tableLabel(order: { floor: number | null; tableNo: string | null }): string | null {
  if (order.tableNo === null) return null
  const name = /^\d+$/.test(order.tableNo) ? order.tableNo + '번' : order.tableNo
  return order.floor !== null && order.floor > 1 ? order.floor + '층 ' + name : name
}
