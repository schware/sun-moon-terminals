/**
 * 화면에 숫자·시각을 보이는 모양 — 세 단말 화면이 같은 모양을 씁니다.
 */

export function formatAmount(amount: number): string {
  return new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW' }).format(amount)
}
