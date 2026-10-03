#!/bin/sh
# 단말 화면 하나를 서버에 올립니다 — 빌드 → nginx 폴더에 올리기 → 서버가 주는 번들이 방금 것인지 확인.
#
#   scripts/deploy.sh pos | kds | did
#
# - 작업 PC(Git Bash)에서 돌립니다. 서버에는 Node 가 없어서 빌드는 여기서 합니다.
# - 서버 접속은 ~/.ssh/config 의 sunmoon-svr (Debian-Setting docs/debian13.md).
# - scp 대신 tar 를 ssh 로 — assets 를 먼저 지워 해시 붙은 옛 번들이 쌓이지 않게 합니다.
set -eu

screen=${1:-}
case "$screen" in
  pos|kds|did) ;;
  *) echo "사용: $0 pos|kds|did" >&2; exit 2 ;;
esac
host=${SUNMOON_HOST:-sunmoon-svr}
root=$(cd "$(dirname "$0")/.." && pwd)

cd "$root"
npm run build -w "$screen"

tar -czf - -C "$screen/dist" . | ssh "$host" \
  "rm -rf /srv/sunmoon/nginx/html/$screen/assets && tar xzf - -C /srv/sunmoon/nginx/html/$screen"

built=$(grep -o 'index-[A-Za-z0-9_-]*\.js' "$screen/dist/index.html")
served=$(ssh "$host" "curl -s http://localhost:8000/$screen/" | grep -o 'index-[A-Za-z0-9_-]*\.js')
if [ "$built" = "$served" ]; then
  echo "$screen: 올림 ($built)"
else
  echo "$screen: 서버가 다른 번들을 줍니다 — 빌드 $built, 서버 $served" >&2
  exit 1
fi
