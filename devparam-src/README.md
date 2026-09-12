# 반도체 소자 파라미터 추출기 — 공장 (devparam-src, 비공개)

MOSFET·다이오드 측정 파일(CSV/TSV)에서 Vth·SS·이동도·λ·n·Rs 를 여러 기법으로 뽑아 비교하는 정적 웹 도구의 소스.
공개 사이트: https://macultist.github.io/devparam/ (공개 저장소 `macultist/devparam` 에는 완성 화면만 올라간다)

- `src/` : 화면(index.html, css, js). 빌드 도구 없는 ES 모듈, 외부 라이브러리 없음(글꼴 CDN 제외).
- `test/run.mjs` : 합성 곡선 정확도 테스트 (`npm test`). 실패하면 CI 가 배포하지 않는다.
- `tools/build.mjs` : `src/` → `site/` (terser 로 JS 뭉개기, CSS 압축, 무단 복제 금지 표시 삽입).
- `tools/setup-split.sh` : 맥에서 한 번 실행하는 저장소 분리 설정 스크립트(저장소 생성, 배포 열쇠, Pages, 첫 실행, 공개 이력 정리).
- `.github/workflows/build.yml` : 매일 04:10 KST 점검 + main 푸시 시 즉시 → 테스트 → 빌드 → 공개 저장소로 강제 푸시(내용이 바뀐 경우에만).
- `publish.sh` : 로컬에서 테스트·빌드 후 커밋/푸시.
- `docs/` : 계획·구현 기록.

로컬 실행:
```
npm install
npm test
npm run build && npm run serve   # http://localhost:8765/
```

## 기능

| 모드 | 추출 항목 |
|---|---|
| MOSFET 전달특성 (Id–Vg) | Vth 4가지(선형외삽 ELR, 정전류 CC, 이차미분 SD, gm/Id TCR), SS, Ion/Ioff, gm,max, 선형·포화 이동도, 정·역 스윕 히스테리시스, Vd 별 비교표 |
| MOSFET 출력특성 (Id–Vd) | Vg 곡선별 gd, ro, λ, VA, Ron |
| 다이오드 (I–V) | 이상계수 n(기울기·Cheung), Is, Rs(Cheung·편차법), 턴온 전압 3정의, 정류비 |

입력: 끌어놓기/붙여넣기 → 구분자·헤더 자동 감지(쉼표·탭·세미콜론·공백, 소수점 쉼표) → 열 자동 매핑 → 단위 선택. 프리셋: 자동, Keithley 식 헤더, B1500 EasyEXPERT(DataName/DataValue), 일반 2열.
출력: SVG 그래프(저장 가능), 결과표, 마크다운/CSV 복사, 기법 설명, 합성 예제(잡음 0/1/3%).

## 기법 요약

- **ELR**: gm 이 최댓값의 80% 이상인 구간을 직선 회귀해 x축 절편, 선형영역이면 Vd/2 를 뺀다. 포화영역은 √Id.
- **CC**: log Id 가 Icc(기본 100 nA × W/L)와 만나는 Vg.
- **SD**: d²Id/dVg² 최대점(포화영역은 √Id 기준).
- **TCR**: gm/Id = d(ln Id)/dVg 의 감소가 가장 급한 점. 약반전 평탄부에서 n.
- **SS**: log Id 기울기가 최댓값의 70% 이상인 구간 직선 맞춤. 잡음 바닥 근처 점 제외.
- **λ**: 포화 구간 직선 Id = gd·Vd + Id0 에서 λ = gd/Id0.
- **다이오드**: ln I–V 기울기 최대 근방 직선(n, Is); dV/dlnI = Rs·I + n·VT(Cheung); 편차법 Rs.
