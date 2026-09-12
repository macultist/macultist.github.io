#!/bin/zsh
# 로컬에서 바로 배포: 테스트 → 화면 생성 → 비공개 저장소에 커밋/푸시 (CI가 공개 저장소로 전달)
cd "$(dirname "$0")"
node test/run.mjs >/dev/null || { echo "테스트 실패 — 배포 중단"; exit 1; }
node tools/build.mjs && git add -A && git commit -qm "${1:-update}" && git push -q && echo "pushed → CI가 1~2분 뒤 공개 사이트에 반영"
