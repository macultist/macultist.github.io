// synth.js — 알려진 파라미터로 합성(가짜) 측정 곡선을 만든다. 검증·예제용.
import { makeRng, gaussian, thermalVoltage, EPS0 } from './numeric.js';

/** EKV 식 보간 함수 F(x) = [ln(1+e^{x/2})]^2 (약반전↔강반전을 매끈하게 잇는다) */
function F(x) {
  const h = x / 2;
  const l = h > 30 ? h : Math.log1p(Math.exp(h));
  return l * l;
}

/** 잡음 추가: 상대 잡음(비율) + 절대 바닥 잡음 */
function addNoise(id, { rel = 0, floor = 1e-13, rng }) {
  return id.map(v => {
    const r = rel > 0 ? 1 + rel * gaussian(rng) : 1;
    const f = floor > 0 ? floor * gaussian(rng) : 0;
    return v * r + f;
  });
}

/**
 * MOSFET 전달특성 합성. 기본값은 W/L=10, tox=10 nm, µ=300 cm²/Vs, Vth=0.5 V, n=1.2, Vd=50 mV.
 * theta: 이동도 저하 계수 [1/V] (0이면 없음). lambda: 채널길이 변조.
 * hysteresis: 역스윕에서 Vth 를 이만큼 [V] 이동시켜 정·역 두 구간을 만든다.
 */
export function synthTransfer(p = {}) {
  const o = {
    W: 10e-6, L: 1e-6, tox: 10e-9, er: 3.9, mu: 300e-4, vth: 0.5, nf: 1.2, vd: 0.05,
    vgStart: -0.5, vgStop: 1.5, step: 0.01, T: 300, theta: 0, lambda: 0,
    noise: 0, floor: 1e-13, seed: 7, type: 'n', hysteresis: 0, ...p,
  };
  const VT = thermalVoltage(o.T);
  const Cox = EPS0 * o.er / o.tox;
  const rng = makeRng(o.seed);
  const beta = o.mu * Cox * (o.W / o.L);
  const Ispec = 2 * o.nf * beta * VT * VT;
  const model = (vg, vth) => {
    const vp = (vg - vth) / o.nf;
    const idc = Ispec * (F(vp / VT) - F((vp - o.vd) / VT));
    const deg = o.theta > 0 && vg > vth ? 1 / (1 + o.theta * (vg - vth)) : 1;
    return idc * deg * (1 + o.lambda * o.vd);
  };
  const vg = [], id = [];
  const npts = Math.round((o.vgStop - o.vgStart) / o.step);
  for (let k = 0; k <= npts; k++) { const v = o.vgStart + k * o.step; vg.push(v); id.push(model(v, o.vth)); }
  if (o.hysteresis) {
    for (let k = npts; k >= 0; k--) { const v = o.vgStart + k * o.step; vg.push(v); id.push(model(v, o.vth + o.hysteresis)); }
  }
  let idN = addNoise(id, { rel: o.noise, floor: o.floor, rng });
  let vgOut = vg;
  if (o.type === 'p') { vgOut = vg.map(v => -v); idN = idN.map(v => -v); }
  const ssTheory = o.nf * VT * Math.LN10 * 1e3; // mV/dec
  return { vg: vgOut, id: idN, vd: o.type === 'p' ? -o.vd : o.vd, params: { ...o, Cox, ssTheory } };
}

/** MOSFET 출력특성 합성: 여러 Vg 에 대해 Id–Vd */
export function synthOutput(p = {}) {
  const o = {
    W: 10e-6, L: 1e-6, tox: 10e-9, er: 3.9, mu: 300e-4, vth: 0.5, nf: 1.2, lambda: 0.05,
    vgList: [0.8, 1.1, 1.4, 1.7, 2.0], vdStart: 0, vdStop: 2.0, step: 0.02, T: 300,
    noise: 0, floor: 1e-13, seed: 11, type: 'n', ...p,
  };
  const VT = thermalVoltage(o.T);
  const Cox = EPS0 * o.er / o.tox;
  const rng = makeRng(o.seed);
  const beta = o.mu * Cox * (o.W / o.L);
  const Ispec = 2 * o.nf * beta * VT * VT;
  const curves = [];
  const npts = Math.round((o.vdStop - o.vdStart) / o.step);
  for (const vgv of o.vgList) {
    const vd = [], id = [];
    const vp = (vgv - o.vth) / o.nf;
    for (let k = 0; k <= npts; k++) {
      const v = o.vdStart + k * o.step;
      const idc = Ispec * (F(vp / VT) - F((vp - v) / VT)) * (1 + o.lambda * v);
      vd.push(v); id.push(idc);
    }
    const idN = addNoise(id, { rel: o.noise, floor: o.floor, rng });
    curves.push(o.type === 'p'
      ? { vg: -vgv, vd: vd.map(v => -v), id: idN.map(v => -v) }
      : { vg: vgv, vd, id: idN });
  }
  return { curves, params: { ...o, Cox } };
}

/** 다이오드 합성: I = Is[exp((V − I·Rs)/(n·VT)) − 1], 뉴턴법으로 I 를 푼다 */
export function synthDiode(p = {}) {
  const o = {
    Is: 1e-12, n: 1.5, Rs: 10, vStart: -1.0, vStop: 1.0, step: 0.01, T: 300,
    noise: 0, floor: 1e-13, seed: 5, ...p,
  };
  const VT = thermalVoltage(o.T);
  const rng = makeRng(o.seed);
  const v = [], i = [];
  const npts = Math.round((o.vStop - o.vStart) / o.step);
  let iPrev = 0;
  for (let k = 0; k <= npts; k++) {
    const V = o.vStart + k * o.step;
    let I = Math.max(iPrev, 0);
    // f(I) = Is(exp((V−I Rs)/(nVT)) − 1) − I = 0
    for (let it = 0; it < 100; it++) {
      const e = Math.exp((V - I * o.Rs) / (o.n * VT));
      const f = o.Is * (e - 1) - I;
      const df = -o.Is * e * o.Rs / (o.n * VT) - 1;
      const dI = f / df;
      I -= dI;
      if (Math.abs(dI) < 1e-15 * Math.max(1, Math.abs(I))) break;
    }
    iPrev = I;
    v.push(V); i.push(I);
  }
  const iN = addNoise(i, { rel: o.noise, floor: o.floor, rng });
  return { v, i: iN, params: { ...o } };
}

/** 합성 결과를 CSV 문자열로 */
export function toCSV(headers, cols) {
  const n = cols[0].length;
  const lines = [headers.join(',')];
  for (let k = 0; k < n; k++) lines.push(cols.map(c => Number(c[k]).toExponential(6)).join(','));
  return lines.join('\n');
}
