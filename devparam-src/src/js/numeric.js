// numeric.js — 의존성 없는 수치 계산 함수 모음 (ES 모듈)
// 최소제곱 직선 맞춤, 국소 다항식(Savitzky–Golay 계열) 평활·미분, 보간, 소형 선형계 풀이

export const K_B = 1.380649e-23;   // 볼츠만 상수 [J/K]
export const Q_E = 1.602176634e-19; // 전자 전하 [C]
export const EPS0 = 8.8541878128e-12; // 진공 유전율 [F/m]

/** 열전압 kT/q [V] */
export function thermalVoltage(T = 300) {
  return K_B * T / Q_E;
}

/** 최소제곱 직선 맞춤 y = slope·x + intercept. r2(결정계수)도 함께 돌려준다. */
export function linfit(x, y) {
  const n = x.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxx === 0 ? NaN : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

/** 가우스 소거로 A·c = b 를 푼다 (부분 피벗). A는 정방 행렬(배열의 배열). */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-300) return null;
    if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

/** 다항식 최소제곱 맞춤. 계수 c[0..order] (c[k]는 x^k 계수). x는 평행이동된 값이라고 가정. */
export function polyfit(x, y, order) {
  const m = order + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  // 정규방정식: sum x^(j+k) c_k = sum x^j y
  const pows = new Array(2 * order + 1).fill(0);
  for (let i = 0; i < x.length; i++) {
    let p = 1;
    for (let k = 0; k <= 2 * order; k++) { pows[k] += p; p *= x[i]; }
    let q = 1;
    for (let j = 0; j < m; j++) { b[j] += q * y[i]; q *= x[i]; }
  }
  for (let j = 0; j < m; j++) for (let k = 0; k < m; k++) A[j][k] = pows[j + k];
  return solveLinear(A, b);
}

/**
 * 국소 다항식 평활/미분 (Savitzky–Golay 의 일반화: x 간격이 균일하지 않아도 됨)
 * 각 점 i 주변 window 개 점을 (x - x_i) 로 이동시켜 order 차 다항식으로 맞춘 뒤
 * deriv 차 도함수 값을 돌려준다. deriv=0 이면 평활값.
 */
export function localPoly(x, y, { window = 7, order = 2, deriv = 0 } = {}) {
  const n = x.length;
  const out = new Array(n).fill(NaN);
  if (n === 0) return out;
  let w = Math.max(order + 1, Math.min(window | 0, n));
  if (w % 2 === 0) w = Math.min(w + 1, n);
  const half = (w - 1) >> 1;
  const fact = [1, 1, 2, 6, 24, 120];
  for (let i = 0; i < n; i++) {
    let lo = i - half, hi = i + half;
    if (lo < 0) { hi = Math.min(n - 1, hi - lo); lo = 0; }
    if (hi > n - 1) { lo = Math.max(0, lo - (hi - (n - 1))); hi = n - 1; }
    const xs = [], ys = [];
    for (let k = lo; k <= hi; k++) {
      if (Number.isFinite(x[k]) && Number.isFinite(y[k])) { xs.push(x[k] - x[i]); ys.push(y[k]); }
    }
    if (xs.length < order + 1) continue;
    // x 스케일 정규화로 수치 안정성 확보
    let scale = 0;
    for (const v of xs) scale = Math.max(scale, Math.abs(v));
    if (scale === 0) scale = 1;
    const xn = xs.map(v => v / scale);
    const c = polyfit(xn, ys, order);
    if (!c) continue;
    out[i] = deriv <= order ? c[deriv] * fact[deriv] / Math.pow(scale, deriv) : 0;
  }
  return out;
}

/** 중앙차분 1차 미분 (양 끝은 전진/후진 차분) */
export function centralDiff(x, y) {
  const n = x.length;
  const d = new Array(n).fill(NaN);
  if (n < 2) return d;
  d[0] = (y[1] - y[0]) / (x[1] - x[0]);
  d[n - 1] = (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]);
  for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1]);
  return d;
}

