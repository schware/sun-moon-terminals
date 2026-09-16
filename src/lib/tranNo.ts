/**
 * 거래번호 채번 — <b>이 단말에서</b> 합니다.
 *
 * <p>왜 서버가 아닌가: 오프라인 때문입니다 (umbrella docs/adr/0009).
 * 네트워크가 끊긴 매장의 POS도 계속 팔아야 하고, 그때 번호를 서버에
 * 물어볼 수 없습니다. 그래서 번호는 단말에서 나고 서버는 받아 적습니다.
 *
 * <p><b>여기 쓰인 localStorage는 임시 거처입니다.</b> 진짜 자리는 POS에
 * 붙을 로컬 DB(SQLite)이고, 거기서는 거래 원장과 같은 트랜잭션 안에서
 * 번호가 납니다 — 번호만 오르고 거래가 안 남는 창이 없어집니다.
 * localStorage 에는 그 보장이 없습니다: 쓰기 직후 브라우저가 죽으면
 * 번호가 되돌아가고, 그러면 같은 번호가 두 번 올라갑니다. 그 사고는
 * 서버의 유일 제약(uq_orders_transaction)이 잡아내고, 두 번째 수락이
 * 실패합니다 — 조용히 덮어쓰이지는 않습니다.
 *
 * <p>키에 매장·단말·판매일자가 모두 들어갑니다. 매출 키가
 * (판매일자, 점포, POS번호, 거래번호)이므로, 그 셋이 같은 범위 안에서만
 * 번호가 유일하면 됩니다 — 그래서 날마다 1번부터 다시 시작합니다.
 */

const PREFIX = 'tranNo'

function key(storeId: string, deviceId: string, businessDate: string): string {
  return `${PREFIX}:${storeId}:${deviceId}:${businessDate}`
}

/**
 * 다음 거래번호. 읽고-더하고-쓰는 세 걸음이지만, 한 단말의 한 탭에서만
 * 도는 코드라 그 사이에 끼어들 것이 없습니다 — 같은 단말을 두 탭에서
 * 열면 Device Server가 한쪽 연결을 닫습니다(중복 장비).
 *
 * <p>여섯 자리로 0을 채웁니다. 영수증에서 자리가 흔들리지 않고, 하루
 * 100만 건은 이 규모에서 올 일이 없습니다.
 */
export function nextTranNo(storeId: string, deviceId: string, businessDate: string): string {
  const k = key(storeId, deviceId, businessDate)
  let last = 0
  try {
    last = Number(localStorage.getItem(k) ?? '0')
    if (!Number.isFinite(last) || last < 0) last = 0
  } catch {
    // 사생활 보호 창, 지워진 저장소. 1번부터 다시 시작하고, 겹치는
    // 번호는 서버의 유일 제약이 잡습니다.
    last = 0
  }
  const next = last + 1
  try {
    localStorage.setItem(k, String(next))
  } catch {
    // 못 적어도 번호는 내보냅니다 — 여기서 멈추면 장사가 멈춥니다.
  }
  return String(next).padStart(6, '0')
}

/**
 * 오늘 이 단말이 끊은 마지막 거래번호. 화면 구석에 띄워 두면, 배치가
 * 어디까지 올라갔는지 대조할 때 사람이 볼 값이 생깁니다.
 */
export function lastTranNo(storeId: string, deviceId: string, businessDate: string): string | null {
  try {
    const raw = localStorage.getItem(key(storeId, deviceId, businessDate))
    return raw === null ? null : String(Number(raw)).padStart(6, '0')
  } catch {
    return null
  }
}
