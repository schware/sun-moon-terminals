/**
 * 이 단말의 거래 원장 — POS가 상태를 갖는 첫 단계 (umbrella docs/adr/0010 §단계 1).
 *
 * <p>ADR이 세 단계를 적어 뒀습니다: 0 무상태 → <b>1 IndexedDB 큐 + 로컬
 * 채번</b> → 2 SQLite. 여기가 1단계이고, 지금의 정적 번들 그대로
 * 동작하는 범위입니다.
 *
 * <p><b>왜 localStorage 로는 안 되는가.</b> 거래번호는 읽고-더하고-쓰는
 * 세 걸음인데, localStorage 에는 그 셋과 거래 기록을 함께 묶을 방법이
 * 없습니다. 번호를 올린 직후 브라우저가 죽으면 번호만 오르고 거래는
 * 안 남거나, 그 반대가 됩니다. 앞쪽은 영수증 번호에 구멍을 내고,
 * 뒤쪽은 <b>같은 번호가 두 번</b> 올라가 서버의 유일 제약에 부딪혀
 * 손님 앞에서 수락이 실패합니다.
 *
 * <p>IndexedDB 의 트랜잭션은 object store 여럿을 한 번에 묶습니다.
 * 그래서 {@link mint} 는 <b>번호를 올리는 것과 거래를 적는 것을 한
 * 트랜잭션에</b> 넣습니다. 둘 다 되거나 둘 다 안 됩니다.
 *
 * <p><b>이 원장이 이 단말 거래의 원본입니다</b> (ADR-0010). 서버는
 * 올라온 것을 모으는 곳이고, 어긋나면 이쪽이 맞습니다.
 */

const DB_NAME = 'sunmoon-pos'
const DB_VERSION = 1

/** 거래번호를 어디까지 썼나. 매장·단말·판매일자마다 따로입니다. */
const COUNTER = 'counter'
/** 거래 원장. 올라갔는지까지 여기 적힙니다. */
const TRAN = 'tran'

/**
 * 한 거래가 지나는 상태.
 *
 * - `MINTED` — 번호만 나고 아직 서버에 수락을 못 알린 것. <b>창이
 *   열려 있는 상태</b>라 시작할 때 정리합니다({@link reconcile}).
 * - `PENDING` — 수락됐고 올릴 차례.
 * - `SENT` — 올라갔습니다.
 * - `VOID` — 수락이 실패해서 거래가 되지 못한 번호. 지우지 않고
 *   남깁니다 — 영수증 번호에 구멍이 났을 때 "왜 비었나"의 답이
 *   여기 있어야 합니다.
 */
export type TranState = 'MINTED' | 'PENDING' | 'SENT' | 'VOID'

export interface TranRow {
  /** `매장:단말:판매일자:거래번호` — 매출 키 그대로입니다. */
  id: string
  storeId: string
  deviceId: string
  businessDate: string
  tranNo: string
  state: TranState
  /** 이 거래가 가리키는 OMS 주문 번호. 수락 실패를 되짚을 때 씁니다. */
  orderId: number
  /** 올릴 전문(§3.1). `MINTED` 동안에는 없습니다. */
  payload: unknown | null
  mintedAt: string
  sentAt: string | null
  attempts: number
  lastError: string | null
}

/**
 * 셸(sun-moon-store-app)의 SQLite 원장 (store-app.md §6.1, ADR-0010 2단계).
 *
 * <p>있으면 그것을, 없으면(브라우저) 아래의 IndexedDB 를 씁니다. 함수 이름과 규칙이
 * 같아서 화면 코드는 어느 쪽인지 모릅니다. 셸의 원장은 브라우저 데이터를 지워도 남습니다.
 *
 * <p>셸에서 처음 쓸 때 <b>이 출처의 IndexedDB 에 있던 것을 한 번 옮깁니다</b>(카운터는 큰 쪽).
 * IndexedDB 는 출처마다 따로라, 브라우저에서 쓰던 웹 POS 의 원장은 셸에서 보이지 않습니다 —
 * 웹 POS 를 셸로 바꾸는 것은 <b>마감 뒤</b>에 하십시오. 번호가 판매일자마다 1부터라, 그러면
 * 겹칠 번호가 없습니다.
 */
interface ShellLedger {
  mint(storeId: string, deviceId: string, businessDate: string, orderId: number): Promise<TranRow>
  confirm(id: string, payload: unknown): Promise<void>
  discard(id: string, reason: string): Promise<void>
  pending(): Promise<TranRow[]>
  unsentCount(): Promise<number>
  markSent(ids: string[]): Promise<void>
  markFailed(ids: string[], reason: string): Promise<void>
  minted(): Promise<TranRow[]>
  migrated(): Promise<boolean>
  importRows(counters: Array<{ key: string; last: number }>, trans: TranRow[]): Promise<unknown>
}

