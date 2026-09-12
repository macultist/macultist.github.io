// Node 테스트: 알려진 파라미터의 합성 곡선에서 추출값이 허용 오차 안에 드는지 확인
// 실행: node devparam/test/run.mjs
import { synthTransfer, synthOutput, synthDiode } from '../src/js/synth.js';
import { extractTransfer, extractHysteresis, extractOutput } from '../src/js/mosfet.js';
import { extractDiode } from '../src/js/diode.js';
import { parseText, applyMapping, detectHeaderMapping, groupBy } from '../src/js/parse.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✔ ${name} ${detail}`); }
  else { fail++; console.log(`  ✘ ${name} ${detail}`); }
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const f = (v, d = 4) => Number.isFinite(v) ? v.toPrecision(d) : String(v);

// ── 1. 전달특성 (선형영역) 잡음 0 / 1 / 3 % ──
for (const noise of [0, 0.01, 0.03]) {
  const d = synthTransfer({ noise, seed: 3 });
  const r = extractTransfer(d.vg, d.id, { vd: d.vd, region: 'linear', W: d.params.W, L: d.params.L, tox: d.params.tox });
  console.log(`\n[전달특성 n형 선형, 잡음 ${noise * 100}%] Vth=0.5, SS이론=${f(d.params.ssTheory)} mV/dec`);
  check('ELR(−Vd/2 보정) ±20 mV', near(r.vth.ELR, 0.5, 0.02), `→ ${f(r.vth.ELR)} V`);
  check('SS ±5 mV/dec', near(r.ss.value, d.params.ssTheory, 5), `→ ${f(r.ss.value)} mV/dec (${r.ss.points}점)`);
  check('CC ±0.1 V', near(r.vth.CC, 0.5, 0.1), `→ ${f(r.vth.CC)} V (Icc=${r.cc.Icc})`);
  check('SD ±0.1 V', near(r.vth.SD, 0.5, 0.1), `→ ${f(r.vth.SD)} V`);
  check('gm/Id ±0.15 V', near(r.vth.TCR, 0.5, 0.15), `→ ${f(r.vth.TCR)} V`);
  check('이동도 ±10 %', near(r.mobility.value, d.params.mu, d.params.mu * 0.1), `→ ${f(r.mobility.value * 1e4)} cm²/Vs`);
  check('Ion/Ioff > 1e5', r.ionoff.ratio > 1e5, `→ ${f(r.ionoff.ratio, 3)}`);
  check('gm/Id 로 얻은 n ±0.1', near(r.tcr_m.nFromTCR, d.params.nf, 0.1), `→ ${f(r.tcr_m.nFromTCR)}`);
}

// ── 2. p형 ──
{
  const d = synthTransfer({ type: 'p', noise: 0.01, seed: 9 });
  const r = extractTransfer(d.vg, d.id, { vd: d.vd, region: 'linear' });
  console.log('\n[전달특성 p형]');
  check('극성 자동 판별 p', r.type === 'p');
  check('ELR ≈ −0.5 V', near(r.vth.ELR, -0.5, 0.02), `→ ${f(r.vth.ELR)} V`);
  check('SS', near(r.ss.value, d.params.ssTheory, 5), `→ ${f(r.ss.value)} mV/dec`);
}

// ── 3. 포화영역 ELR (sqrt) ──
{
  const d = synthTransfer({ vd: 1.5, noise: 0.01, seed: 4, vgStop: 2.0 });
  const r = extractTransfer(d.vg, d.id, { vd: d.vd, region: 'saturation', W: d.params.W, L: d.params.L, tox: d.params.tox });
  console.log('\n[전달특성 포화영역 √Id 외삽]');
  check('ELR(√Id) ±40 mV', near(r.vth.ELR, 0.5, 0.04), `→ ${f(r.vth.ELR)} V`);
  // EKV 합성 모델의 포화 전류는 β(Vg−Vth)²/(2n) 이므로 표준 제곱법칙 식으로 뽑은 이동도는 µ/n 이 된다
  const muExpect = d.params.mu / d.params.nf;
  check('포화 이동도 ≈ µ/n ±15 %', near(r.mobility.value, muExpect, muExpect * 0.15), `→ ${f(r.mobility.value * 1e4)} cm²/Vs (기대 ${f(muExpect * 1e4)})`);
}

// ── 4. 히스테리시스 ──
{
  const d = synthTransfer({ hysteresis: 0.05, noise: 0.01, seed: 12 });
  const h = extractHysteresis(d.vg, d.id, { vd: d.vd, region: 'linear' });
  console.log('\n[히스테리시스 50 mV]');
  check('정·역 구간 분리', h.available && h.segments === 2, `→ ${h.segments} 구간`);
  check('ΔVth(CC) ≈ 50 mV ±10', near(h.dVthCC, 0.05, 0.01), `→ ${f(h.dVthCC * 1e3)} mV`);
  check('ΔVth(ELR) ≈ 50 mV ±15', near(h.dVthELR, 0.05, 0.015), `→ ${f(h.dVthELR * 1e3)} mV`);
}

