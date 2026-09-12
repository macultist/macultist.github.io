// mosfet.js — MOSFET 전달특성(Id–Vg)·출력특성(Id–Vd) 파라미터 추출
import {
  linfit, localPoly, autoWindow, interp1, findCrossing, argmax, argmin,
  sortByX, splitSweeps, log10pos, thermalVoltage, EPS0,
} from './numeric.js';

/** 산화막 두께 tox[m], 비유전율 er 로 단위면적 산화막 정전용량 Cox [F/m²] */
export function oxideCapacitance(tox, er = 3.9) {
  if (!(tox > 0)) return NaN;
  return EPS0 * er / tox;
}

/**
 * 극성 정규화: p형이면 Vg, Id 부호를 뒤집어 "n형처럼" 양수로 만든다.
 * polarity: 'auto' | 'n' | 'p'
 * 돌려주는 sign 은 결과 전압에 곱해서 원래 극성으로 되돌릴 때 쓴다.
 */
export function normalizePolarity(vg, id, polarity = 'auto') {
  let sign = 1;
  if (polarity === 'p') sign = -1;
  else if (polarity === 'auto') {
    // 전류가 큰 쪽의 Vg 부호로 판단: |Id| 최대점의 Vg 가 음수이면 p형
    const i = argmax(id.map(Math.abs));
    if (i >= 0 && vg[i] < 0) sign = -1;
  }
  const vgN = vg.map(v => v * sign);
  let idN = id.map(v => v * sign);
  // 전류 부호 보정: 정규화 후 큰 전류 쪽이 음수라면(소스 전류를 기록한 경우 등) 부호를 뒤집는다
  const j = argmax(idN.map(Math.abs));
  let idFlipped = false;
  if (j >= 0 && idN[j] < 0) { idN = idN.map(v => -v); idFlipped = true; }
  return { vg: vgN, id: idN, sign, idFlipped, type: sign < 0 ? 'p' : 'n' };
}

/**
 * 전달특성 추출 (단일 스윕, 단일 Vd)
 * @param {number[]} vgRaw  게이트 전압 [V]
 * @param {number[]} idRaw  드레인 전류 [A]
 * @param {object} opt
 *   vd: 드레인 전압 [V] (선형영역 보정과 이동도 계산에 사용)
 *   region: 'linear' | 'saturation'
 *   polarity: 'auto'|'n'|'p'
 *   W, L: [m]  tox: [m]  er: 비유전율  T: [K]
 *   Icc: 정전류법 기준 전류 [A] (없으면 1e-7·W/L, W/L 없으면 1e-7)
 *   window: 평활 창(홀수), 없으면 자동
 *   vgOn, vgOff: Ion/Ioff 를 읽을 Vg (없으면 양 끝)
 */