/** 자동 평활 창 크기: 점 수에 따라 5~15 사이의 홀수 */
export function autoWindow(n) {
  let w = Math.round(n / 12);
  if (w < 5) w = 5;
  if (w > 15) w = 15;
  if (w % 2 === 0) w += 1;
  return Math.min(w, n % 2 ? n : n - 1);
}

/** 선형 보간: xs 오름차순 가정. 범위 밖이면 NaN */
export function interp1(xs, ys, x) {
  const n = xs.length;
  if (n === 0 || x < xs[0] || x > xs[n - 1]) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  if (xs[hi] === xs[lo]) return ys[lo];
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/**
 * y(x) 가 level 을 지나는 x 값을 찾는다 (선형 보간). 여러 곳에서 지나면 첫 번째(오름차순 x 기준).
 * y 가 NaN 인 구간은 건너뛴다.
 */
export function findCrossing(x, y, level, { rising = true } = {}) {
  for (let i = 0; i < x.length - 1; i++) {
    const a = y[i], b = y[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const okDir = rising ? (a <= level && b >= level) : (a >= level && b <= level);
    if (okDir && a !== b) {
      return x[i] + (level - a) * (x[i + 1] - x[i]) / (b - a);
    }
    if (a === level) return x[i];
  }
  return NaN;
}

export function argmax(arr, pred) {
  let idx = -1, best = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (pred && !pred(i, v)) continue;
    if (v > best) { best = v; idx = i; }
  }
  return idx;
}

export function argmin(arr, pred) {
  let idx = -1, best = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    if (pred && !pred(i, v)) continue;
    if (v < best) { best = v; idx = i; }
  }
  return idx;
}

/** 배열을 x 기준 오름차순으로 정렬한 (x, y) 쌍 배열 */
export function sortByX(x, y) {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  return { x: idx.map(i => x[i]), y: idx.map(i => y[i]), order: idx };
}

/** 스윕 방향이 바뀌는 지점으로 분할 (정·역 스윕 분리). 각 구간의 [start, end) 인덱스를 돌려줌 */
export function splitSweeps(x, minLen = 4) {
  const n = x.length;
  if (n < 2) return [[0, n]];
  const segs = [];
  let start = 0;
  let dir = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.sign(x[i] - x[i - 1]);
    if (d === 0) continue;
    if (dir === 0) { dir = d; continue; }
    if (d !== dir) {
      segs.push([start, i]);
      start = i - 1; // 꺾이는 점은 두 구간에 모두 포함
      dir = d;
    }
  }
  segs.push([start, n]);
  return segs.filter(s => s[1] - s[0] >= minLen).length ? segs.filter(s => s[1] - s[0] >= minLen) : [[0, n]];
}

/** 유한하고 양수인 값만 log10, 아니면 NaN */
export function log10pos(v) {
  return v > 0 && Number.isFinite(v) ? Math.log10(v) : NaN;
}

/** 값을 유효숫자 sig 자리로 문자열화 (지수 표기는 필요할 때만) */
export function fmt(v, sig = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(sig - 1).replace('e-', 'e−').replace('e+', 'e');
  return String(Number(v.toPrecision(sig)));
}

/** SI 접두어를 붙인 문자열 (예: 1.23e-6 A → 1.23 µA) */
export function fmtSI(v, unit = '', sig = 3) {
  if (v === null || v === undefined || !Number.isFinite(v)) return fmt(v);
  if (v === 0) return `0 ${unit}`.trim();
  const prefixes = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'], [1e-18, 'a'],
  ];
  const a = Math.abs(v);
  for (const [scale, p] of prefixes) {
    if (a >= scale * 0.9995) {
      return `${Number((v / scale).toPrecision(sig))} ${p}${unit}`.trim();
    }
  }
  return `${v.toExponential(sig - 1)} ${unit}`.trim();
}

/** 결정론적 의사난수 (mulberry32) — 합성 데이터 재현용 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 표준정규 난수 (Box–Muller) */
export function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