// ── 5. 출력특성 λ ──
{
  const d = synthOutput({ lambda: 0.05, noise: 0.01 });
  const r = extractOutput(d.curves, { vth: 0.5 });
  console.log('\n[출력특성 λ=0.05]');
  check('λ 평균 ±25 %', near(r.lambdaMean, 0.05, 0.0125), `→ ${f(r.lambdaMean)} 1/V`);
  for (const c of r.curves) check(`Vg=${c.vg} gd>0, Ron>0`, c.sat.gd > 0 && c.ron > 0, `gd=${f(c.sat.gd, 3)} S, Ron=${f(c.ron, 3)} Ω`);
}

// ── 6. 다이오드 ──
for (const noise of [0, 0.01, 0.03]) {
  const d = synthDiode({ Is: 1e-12, n: 1.5, Rs: 10, noise, seed: 21 });
  const r = extractDiode(d.v, d.i, {});
  console.log(`\n[다이오드 n=1.5, Is=1e-12, Rs=10 Ω, 잡음 ${noise * 100}%]`);
  check('n(기울기) ±3 %', near(r.expo.n, 1.5, 0.045), `→ ${f(r.expo.n)}`);
  check('Is ×/÷ 2 이내', r.expo.Is > 0.5e-12 && r.expo.Is < 2e-12, `→ ${f(r.expo.Is, 3)} A`);
  check('Rs(Cheung) ±20 %', near(r.cheung.Rs, 10, 2), `→ ${f(r.cheung.Rs)} Ω`);
  check('n(Cheung) ±15 %', near(r.cheung.n, 1.5, 0.225), `→ ${f(r.cheung.n)}`);
  check('Rs(편차법) ±20 %', near(r.rsDev, 10, 2), `→ ${f(r.rsDev)} Ω`);
  check('턴온(1 mA) 존재', Number.isFinite(r.turnOn.atIref), `→ ${f(r.turnOn.atIref)} V`);
  check('정류비 > 1e6', r.reverse.rectRatio > 1e6, `→ ${f(r.reverse.rectRatio, 3)}`);
}

// ── 7. 파서 ──
{
  console.log('\n[파서]');
  const txt = '# comment\nVg (V)\tId (A)\tVd (V)\n0.1\t1e-9\t0.05\n0.2\t2e-9\t0.05\n0.3\t3e-9\t0.05\n';
  const p = parseText(txt);
  check('탭 구분 + 헤더 인식', p.delimiter === '\t' && p.headers.length === 3 && p.rows.length === 3, JSON.stringify(p.headers));
  const m = detectHeaderMapping(p.headers, 'transfer');
  check('열 자동 매핑', m.vg === 0 && m.id === 1 && m.vd === 2, JSON.stringify(m));
  const cols = applyMapping(p, { vg: 0, id: 1, vd: 2 }, { v: 1, i: 1 });
  check('열 추출', cols.vg.length === 3 && cols.id[2] === 3e-9);
  const csv = 'V,I\n0,1e-12\n0.5,1e-6\n';
  const p2 = parseText(csv);
  check('쉼표 구분', p2.delimiter === ',' && p2.rows.length === 2);
  const ez = 'SetupTitle, Id-Vg\nDimension1, 3\nDataName, Vg, Id, Vd\nDataValue, 0.1, 1e-9, 0.05\nDataValue, 0.2, 2e-9, 0.05\nDataValue, 0.3, 3e-9, 0.05\n';
  const p3 = parseText(ez, { preset: 'b1500' });
  check('EasyEXPERT DataName/DataValue', p3.headers[0] === 'Vg' && p3.rows.length === 3, JSON.stringify(p3.headers));
  const p4 = parseText(ez);
  check('EasyEXPERT 자동 감지', p4.headers[0] === 'Vg' && p4.rows.length === 3);
  const semi = 'Vg;Id\n0,1;1e-9\n0,2;2e-9\n0,3;3e-9\n';
  const p5 = parseText(semi);
  check('세미콜론 + 소수점 쉼표', p5.rows[1][0] === 0.2 && p5.rows[1][1] === 2e-9, JSON.stringify(p5.rows[1]));
  const g = groupBy([0.05, 0.05, 1, 1], [0, 1, 2, 3]);
  check('그룹 나누기', g.length === 2 && g[0].idx.length === 2, JSON.stringify(g.map(x => x.key)));
}

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exitCode = fail ? 1 : 0;
