# sun-moon-terminals

매장 단말 화면 셋 — **POS · KDS · DID** — 을 한 저장소에 둡니다(2026-10-03, 설계: umbrella
`sun-moon-java-platform/docs/design/terminal-monorepo.md`). 예전 저장소 `sun-moon-terminal-pos`·`-kds`·`-did`
의 이력은 `git subtree` 로 그대로 들어와 있고, 옛 저장소는 archive 입니다.

```text
common/   @sunmoon/terminal-common — 세 화면이 같이 쓰는 통신·소켓·셸·표시 (빌드 없이 TS 원본)
pos/      POS 화면      (/pos/) — 화면만의 통신은 src/lib/posApi.ts
kds/      KDS 화면      (/kds/) — src/lib/kdsApi.ts
did/      DID 화면      (/did/) — 공통만 씀
scripts/  deploy.sh — 화면 하나를 서버에 올림
```

## 쓰는 법

```bash
npm ci                      # 루트에서 한 번 (npm workspaces)
npm run build               # 셋 다
npm run build -w kds        # 하나만
npm run dev -w pos          # 개발 서버
scripts/deploy.sh kds       # 빌드 → 서버 nginx 에 올리기 → 서버가 주는 번들 확인
```

## 공통으로 넣는 기준

**세 화면(적어도 둘)이 같은 일로 쓰는 것**만 `common` 에 둡니다. 한 화면만 쓰는 것은 그 화면의
`posApi.ts`·`kdsApi.ts` 에 둡니다 — 비슷해 보이는 것이 아니라 되풀이되는 것만 합칩니다.

- 표시가 화면마다 다르면 공통 기본값 + 화면별 덮어쓰기 (예: POS 는 `STATUS_LABEL.PRODUCED` 를 "생산 완료")
- 공통 파일을 고치면 세 화면 모두 `npm run build` 로 확인 — 각 화면의 `tsc -b` 가 공통 파일도 검사합니다

## 다른 저장소와의 관계

- 셸(`sun-moon-store-app`)의 `scripts/bundle-ui.mjs` 가 `../sun-moon-terminals/pos/dist`·`kds/dist` 를 가져갑니다.
- 서버의 화면 폴더는 `/srv/sunmoon/nginx/html/{pos,kds,did}` 입니다(Debian-Setting `docs/debian13.md`).