export function extractTransfer(vgRaw, idRaw, opt = {}) {
  const T = opt.T || 300;
  const VT = thermalVoltage(T);
  const norm = normalizePolarity(vgRaw, idRaw, opt.polarity || 'auto');
  const s = sortByX(norm.vg, norm.id);
  const vg = s.x, id = s.y;
  const n = vg.length;
  const sign = norm.sign;
  const vdAbs = Number.isFinite(opt.vd) ? Math.abs(opt.vd) : NaN;
  const region = opt.region || 'linear';
  const win = opt.window || autoWindow(n);
  const notes = [];
  if (norm.idFlipped) notes.push('전류 부호가 반대여서 뒤집어 계산했습니다.');

  const idAbs = id.map(Math.abs);
  const logId = id.map(v => log10pos(v));
  const gm = localPoly(vg, id, { window: win, order: 2, deriv: 1 });
  const winWide = Math.min(n % 2 ? n : n - 1, 2 * win + 1);
  // 이차미분: 선형영역은 Id, 포화영역은 √Id (포화에서 Id 는 제곱꼴이라 d²Id 가 계단이 되어 최대점이 무의미)
  const sdBase = region === 'saturation' ? id.map(v => v > 0 ? Math.sqrt(v) : 0) : id;
  const d2 = localPoly(vg, sdBase, { window: winWide, order: 3, deriv: 2 });
  const dlog = localPoly(vg, logId, { window: win, order: 2, deriv: 1 });
  const floor = noiseFloor(idAbs);
  const half = (win - 1) >> 1;
  // 잡음 바닥에서 충분히 떨어져 있고, 평활 창 전체가 바닥 위에 있는 점
  const above = idAbs.map(v => v > floor * 20);
  const clean = (i) => {
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (!above[k]) return false;
    return true;
  };

  // ── gm,max ───────────────────────────────────────────
  const iGm = argmax(gm, (i) => id[i] > 0);
  const gmMax = iGm >= 0 ? gm[iGm] : NaN;

  // ── ELR (선형 외삽법) ────────────────────────────────
  // 선형영역: Id 의 기울기(gm)가 최대인 곳 주변(gm ≥ 0.9·gm,max 인 연속 구간)을 직선 회귀해 x축 절편을 얻는다.
  // 단일 점 접선보다 잡음에 훨씬 덜 흔들린다. 포화영역: sqrt(Id) 에 같은 방식을 적용.
  let elr = { vth: NaN, vthCorrected: NaN, x0: NaN, y0: NaN, slope: NaN, usesSqrt: region === 'saturation', lo: -1, hi: -1 };
  const elrFrac = opt.elrFrac > 0 && opt.elrFrac < 1 ? opt.elrFrac : 0.8;
  {
    const yv = region === 'saturation' ? id.map(v => v > 0 ? Math.sqrt(v) : 0) : id;
    const dyRaw = region === 'saturation' ? localPoly(vg, yv, { window: win, order: 2, deriv: 1 }) : gm;
    // 구간 선택에는 한 번 더 평활한 기울기를 써서 잡음 스파이크에 끌려가지 않게 한다
    const dy = localPoly(vg, dyRaw.map(v => Number.isFinite(v) ? v : 0), { window: winWide, order: 2, deriv: 0 });
    const k = argmax(dy, (i) => id[i] > 0);
    if (k >= 0 && dy[k] > 0) {
      const thr = dy[k] * elrFrac;
      let lo = k, hi = k;
      while (lo - 1 >= 0 && dy[lo - 1] >= thr) lo--;
      while (hi + 1 < n && dy[hi + 1] >= thr) hi++;
      const minPts = Math.max(5, win);
      while (hi - lo + 1 < minPts && (lo > 0 || hi < n - 1)) { if (lo > 0) lo--; if (hi < n - 1 && hi - lo + 1 < minPts) hi++; }
      const xs = [], ys = [];
      for (let i = lo; i <= hi; i++) { xs.push(vg[i]); ys.push(yv[i]); }
      const f = linfit(xs, ys);
      if (f.slope > 0) {
        const vint = -f.intercept / f.slope;
        const corr = (region !== 'saturation' && Number.isFinite(vdAbs)) ? vint - vdAbs / 2 : vint;
        elr = { vth: vint, vthCorrected: corr, x0: vg[k], y0: yv[k], slope: f.slope, intercept: f.intercept,
          usesSqrt: region === 'saturation', idx: k, lo, hi, points: xs.length, r2: f.r2 };
      }
    }
  }

  // ── CC (정전류법) ───────────────────────────────────
  const WL = (opt.W > 0 && opt.L > 0) ? opt.W / opt.L : NaN;
  const Icc = opt.Icc > 0 ? opt.Icc : (Number.isFinite(WL) ? 1e-7 * WL : 1e-7);
  const vthCC = findCrossing(vg, logId, Math.log10(Icc), { rising: true });

  // ── SD (이차미분법) ─────────────────────────────────
  // 2차 미분의 최대점. 잡음 바닥 위이고 gm 최대점보다 앞쪽만 후보로 본다
  const iSd = argmax(d2, (i) => clean(i) && i > 0 && i < n - 1 && (iGm < 0 || i <= iGm));
  const vthSD = iSd >= 0 ? vg[iSd] : NaN;

  // ── SS (아문턱 기울기) ───────────────────────────────
  const ss = extractSS(vg, id, logId, dlog, clean);

  // ── gm/Id (TCR) 법 ─────────────────────────────────
  // gm/Id 는 약반전에서 일정(q/nkT), 강반전으로 넘어가며 급격히 감소.
  // 그 감소가 가장 급한 지점(도함수 최소)을 Vth 로 본다.
  // gm/Id = d(ln Id)/dVg 이므로 log 미분에서 직접 얻는다 (지수 구간에서 다항식 미분보다 훨씬 정확)
  const tcr = dlog.map((d, i) => (clean(i) && Number.isFinite(d)) ? d * Math.LN10 : NaN);
  const dtcr = localPoly(vg, tcr.map(v => Number.isFinite(v) ? v : 0), { window: win, order: 2, deriv: 1 })
    .map((v, i) => Number.isFinite(tcr[i]) ? v : NaN);
  const iTcr = argmin(dtcr, (i) => Number.isFinite(tcr[i]) && i > 0 && i < n - 1);
  const vthTCR = iTcr >= 0 ? vg[iTcr] : NaN;
  // 약반전 평탄부 값: SS 맞춤 구간의 gm/Id 중앙값 → n = 1/(VT·gm/Id)
  const plateau = [];
  for (let i = ss.lo ?? -1; i >= 0 && i <= (ss.hi ?? -1); i++) if (Number.isFinite(tcr[i])) plateau.push(tcr[i]);
  plateau.sort((a, b) => a - b);
  const tcrMax = plateau.length ? plateau[Math.floor(plateau.length / 2)] : NaN;
  const nFromTCR = Number.isFinite(tcrMax) && tcrMax > 0 ? 1 / (tcrMax * VT) : NaN;

  // ── Ion / Ioff ──────────────────────────────────────
  const vgOn = Number.isFinite(opt.vgOn) ? opt.vgOn * sign : vg[n - 1];
  const vgOff = Number.isFinite(opt.vgOff) ? opt.vgOff * sign : vg[0];
  const ion = interp1(vg, id, vgOn);
  const ioffAt = interp1(vg, idAbs, vgOff);
  const ioffMin = Math.min(...idAbs.filter(v => Number.isFinite(v)));
  const onoff = ion > 0 && ioffAt > 0 ? ion / ioffAt : NaN;
  const onoffMin = ion > 0 && ioffMin > 0 ? ion / ioffMin : NaN;

  // ── 이동도 ───────────────────────────────────────────
  const Cox = oxideCapacitance(opt.tox, opt.er || 3.9);
  // 이동도에는 잡음에 덜 흔들리는 ELR 회귀 기울기(gm 최대 근방 평균 기울기)를 쓴다
  let mobility = { value: NaN, kind: region === 'saturation' ? 'sat' : 'lin', Cox, gmUsed: elr.slope };
  if (Number.isFinite(WL) && Number.isFinite(Cox)) {
    if (region === 'saturation') {
      if (Number.isFinite(elr.slope)) mobility.value = 2 * elr.slope * elr.slope / (WL * Cox);
    } else if (Number.isFinite(vdAbs) && vdAbs > 0 && Number.isFinite(elr.slope)) {
      mobility.value = elr.slope / (WL * Cox * vdAbs);
    }
  }

  return {
    type: norm.type, sign, n, window: win, region, vd: vdAbs, T, notes,
    vg, id, gm, d2, tcr, logId, dlog,
    vgOrig: vg.map(v => v * sign),
    gmMax: { value: gmMax, vg: iGm >= 0 ? vg[iGm] * sign : NaN, idx: iGm },
    vth: {
      ELR: elr.vthCorrected * sign, ELR_raw: elr.vth * sign,
      CC: vthCC * sign, SD: vthSD * sign, TCR: vthTCR * sign,
    },
    elr: { ...elr, vth: elr.vth * sign, vthCorrected: elr.vthCorrected * sign, x0: elr.x0 * sign },
    cc: { Icc, vth: vthCC * sign },
    sd: { vth: vthSD * sign, idx: iSd },
    tcr_m: { vth: vthTCR * sign, idx: iTcr, tcrMax, nFromTCR },
    ss: { ...ss, vgLo: ss.vgLo * sign, vgHi: ss.vgHi * sign },
    ionoff: { ion, ioff: ioffAt, ioffMin, ratio: onoff, ratioMin: onoffMin, vgOn: vgOn * sign, vgOff: vgOff * sign },
    mobility, Cox, WL,
  };
}