let migration: Promise<void> | null = null

/** 셸이면 (한 번 옮긴 뒤) 셸의 원장. 브라우저면 undefined. */
async function shell(): Promise<ShellLedger | undefined> {
  const ledger = (window as unknown as { sunmoon?: { ledger?: ShellLedger } }).sunmoon?.ledger
  if (!ledger) return undefined
  migration ??= (async () => {
    if (await ledger.migrated()) return
    const db = await open()
    try {
      const tx = db.transaction([COUNTER, TRAN], 'readonly')
      const counters = await ask<Array<{ key: string; last: number }>>(tx.objectStore(COUNTER).getAll())
      const trans = await ask<TranRow[]>(tx.objectStore(TRAN).getAll())
      await ledger.importRows(counters, trans)
    } finally {
      db.close()
    }
  })()
  await migration
  return ledger
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(COUNTER)) {
        db.createObjectStore(COUNTER, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(TRAN)) {
        const store = db.createObjectStore(TRAN, { keyPath: 'id' })
        store.createIndex('by_state', 'state', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 를 열지 못했습니다'))
  })
}

/** 트랜잭션 하나를 끝까지 기다립니다 — 커밋되기 전에는 성공이 아닙니다. */
function done<T>(tx: IDBTransaction, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(value())
    tx.onerror = () => reject(tx.error ?? new Error('저장하지 못했습니다'))
    tx.onabort = () => reject(tx.error ?? new Error('저장이 취소되었습니다'))
  })
}

function ask<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('읽지 못했습니다'))
  })
}

function counterKey(storeId: string, deviceId: string, businessDate: string): string {
  return `${storeId}:${deviceId}:${businessDate}`
}

export function tranId(
  storeId: string, deviceId: string, businessDate: string, tranNo: string
): string {
  return `${storeId}:${deviceId}:${businessDate}:${tranNo}`
}

/**
 * 거래번호를 끊고 <b>같은 트랜잭션에서</b> 거래를 적습니다.
 *
 * <p>여섯 자리로 0을 채웁니다 — 영수증에서 자리가 흔들리지 않고,
 * 하루 100만 건은 이 규모에서 올 일이 없습니다.
 *
 * <p>판매일자가 키에 들어가므로 날마다 1번부터 다시 시작합니다.
 * 매출 키가 (판매일자, 점포, POS번호, 거래번호)라, 그 셋이 같은 범위
 * 안에서만 유일하면 됩니다.
 */
export async function mint(
  storeId: string, deviceId: string, businessDate: string, orderId: number
): Promise<TranRow> {
  const viaShell = await shell()
  if (viaShell) return viaShell.mint(storeId, deviceId, businessDate, orderId)
  const db = await open()
  try {
    const tx = db.transaction([COUNTER, TRAN], 'readwrite')
    const counters = tx.objectStore(COUNTER)
    const trans = tx.objectStore(TRAN)

    const key = counterKey(storeId, deviceId, businessDate)
    const current = await ask<{ key: string; last: number } | undefined>(counters.get(key))
    const last = current && Number.isFinite(current.last) && current.last > 0 ? current.last : 0
    const next = last + 1
    const tranNo = String(next).padStart(6, '0')

    const row: TranRow = {
      id: tranId(storeId, deviceId, businessDate, tranNo),
      storeId, deviceId, businessDate, tranNo,
      state: 'MINTED',
      orderId,
      payload: null,
      mintedAt: new Date().toISOString(),
      sentAt: null,
      attempts: 0,
      lastError: null
    }

    counters.put({ key, last: next })
    trans.put(row)

    return await done(tx, () => row)
  } finally {
    db.close()
  }
}

async function patch(id: string, change: (row: TranRow) => TranRow): Promise<void> {
  const db = await open()
  try {
    const tx = db.transaction(TRAN, 'readwrite')
    const store = tx.objectStore(TRAN)
    const row = await ask<TranRow | undefined>(store.get(id))
    if (row) store.put(change(row))
    await done(tx, () => undefined)
  } finally {
    db.close()
  }
}

/** 수락이 확인됐습니다 — 이제 올릴 것이 됩니다. */
export async function confirm(id: string, payload: unknown): Promise<void> {
  const viaShell = await shell()
  if (viaShell) return viaShell.confirm(id, payload)
  return patch(id, (row) => ({ ...row, state: 'PENDING', payload }))
}

