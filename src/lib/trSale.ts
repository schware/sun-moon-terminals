/**
 * 수락한 주문을 <b>거래 전문</b>으로 만듭니다 (업무 정의서 §3.1~3.2).
 *
 * <p>POS-Server 는 받은 것을 바이트로 담고 나중에 풉니다. 그래서 이
 * 모양이 맞아야 분해가 됩니다 — 여기가 틀리면 원본은 남고
 * `tr_sale_log.status` 가 `FAILED` 로 쌓입니다.
 *
 * <p>주문과 거래는 다른 것입니다. 주문은 "손님이 무엇을 시켰나"이고
 * 거래는 "이 단말에서 무엇이 팔렸나"입니다. 그래서 여기서 키가
 * 바뀝니다 — 주문 번호가 아니라 <b>판매일자·점포·POS번호·거래번호</b>가
 * 이 전문의 이름입니다 (umbrella docs/adr/0009).
 */

import type { Order } from './deviceServer'

export interface TrSale {
  header: {
    storeId: string
    posNo: string
    businessDate: string
    tranNo: string
    tranType: 'SALE'
    totalAmount: number
    discountAmount: number
    taxAmount: number
    soldAt: string
  }
  details: Array<{
    detailSeq: number
    menuCode: string | null
    menuName: string
    quantity: number
    unitPrice: number
    detailAmount: number
  }>
  payments: Array<{
    paymentSeq: number
    paymentType: string
    paymentAmount: number
    approvalNo: string | null
  }>
  etc: Record<string, string | number | null>
}

/**
 * @param soldAt 판 시각. 재정리(reconcile) 때는 번호를 끊은 시각을
 *               넘깁니다 — 그때가 실제로 판 때이고, 지금이 아닙니다.
 */
export function buildTrSale(
  order: Order,
  storeId: string,
  posNo: string,
  businessDate: string,
  tranNo: string,
  soldAt: string = new Date().toISOString()
): TrSale {
  // 2026-09-18 이전 주문에는 줄이 없습니다. 그때는 주문 하나가 메뉴
  // 하나였고 이름과 금액이 주문에 그대로 있었습니다.
  const lines = order.lines && order.lines.length > 0
    ? order.lines.map((l, i) => ({
        detailSeq: l.seq || i + 1,
        menuCode: l.menuCode,
        menuName: l.menuName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        detailAmount: l.lineAmount
      }))
    : [{
        detailSeq: 1,
        menuCode: null,
        menuName: order.menuName,
        quantity: 1,
        unitPrice: order.amount,
        detailAmount: order.amount
      }]

  return {
    header: {
      storeId,
      posNo,
      businessDate,
      tranNo,
      tranType: 'SALE',
      totalAmount: order.amount,
      // 할인과 세액은 아직 이 플랫폼에 없습니다. 0은 "없다"이지
      // "모른다"가 아닙니다 — 합계에 영향이 없는 값이라 채워도
      // 거짓이 되지 않습니다.
      discountAmount: 0,
      taxAmount: 0,
      soldAt
    },
    details: lines,
    // **비워 둡니다.** 결제는 이 단말을 지나지 않습니다 — 손님 주문은
    // APP-SERVER 가 먼저 승인하고 OMS 로 넘어오므로, POS 가 아는 것은
    // "얼마짜리 주문이 수락됐다"까지입니다. 여기에 결제수단을 지어
    // 넣으면 POS 가 보지 못한 사실이 매출에 남습니다. 승인번호가
    // 거래까지 따라오게 하는 것은 따로 할 일입니다.
    payments: [],
    etc: {
      orderId: order.id,
      orderType: order.type,
      pickupNo: order.pickupNo,
      qrCode: order.qrCode,
      floor: order.floor,
      tableNo: order.tableNo,
      acceptedBy: order.acceptedBy
    }
  }
}