/** 잡음 바닥 추정: |Id| 하위 10% 의 중앙값 */
function noiseFloor(idAbs) {
  const v = idAbs.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const k = Math.max(1, Math.floor(v.length * 0.1));
  return v[Math.floor(k / 2)];
}

/**
 * SS 추출: log10(Id) 의 기울기가 가장 큰 지점 주변, 기울기가 최댓값의 70% 이상인 연속 구간을
 * 직선으로 맞춰 SS = 1/기울기 [V/dec] 를 얻는다.
 */
function extractSS(vg, id, logId, dlog, clean) {
  const n = vg.length;
  const ok = (i) => Number.isFinite(logId[i]) && clean(i) && Number.isFinite(dlog[i]);
  const iMax = argmax(dlog, (i) => ok(i));
  if (iMax < 0) return { value: NaN, slopeDec: NaN, vgLo: NaN, vgHi: NaN, idLo: NaN, idHi: NaN, fit: null, decades: 0, lo: -1, hi: -1 };
  const thr = dlog[iMax] * 0.7;
  let lo = iMax, hi = iMax;
  while (lo - 1 >= 0 && ok(lo - 1) && dlog[lo - 1] >= thr) lo--;
  while (hi + 1 < n && ok(hi + 1) && dlog[hi + 1] >= thr) hi++;
  // 너무 짧으면 최소 3점 확보
  while (hi - lo + 1 < 3 && (lo > 0 || hi < n - 1)) {
    if (lo > 0 && ok(lo - 1)) lo--; else if (hi < n - 1 && ok(hi + 1)) hi++; else break;
  }
  const xs = [], ys = [];
  for (let i = lo; i <= hi; i++) if (ok(i)) { xs.push(vg[i]); ys.push(logId[i]); }
  const f = linfit(xs, ys);
  const ssV = f.slope > 0 ? 1 / f.slope : NaN;
  return {
    value: ssV * 1e3, // mV/dec
    slopeDec: f.slope, fit: f, vgLo: vg[lo], vgHi: vg[hi], idLo: id[lo], idHi: id[hi], lo, hi,
    decades: (ys.length ? ys[ys.length - 1] - ys[0] : 0), points: xs.length, r2: f.r2,
  };
}