/**
 * 수락이 실패했습니다 (보통 409 — 다른 단말이 먼저 가져갔거나 시간이
 * 지났습니다). <b>번호는 돌려주지 않습니다.</b> 되돌리면 다음 거래가
 * 같은 번호를 쓰게 되는데, 그 사이에 이 번호가 이미 올라갔을 수
 * 있습니다. 구멍이 중복보다 낫습니다.
 */
export async function discard(id: string, reason: string): Promise<void> {
  const viaShell = await shell()
  if (viaShell) return viaShell.discard(id, reason)
  return patch(id, (row) => ({ ...row, state: 'VOID', lastError: reason }))
}

async function byState(state: TranState): Promise<TranRow[]> {
  const db = await open()
  try {
    const tx = db.transaction(TRAN, 'readonly')
    const index = tx.objectStore(TRAN).index('by_state')
    const rows = await ask<TranRow[]>(index.getAll(state))
    return rows
  } finally {
    db.close()
  }
}

/** 아직 못 올린 것들. 오래된 것부터 — 순서대로 올라가는 편이 읽기 쉽습니다. */
export async function pending(storeId: string, deviceId: string): Promise<TranRow[]> {
  const viaShell = await shell()
  if (viaShell) return viaShell.pending()
  const rows = await byState('PENDING')
  return rows
    .filter((r) => r.storeId === storeId && r.deviceId === deviceId)
    .sort((a, b) => a.mintedAt.localeCompare(b.mintedAt))
}

export async function unsentCount(storeId: string, deviceId: string): Promise<number> {
  const viaShell = await shell()
  if (viaShell) return viaShell.unsentCount()
  return (await pending(storeId, deviceId)).length
}

export async function markSent(ids: string[]): Promise<void> {
  const viaShell = await shell()
  if (viaShell) return viaShell.markSent(ids)
  const now = new Date().toISOString()
  for (const id of ids) {
    await patch(id, (row) => ({ ...row, state: 'SENT', sentAt: now, lastError: null }))
  }
}

export async function markFailed(ids: string[], reason: string): Promise<void> {
  const viaShell = await shell()
  if (viaShell) return viaShell.markFailed(ids, reason)
  for (const id of ids) {
    await patch(id, (row) => ({ ...row, attempts: row.attempts + 1, lastError: reason }))
  }
}

/**
 * 번호만 끊고 멈춘 것들 — 시작할 때 닫아야 하는 창입니다.
 *
 * <p>{@code MINTED} 로 남은 것은 번호를 끊고 서버에 수락을 알리기
 * 전에 화면이 죽은 것입니다. 그 주문이 실제로 이 번호로 수락됐는지는
 * <b>서버만</b> 압니다 — 그래서 판단은 여기서 하지 않고, 물어볼 수
 * 있는 쪽(화면)이 {@link confirm} 이나 {@link discard} 로 닫습니다.
 *
 * <p>물어볼 수 없으면(네트워크가 끊겼으면) 그대로 두는 것이 맞습니다.
 * 모르는 채로 지우는 것이 제일 나쁩니다.
 */
export async function minted(storeId: string, deviceId: string): Promise<TranRow[]> {
  const viaShell = await shell()
  if (viaShell) return viaShell.minted()
  const rows = await byState('MINTED')
  return rows.filter((r) => r.storeId === storeId && r.deviceId === deviceId)
}

/**
 * 예전 localStorage 채번을 한 번만 옮겨옵니다.
 *
 * <p>안 옮기면 번호가 1번부터 다시 시작하고, 오늘 이미 올라간 번호와
 * 부딪힙니다. 옮긴 뒤 옛 키는 지웁니다 — 두 곳에 같은 값이 있으면
 * 다음에 어느 쪽이 맞는지 알 수 없습니다.
 */
export async function adoptLegacyCounters(): Promise<number> {
  // 셸에는 localStorage 채번 시절이 없었습니다(그 시절은 브라우저의 일).
  if (await shell()) return 0
  const prefix = 'tranNo:'
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith(prefix)) keys.push(k)
  }
  if (keys.length === 0) return 0

  const db = await open()
  try {
    const tx = db.transaction(COUNTER, 'readwrite')
    const store = tx.objectStore(COUNTER)
    for (const k of keys) {
      const scope = k.slice(prefix.length)
      const legacy = Number(localStorage.getItem(k) ?? '0')
      if (!Number.isFinite(legacy) || legacy <= 0) continue
      const current = await ask<{ key: string; last: number } | undefined>(store.get(scope))
      // 큰 쪽을 남깁니다. 어느 쪽이 앞서 있든 뒤로 가면 번호가 겹칩니다.
      if (!current || current.last < legacy) store.put({ key: scope, last: legacy })
    }
    await done(tx, () => undefined)
  } finally {
    db.close()
  }
  for (const k of keys) localStorage.removeItem(k)
  return keys.length
}
