#!/bin/zsh
# 반도체 소자 파라미터 추출기 — 저장소 분리 설정 (맥에서 한 번만 실행)
#
# 하는 일 (petfee / daytrade 와 같은 구조):
#  1. 비공개 저장소 macultist/devparam-src 생성, 소스·테스트·기록 푸시
#  2. 배포 열쇠 생성: 공개키 → devparam(진열장) 배포키(쓰기), 비밀키 → devparam-src 시크릿 PAGES_DEPLOY_KEY
#  3. 자동 실행(매일 04:10 KST)은 워크플로에 이미 들어 있음. 한 번 수동 실행해 진열장 반영 확인, Pages 켜기
#  4. 공개 저장소 macultist.github.io 의 코드 들어 있던 이력 정리 (되돌리기 어려움 — 마지막에 확인 후 실행)
#
# 준비물: gh (로그인 상태), git, ssh-keygen, node 22
# 사용법: zsh tools/setup-split.sh        (이 스크립트가 들어 있는 devparam-src 폴더 안에서)
set -e
OWNER=macultist
PRIV=devparam-src
PUB=devparam
SITE_REPO=macultist.github.io
SITE_BRANCH=claude/semiparam-extractor-build-itd2ut
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

step() { printf '\n== %s\n' "$1"; }
ask()  { printf '%s [y/N] ' "$1"; read -r REPLY; case "$REPLY" in y|Y) return 0;; *) return 1;; esac; }

command -v gh >/dev/null || { echo "gh 가 없습니다: brew install gh && gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 로그인 필요: gh auth login"; exit 1; }

step "0. 로컬 테스트·빌드 확인"
[ -d node_modules/terser ] || npm install --silent --no-audit --no-fund
node test/run.mjs | tail -1
node tools/build.mjs

step "1. 비공개 저장소 $OWNER/$PRIV 생성 + 푸시"
if gh repo view $OWNER/$PRIV >/dev/null 2>&1; then echo "이미 있음 — 건너뜀"; else
  gh repo create $OWNER/$PRIV --private --description "반도체 소자 파라미터 추출기 공장: 소스·테스트·화면 생성 (비공개)"
fi
if [ ! -d .git ]; then git init -q -b main; fi
git add -A && git -c user.name="$(git config user.name || echo macultist)" commit -qm "init: 소스·테스트·빌드·워크플로 이전" || echo "커밋할 변경 없음"
git remote get-url origin >/dev/null 2>&1 || git remote add origin git@github.com:$OWNER/$PRIV.git
git push -u origin main

step "1b. 공개 저장소(진열장) $OWNER/$PUB 생성"
if gh repo view $OWNER/$PUB >/dev/null 2>&1; then echo "이미 있음 — 건너뜀"; else
  gh repo create $OWNER/$PUB --public --description "반도체 소자 파라미터 추출기 공개 화면 (macultist.github.io/devparam)"
fi

step "2. 배포 열쇠 (기계용 SSH 키, 비밀번호·결제 정보 없음)"
KEY=$(mktemp -d)/devparam_deploy
ssh-keygen -q -t ed25519 -N "" -C "$PRIV -> $PUB pages deploy" -f "$KEY"
gh repo deploy-key add "$KEY.pub" -R $OWNER/$PUB --title "$PRIV publisher" --allow-write
gh secret set PAGES_DEPLOY_KEY -R $OWNER/$PRIV < "$KEY"
rm -f "$KEY" "$KEY.pub"
echo "열쇠 등록 완료 (비밀키는 시크릿에만 저장, 로컬 사본 삭제)"
if ask "Discord 알림 웹훅도 시크릿(DISCORD_WEBHOOK)으로 넣을까요?"; then
  printf '웹훅 주소: '; read -r HOOK; [ -n "$HOOK" ] && printf '%s' "$HOOK" | gh secret set DISCORD_WEBHOOK -R $OWNER/$PRIV
fi

step "3. 첫 실행 → 진열장 반영 확인 → Pages 켜기"
gh workflow run build-and-publish -R $OWNER/$PRIV
sleep 8
RUN=$(gh run list -R $OWNER/$PRIV -w build-and-publish -L 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" -R $OWNER/$PRIV --exit-status
gh api -X POST repos/$OWNER/$PUB/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1 \
  && echo "Pages 켬 (main 루트)" || echo "Pages 는 이미 켜져 있거나 설정 필요: https://github.com/$OWNER/$PUB/settings/pages"
echo "공개 저장소 최신 커밋:"; gh api repos/$OWNER/$PUB/commits/main -q '.commit.message'
echo "1~3분 뒤 확인: https://macultist.github.io/devparam/"

step "4. 공개 저장소 $SITE_REPO 의 코드 이력 정리 (되돌리기 어려움)"
echo "브랜치 $SITE_BRANCH 는 [커밋A: 대문 등록만] → [커밋B: devparam-src 폴더] 순서입니다."
echo "커밋B 를 버리고 커밋A 만 남기면 코드가 들어 있던 이력이 사라집니다. 원본은 이 맥과 $OWNER/$PRIV 에 있습니다."
if ask "지금 정리할까요?"; then
  TMP=$(mktemp -d)
  git clone -q --branch $SITE_BRANCH --single-branch https://github.com/$OWNER/$SITE_REPO "$TMP/site"
  cd "$TMP/site"
  git log --oneline -3
  git push --force origin "origin/$SITE_BRANCH~1:refs/heads/$SITE_BRANCH"
  echo "정리 완료. 남은 브랜치 내용:"; git fetch -q origin $SITE_BRANCH && git log --oneline -1 origin/$SITE_BRANCH
  if ask "이 브랜치(대문 등록만)를 main 에 바로 합칠까요?"; then
    git fetch -q origin main && git checkout -q -B main origin/main && git merge -q --ff-only origin/$SITE_BRANCH && git push origin main && echo "main 반영 완료"
  fi
  cd "$ROOT"
fi
printf '\n모두 끝났습니다. 이후 수정은 %s 에서 ./publish.sh "메시지" 로 올리면 1~2분 뒤 사이트에 반영됩니다.\n' "$PRIV"
