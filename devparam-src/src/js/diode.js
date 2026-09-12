// diode.js — 다이오드 I–V 파라미터 추출 (이상계수 n, 포화전류 Is, 직렬저항 Rs, 턴온 전압)
import {
  linfit, localPoly, autoWindow, interp1, findCrossing, argmax, sortByX, thermalVoltage,
} from './numeric.js';

/**
 * @param {number[]} vRaw 전압 [V]
 * @param {number[]} iRaw 전류 [A]
 * @param {object} opt  T[K], window, Iref(턴온 기준 전류, 기본 1 mA), polarity 'auto'|'forward'|'reverse-flip'
 */
export function extractDiode(vRaw, iRaw, opt = {}) {
  const T = opt.T || 300;
  const VT = thermalVoltage(T);
  // 극성: 전류가 큰 쪽 전압이 음수면 (역방향으로 찍힌 자료) 뒤집는다
  let sign = 1;
  if (opt.polarity === 'flip') sign = -1;
  else if (!opt.polarity || opt.polarity === 'auto') {
    const k = argmax(iRaw.map(Math.abs));
    if (k >= 0 && vRaw[k] < 0) sign = -1;
  }
  const s = sortByX(vRaw.map(v => v * sign), iRaw.map(v => v * sign));
  const vAll = s.x, iAll = s.y;
  const notes = [];

  // 순방향 구간 (V>0, I>0)
  const v = [], i = [];
  for (let k = 0; k < vAll.length; k++) if (vAll[k] > 0 && iAll[k] > 0) { v.push(vAll[k]); i.push(iAll[k]); }
  const n = v.length;
  if (n < 5) return { ok: false, error: '순방향(V>0, I>0) 데이터가 5점 미만입니다.', sign, vAll, iAll };
  const win = opt.window || autoWindow(n);
  const lnI = i.map(Math.log);
  const dln = localPoly(v, lnI, { window: win, order: 2, deriv: 1 }); // d(lnI)/dV

  // ── 1) 지수 영역 직선 맞춤: 기울기 최대 근처, 기울기 ≥ 최대의 85% 인 연속 구간 ──
  const floor = noiseFloorPos(i);
  const ok = (k) => i[k] > floor * 5 && Number.isFinite(dln[k]);
  const kMax = argmax(dln, (k) => ok(k));
  let expo = { n: NaN, Is: NaN, vLo: NaN, vHi: NaN, fit: null, points: 0, r2: NaN };
  if (kMax >= 0) {
    const thr = dln[kMax] * 0.85;
    let lo = kMax, hi = kMax;
    while (lo - 1 >= 0 && ok(lo - 1) && dln[lo - 1] >= thr) lo--;
    while (hi + 1 < n && ok(hi + 1) && dln[hi + 1] >= thr) hi++;
    while (hi - lo + 1 < 4 && (lo > 0 || hi < n - 1)) { if (lo > 0) lo--; else hi++; }
    const xs = [], ys = [];
    for (let k = lo; k <= hi; k++) if (ok(k)) { xs.push(v[k]); ys.push(lnI[k]); }
    const f = linfit(xs, ys);
    expo = {
      n: f.slope > 0 ? 1 / (f.slope * VT) : NaN, Is: Math.exp(f.intercept),
      vLo: v[lo], vHi: v[hi], fit: f, points: xs.length, r2: f.r2, lo, hi,
    };
  }

  // ── 2) Cheung 법: dV/d(lnI) = Rs·I + n·VT  (전류에 대해 직선) ──
  // 고전류 구간(전류 상위 절반, 지수영역 맞춤 구간보다 위)에서 직선 회귀
  const dVdln = dln.map(d => (Number.isFinite(d) && d > 0) ? 1 / d : NaN);
  const iMaxV = i[n - 1];
  const cx = [], cy = [];
  const startIdx = Number.isFinite(expo.hi) ? expo.hi : Math.floor(n / 2);
  for (let k = startIdx; k < n; k++) if (Number.isFinite(dVdln[k]) && i[k] > iMaxV * 0.02) { cx.push(i[k]); cy.push(dVdln[k]); }
  let cheung = { Rs: NaN, n: NaN, fit: null, points: cx.length, iLo: NaN, iHi: NaN };
  if (cx.length >= 3) {
    const f = linfit(cx, cy);
    cheung = { Rs: f.slope, n: f.intercept / VT, fit: f, points: cx.length, r2: f.r2, iLo: cx[0], iHi: cx[cx.length - 1] };
  } else notes.push('Cheung 법에 쓸 고전류 점이 3개 미만이라 Rs(Cheung)는 생략했습니다.');

  // ── 3) 편차법 Rs: 상위 전류 20% 점에서 Rs = (V − n·VT·ln(I/Is+1)) / I 의 중앙값 ──
  let rsDev = NaN;
  if (Number.isFinite(expo.n) && expo.Is > 0) {
    const vals = [];
    for (let k = Math.floor(n * 0.8); k < n; k++) {
      const vIdeal = expo.n * VT * Math.log(i[k] / expo.Is + 1);
      vals.push((v[k] - vIdeal) / i[k]);
    }
    vals.sort((a, b) => a - b);
    if (vals.length) rsDev = vals[Math.floor(vals.length / 2)];
  }

  // ── 4) 턴온 전압 ──
  const Iref = opt.Iref > 0 ? opt.Iref : 1e-3;
  const vonAtIref = findCrossing(v, i, Iref, { rising: true });
  // 고전류 선형 구간 외삽: 전류 상위 30% 점 직선 맞춤 → I=0 절편
  const hx = [], hy = [];
  for (let k = 0; k < n; k++) if (i[k] >= iMaxV * 0.7) { hx.push(v[k]); hy.push(i[k]); }
  let vonExtrap = NaN, hfit = null;
  if (hx.length >= 2) { hfit = linfit(hx, hy); if (hfit.slope > 0) vonExtrap = -hfit.intercept / hfit.slope; }
  // 1% Imax 기준
  const vonPct = findCrossing(v, i, iMaxV * 0.01, { rising: true });

  // ── 5) 역방향 정보 ──
  const rv = [], ri = [];
  for (let k = 0; k < vAll.length; k++) if (vAll[k] < 0) { rv.push(vAll[k]); ri.push(iAll[k]); }
  let reverse = { available: rv.length > 0, iAtMinus1: NaN, iMin: NaN, rectRatio: NaN, vRef: NaN };
  if (rv.length) {
    const vRef = Math.min(1, -rv[0], v[n - 1]);
    const ir = Math.abs(interp1(rv, ri, -vRef));
    const ifw = interp1(v, i, vRef);
    reverse = { available: true, vRef, iAtMinusRef: ir, iAtRef: ifw, rectRatio: ir > 0 && ifw > 0 ? ifw / ir : NaN };
  }

  return {
    ok: true, sign, T, VT, window: win, notes,
    v, i, lnI, dln, dVdln, vAll, iAll,
    expo, cheung, rsDev,
    turnOn: { Iref, atIref: vonAtIref, extrap: vonExtrap, extrapFit: hfit, pct1: vonPct },
    reverse, iMax: iMaxV,
  };
}

function noiseFloorPos(arr) {
  const v = arr.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.floor(Math.max(1, v.length * 0.1) / 2)];
}