/**
 * 정·역 스윕 히스테리시스.
 * vg, id 는 측정 순서 그대로(정렬 전). 방향이 바뀌는 곳에서 나눠 각각 추출하고 Vth 차이를 낸다.
 */
export function extractHysteresis(vgRaw, idRaw, opt = {}) {
  const segs = splitSweeps(vgRaw, 4);
  if (segs.length < 2) return { available: false, segments: segs.length };
  const [a, b] = segs;
  const fwd = extractTransfer(vgRaw.slice(a[0], a[1]), idRaw.slice(a[0], a[1]), opt);
  const rev = extractTransfer(vgRaw.slice(b[0], b[1]), idRaw.slice(b[0], b[1]), opt);
  const dir = (seg) => Math.sign(vgRaw[seg[1] - 1] - vgRaw[seg[0]]);
  // 같은 전류에서의 Vg 차이 (정전류 기준) 과 ELR 기준
  const dCC = rev.vth.CC - fwd.vth.CC;
  const dELR = rev.vth.ELR - fwd.vth.ELR;
  // 겹치는 전류 구간에서 최대 수평 간격
  let maxShift = NaN, atLog = NaN;
  const fx = fwd.vg, fy = fwd.logId, rx = rev.vg, ry = rev.logId;
  const lvls = [];
  const lo = Math.max(minFinite(fy), minFinite(ry)), hi = Math.min(maxFinite(fy), maxFinite(ry));
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
    for (let k = 0; k <= 40; k++) lvls.push(lo + (hi - lo) * k / 40);
    for (const L of lvls) {
      const v1 = findCrossing(fx, fy, L), v2 = findCrossing(rx, ry, L);
      if (Number.isFinite(v1) && Number.isFinite(v2)) {
        const d = Math.abs(v2 - v1);
        if (!(d <= maxShift)) { maxShift = d; atLog = L; }
      }
    }
  }
  return {
    available: true, segments: segs.length,
    fwd, rev, fwdDir: dir(a), revDir: dir(b),
    dVthCC: dCC, dVthELR: dELR, maxShift, maxShiftAtId: Number.isFinite(atLog) ? Math.pow(10, atLog) : NaN,
  };
}

function minFinite(a) { let m = Infinity; for (const v of a) if (Number.isFinite(v) && v < m) m = v; return m; }
function maxFinite(a) { let m = -Infinity; for (const v of a) if (Number.isFinite(v) && v > m) m = v; return m; }

/**
 * 출력특성(Id–Vd) 추출. curves: [{vg, vd:[], id:[]}, ...]
 * 포화영역 직선 회귀로 gd, ro, λ, VA 를, 낮은 Vd 구간 기울기로 Ron 을 구한다.
 * opt.vdSatMin: 포화 회귀 시작 Vd (없으면 |Vg−Vth| 또는 Vd 범위의 상위 40%)
 * opt.vth: 알고 있는 Vth (Vd,sat 추정에 사용)
 */
export function extractOutput(curves, opt = {}) {
  const polarity = opt.polarity || 'auto';
  const results = [];
  for (const c of curves) {
    let sign = 1;
    if (polarity === 'p') sign = -1;
    else if (polarity === 'auto') {
      const k = argmax(c.id.map(Math.abs));
      if (k >= 0 && c.vd[k] < 0) sign = -1;
    }
    const s = sortByX(c.vd.map(v => v * sign), c.id.map(v => v * sign));
    let vd = s.x, id = s.y;
    const k = argmax(id.map(Math.abs));
    if (k >= 0 && id[k] < 0) id = id.map(v => -v);
    const vdMax = vd[vd.length - 1];
    let vStart;
    if (Number.isFinite(opt.vdSatMin)) vStart = Math.abs(opt.vdSatMin);
    else if (Number.isFinite(opt.vth)) vStart = Math.max(Math.abs(c.vg * sign - opt.vth * sign) * 1.1, vdMax * 0.4);
    else vStart = vdMax * 0.6;
    if (vStart >= vdMax) vStart = vdMax * 0.6;
    const xs = [], ys = [];
    for (let i = 0; i < vd.length; i++) if (vd[i] >= vStart && vd[i] > 0) { xs.push(vd[i]); ys.push(id[i]); }
    let sat = { gd: NaN, ro: NaN, lambda: NaN, VA: NaN, idSat0: NaN, fit: null, vStart, points: xs.length };
    if (xs.length >= 3) {
      const f = linfit(xs, ys);
      const gd = f.slope, id0 = f.intercept;
      sat = {
        gd, ro: gd !== 0 ? 1 / gd : Infinity, lambda: id0 > 0 ? gd / id0 : NaN,
        VA: gd > 0 ? id0 / gd : NaN, idSat0: id0, fit: f, vStart, points: xs.length, r2: f.r2,
      };
    }
    // Ron: Vd 가 작은 첫 구간(전체의 15% 이내, 최소 3점) 직선 회귀
    const lx = [], ly = [];
    for (let i = 0; i < vd.length; i++) if (vd[i] <= vdMax * 0.15 || lx.length < 3) { lx.push(vd[i]); ly.push(id[i]); }
    const lf = lx.length >= 2 ? linfit(lx, ly) : { slope: NaN };
    const ron = lf.slope > 0 ? 1 / lf.slope : NaN;
    results.push({ vg: c.vg, sign, vd, id, sat, ron, ronFit: lf, ronPoints: lx.length, idMax: id[id.length - 1] });
  }
  const lambdas = results.map(r => r.sat.lambda).filter(Number.isFinite);
  const lambdaMean = lambdas.length ? lambdas.reduce((a, b) => a + b, 0) / lambdas.length : NaN;
  return { curves: results, lambdaMean, count: results.length };
}
