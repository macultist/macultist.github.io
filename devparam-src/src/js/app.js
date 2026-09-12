// app.js — 화면 연결: 파일 읽기 → 열 매핑 → 추출 → 그래프·표·리포트
import { parseText, applyMapping, detectHeaderMapping, groupBy, PRESETS, UNIT_V, UNIT_I } from './parse.js';
import { extractTransfer, extractHysteresis, extractOutput, oxideCapacitance } from './mosfet.js';
import { extractDiode } from './diode.js';
import { synthTransfer, synthOutput, synthDiode, toCSV } from './synth.js';
import { makePlot, svgToString, COLORS } from './plot.js';
import { buildMarkdown, buildCSV, copyText, downloadText } from './report.js';
import { EXPLAIN } from './explain.js';
import { fmt, fmtSI, splitSweeps, thermalVoltage } from './numeric.js';

const $ = (id) => document.getElementById(id);
const state = { mode: 'transfer', parsed: null, fileName: '', truth: null, rows: [], meta: {} };

// ── 프리셋 ───────────────────────────────────────────
for (const [k, p] of Object.entries(PRESETS)) {
  const o = document.createElement('option'); o.value = k; o.textContent = p.label; $('preset').appendChild(o);
}
$('preset').addEventListener('change', () => { $('presetHint').textContent = PRESETS[$('preset').value].hint; if (state.text) loadText(state.text, state.fileName); });
$('presetHint').textContent = PRESETS.auto.hint;

// ── 탭 ───────────────────────────────────────────────
document.querySelectorAll('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  renderParams();
  renderExamples();
  renderExplain();
  if (state.parsed) renderMapping();
  $('resCard').classList.add('hidden');
}

// ── 파일 입력 ─────────────────────────────────────────
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); });
$('parsePaste').addEventListener('click', () => { const t = $('paste').value; if (t.trim()) { state.truth = null; loadText(t, '붙여넣은 텍스트'); } });

function readFile(file) {
  const r = new FileReader();
  r.onload = () => { state.truth = null; $('paste').value = ''; loadText(String(r.result), file.name); };
  r.readAsText(file);
}

function loadText(text, name) {
  state.text = text; state.fileName = name;
  const parsed = parseText(text, { preset: $('preset').value });
  state.parsed = parsed;
  if (parsed.error || !parsed.rows.length) {
    $('fileInfo').innerHTML = `<span style="color:#8a1c1c">읽기 실패: ${parsed.error || '데이터 행이 없습니다.'}</span>`;
    $('mapping').innerHTML = '';
    return;
  }
  const dn = parsed.delimiter === '\t' ? '탭' : parsed.delimiter === 'ws' ? '공백' : `'${parsed.delimiter}'`;
  $('fileInfo').innerHTML = `<b>${escapeHtml(name)}</b> · ${parsed.rows.length}행 × ${parsed.headers.length}열 · 구분자 ${dn}${parsed.preset === 'b1500' ? ' · EasyEXPERT 형식' : ''}${parsed.skipped ? ` · 건너뛴 줄 ${parsed.skipped}` : ''}`;
  renderMapping();
  $('resCard').classList.add('hidden');
  $('mapCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 열 매핑 ──────────────────────────────────────────
const MAP_FIELDS = {
  transfer: [['vg', 'Vg (게이트 전압)', true], ['id', 'Id (드레인 전류)', true], ['vd', 'Vd (드레인 전압, 선택)', false]],
  output: [['vd', 'Vd (드레인 전압)', true], ['id', 'Id (드레인 전류)', true], ['vg', 'Vg (게이트 전압, 선택)', false]],
  diode: [['v', 'V (전압)', true], ['i', 'I (전류)', true]],
};
function renderMapping() {
  const p = state.parsed; if (!p) return;
  const auto = detectHeaderMapping(p.headers, state.mode);
  const box = $('mapping'); box.innerHTML = '';
  for (const [key, label, req] of MAP_FIELDS[state.mode]) {
    const l = document.createElement('label'); l.className = 'f';
    const sel = document.createElement('select'); sel.dataset.key = key;
    if (!req) sel.appendChild(new Option('(없음)', '-1'));
    p.headers.forEach((h, i) => sel.appendChild(new Option(`${i + 1}: ${h}`, String(i))));
    const v = auto[key] ?? -1;
    sel.value = String(v >= 0 ? v : (req ? 0 : -1));
    l.innerHTML = `<span>${label}</span>`; l.appendChild(sel); box.appendChild(l);
    sel.addEventListener('change', updateGroups);
  }
  updateGroups();
}
function currentMapping() {
  const m = {};
  $('mapping').querySelectorAll('select').forEach(s => { m[s.dataset.key] = Number(s.value); });
  return m;
}
function currentUnits() { return { v: UNIT_V[$('unitV').value], i: UNIT_I[$('unitI').value] }; }

/** Vd(전달) 또는 Vg(출력) 열이 있으면 곡선 그룹 선택 상자를 채운다 */
function updateGroups() {
  const p = state.parsed; if (!p) return;
  const m = currentMapping();
  const groupKey = state.mode === 'transfer' ? 'vd' : state.mode === 'output' ? 'vg' : null;
  const gb = $('groupBox');
  if (!groupKey || m[groupKey] < 0) { gb.classList.add('hidden'); state.groups = null; return; }
  const cols = applyMapping(p, m, currentUnits());
  const groups = groupBy(cols[groupKey], null, 1e-6);
  state.groups = { key: groupKey, groups, cols };
  const sel = $('groupSel'); sel.innerHTML = '';
  if (state.mode === 'transfer') {
    $('groupLabel').textContent = `분석할 Vd (곡선 ${groups.length}개)`;
    groups.forEach((g, i) => sel.appendChild(new Option(`Vd = ${fmt(g.key, 4)} V (${g.idx.length}점)`, String(i))));
    // 기본: |Vd| 가 가장 작은 곡선
    let best = 0; groups.forEach((g, i) => { if (Math.abs(g.key) < Math.abs(groups[best].key)) best = i; });
    sel.value = String(best);
    gb.classList.remove('hidden');
  } else {
    $('groupLabel').textContent = `Vg 곡선 ${groups.length}개 (모두 분석)`;
    groups.forEach((g, i) => sel.appendChild(new Option(`Vg = ${fmt(g.key, 4)} V (${g.idx.length}점)`, String(i))));
    gb.classList.remove('hidden');
    sel.disabled = true;
  }
  if (state.mode === 'transfer') sel.disabled = false;
}

// ── 파라미터 입력 ─────────────────────────────────────
const PARAM_DEFS = {
  transfer: [
    ['polarity', '소자 종류', 'select', 'auto', [['auto', '자동'], ['n', 'n형'], ['p', 'p형']]],
    ['region', '동작 영역', 'select', 'auto', [['auto', '자동 (|Vd| ≤ 0.2 V 면 선형)'], ['linear', '선형 (작은 Vd)'], ['saturation', '포화 (큰 Vd, √Id 외삽)']]],
    ['vd', 'Vd [V] (Vd 열이 없을 때)', 'number', '0.05'],
    ['W', 'W [µm]', 'number', ''], ['L', 'L [µm]', 'number', ''], ['tox', 'tox [nm]', 'number', ''],
    ['er', '산화막 εr', 'number', '3.9'], ['T', '온도 [K]', 'number', '300'],
    ['Icc', 'CC 기준 전류 [A] (빈칸=100 nA·W/L)', 'number', ''],
    ['window', '평활 창 (점 수, 0=자동)', 'number', '0'],
    ['elrFrac', 'ELR 회귀 구간 (gm,max 대비 비율)', 'number', '0.8'],
    ['vgOn', 'Ion 읽을 Vg [V] (빈칸=끝)', 'number', ''], ['vgOff', 'Ioff 읽을 Vg [V] (빈칸=시작)', 'number', ''],
  ],
  output: [
    ['polarity', '소자 종류', 'select', 'auto', [['auto', '자동'], ['n', 'n형'], ['p', 'p형']]],
    ['vth', 'Vth [V] (알면 입력, 포화 시작 추정용)', 'number', ''],
    ['vdSatMin', '포화 회귀 시작 Vd [V] (빈칸=자동)', 'number', ''],
  ],
  diode: [
    ['T', '온도 [K]', 'number', '300'],
    ['Iref', '턴온 기준 전류 [mA]', 'number', '1'],
    ['window', '평활 창 (점 수, 0=자동)', 'number', '0'],
    ['polarity', '극성', 'select', 'auto', [['auto', '자동'], ['forward', '그대로'], ['flip', '부호 뒤집기']]],
  ],
};
function renderParams() {
  const box = $('params'); box.innerHTML = '';
  const g = document.createElement('div'); g.className = 'grid3';
  for (const [key, label, type, def, opts] of PARAM_DEFS[state.mode]) {
    const l = document.createElement('label'); l.className = 'f'; l.innerHTML = `<span>${label}</span>`;
    let inp;
    if (type === 'select') { inp = document.createElement('select'); for (const [v, t] of opts) inp.appendChild(new Option(t, v)); inp.value = def; }
    else { inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.value = def; inp.placeholder = '—'; }
    inp.id = 'p_' + key; l.appendChild(inp); g.appendChild(l);
  }
  box.appendChild(g);
  if (state.mode === 'transfer') box.insertAdjacentHTML('beforeend', '<p class="hint">W·L·tox 를 넣으면 이동도와 Cox 가 계산됩니다. 정·역 스윕이 한 파일에 있으면 히스테리시스를 자동으로 구합니다.</p>');
  if (state.mode === 'output') box.insertAdjacentHTML('beforeend', '<p class="hint">Vg 열이 있으면 Vg 값마다 곡선을 나눠 각각 gd·λ·Ron 을 구합니다.</p>');
}
function P(key) { const e = $('p_' + key); if (!e) return undefined; if (e.tagName === 'SELECT') return e.value; const v = parseFloat(String(e.value).replace(',', '.')); return Number.isFinite(v) ? v : NaN; }

// ── 예제(합성) 데이터 ──────────────────────────────────
const EXAMPLES = {
  transfer: [
    ['n-MOSFET 전달 (선형, Vd=50 mV)', () => synthTransfer({ noise: exNoise(), seed: 3 }), (d) => `Vg,Id,Vd\n${rows3(d.vg, d.id, d.vd)}`, 'Vth 0.5 V · n 1.2 (SS 71.4 mV/dec) · µ 300 cm²/Vs · W/L 10/1 µm · tox 10 nm'],
    ['정·역 스윕 (히스테리시스 50 mV)', () => synthTransfer({ noise: exNoise(), seed: 12, hysteresis: 0.05 }), (d) => `Vg,Id,Vd\n${rows3(d.vg, d.id, d.vd)}`, 'Vth 0.5 V(정방향) / 0.55 V(역방향)'],
    ['p-MOSFET 전달 (이동도 저하 포함)', () => synthTransfer({ noise: exNoise(), seed: 9, type: 'p', theta: 0.3 }), (d) => `Vg,Id,Vd\n${rows3(d.vg, d.id, d.vd)}`, 'Vth −0.5 V · θ 0.3 /V · Vd −50 mV'],
    ['여러 Vd 포함 (0.05 / 0.5 / 1.5 V)', () => multiVd(), (d) => `GateV,DrainI,DrainV\n${rows3(d.vg, d.id, d.vdArr)}`, 'Vth 0.5 V · Keithley 식 헤더 이름'],
  ],
  output: [
    ['n-MOSFET 출력 (λ=0.05 /V)', () => synthOutput({ noise: exNoise(), lambda: 0.05 }), outCSV, 'Vth 0.5 V · λ 0.05 /V · Vg 0.8~2.0 V'],
    ['p-MOSFET 출력 (λ=0.1 /V)', () => synthOutput({ noise: exNoise(), lambda: 0.1, type: 'p', seed: 4 }), outCSV, 'Vth −0.5 V · λ 0.1 /V'],
  ],
  diode: [
    ['Si 다이오드 (n=1.5, Rs=10 Ω)', () => synthDiode({ noise: exNoise(), n: 1.5, Rs: 10, Is: 1e-12 }), (d) => `V,I\n${rows2(d.v, d.i)}`, 'n 1.5 · Is 1e-12 A · Rs 10 Ω'],
    ['쇼트키 다이오드 (n=1.05, Rs=3 Ω)', () => synthDiode({ noise: exNoise(), n: 1.05, Rs: 3, Is: 1e-8, vStop: 0.7, seed: 8 }), (d) => `V,I\n${rows2(d.v, d.i)}`, 'n 1.05 · Is 1e-8 A · Rs 3 Ω'],
    ['B1500 EasyEXPERT 형식 예제', () => synthDiode({ noise: exNoise(), n: 1.8, Rs: 25, Is: 1e-11, seed: 2 }), (d) => `SetupTitle, Diode IV\nPrimarySetupTitle, IV\nDimension1, ${d.v.length}\nDataName, V, I\n${d.v.map((v, k) => `DataValue, ${v.toExponential(6)}, ${d.i[k].toExponential(6)}`).join('\n')}`, 'n 1.8 · Is 1e-11 A · Rs 25 Ω'],
  ],
};
const exNoise = () => parseFloat($('exNoise').value) || 0;
const rows2 = (a, b) => a.map((v, k) => `${v.toExponential(6)},${b[k].toExponential(6)}`).join('\n');
const rows3 = (a, b, c) => a.map((v, k) => `${v.toExponential(6)},${b[k].toExponential(6)},${(Array.isArray(c) ? c[k] : c).toExponential(6)}`).join('\n');
function outCSV(d) {
  const lines = ['Vd,Id,Vg'];
  for (const c of d.curves) c.vd.forEach((v, k) => lines.push(`${v.toExponential(6)},${c.id[k].toExponential(6)},${c.vg.toExponential(6)}`));
  return lines.join('\n');
}
function multiVd() {
  const vg = [], id = [], vdArr = [];
  for (const vd of [0.05, 0.5, 1.5]) {
    const d = synthTransfer({ noise: exNoise(), seed: 5 + Math.round(vd * 10), vd });
    vg.push(...d.vg); id.push(...d.id); vdArr.push(...d.vg.map(() => vd));
  }
  return { vg, id, vdArr, params: { vth: 0.5 } };
}
function renderExamples() {
  const box = $('examples'); box.innerHTML = '';
  EXAMPLES[state.mode].forEach(([label, gen, toText, truth]) => {
    const b = document.createElement('button'); b.className = 'btn small ex'; b.textContent = label;
    b.addEventListener('click', () => {
      const d = gen(); const text = toText(d);
      $('paste').value = text; state.truth = truth;
      loadText(text, `예제: ${label}`);
      if (state.mode === 'transfer' && /Keithley/.test(truth)) { /* 헤더 자동 매핑 확인용 */ }
      setTimeout(run, 50);
    });
    box.appendChild(b);
  });
}

// ── 실행 ─────────────────────────────────────────────
$('run').addEventListener('click', run);
function run() {
  const p = state.parsed;
  if (!p) { $('runHint').textContent = '먼저 파일을 올리거나 예제를 고르세요.'; return; }
  $('runHint').textContent = '';
  const m = currentMapping();
  const cols = applyMapping(p, m, currentUnits());
  try {
    if (state.mode === 'transfer') runTransfer(cols);
    else if (state.mode === 'output') runOutput(cols);
    else runDiode(cols);
    $('resCard').classList.remove('hidden');
    $('resCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    $('notes').innerHTML = `<div class="note err">계산 중 오류: ${escapeHtml(e.message)}</div>`;
    $('resCard').classList.remove('hidden');
  }
}

function baseOpts() {
  const o = {};
  for (const [key] of PARAM_DEFS[state.mode]) o[key] = P(key);
  return o;
}

// ── 전달특성 ──────────────────────────────────────────
function runTransfer(cols) {
  const o = baseOpts();
  let vg = cols.vg, id = cols.id, vd = o.vd;
  let groupInfo = '';
  if (cols.vd) {
    const gi = Number($('groupSel').value) || 0;
    const groups = groupBy(cols.vd, null, 1e-6);
    const g = groups[gi];
    vg = g.idx.map(i => cols.vg[i]); id = g.idx.map(i => cols.id[i]); vd = g.key;
    groupInfo = `Vd = ${fmt(vd, 4)} V 곡선 (${groups.length}개 중)`;
  }
  const region = o.region === 'auto' ? (Math.abs(vd) <= 0.2 ? 'linear' : 'saturation') : o.region;
  const opt = {
    vd, region, polarity: o.polarity, T: o.T || 300, er: o.er || 3.9,
    W: o.W > 0 ? o.W * 1e-6 : NaN, L: o.L > 0 ? o.L * 1e-6 : NaN, tox: o.tox > 0 ? o.tox * 1e-9 : NaN,
    Icc: o.Icc > 0 ? o.Icc : NaN, window: o.window > 2 ? (o.window | 1) : undefined, elrFrac: o.elrFrac,
    vgOn: o.vgOn, vgOff: o.vgOff,
  };
  const segs = splitSweeps(vg, 4);
  const hys = segs.length >= 2 ? extractHysteresis(vg, id, opt) : { available: false };
  const main = hys.available ? hys.fwd : extractTransfer(vg, id, opt);
  const r = main;
  const s = r.sign;
  const notes = [];
  if (groupInfo) notes.push(groupInfo);
  notes.push(`${r.type === 'p' ? 'p형' : 'n형'}으로 판단 · ${region === 'linear' ? '선형영역' : '포화영역(√Id 외삽)'} · 평활 창 ${r.window}점 · ${r.n}점 사용${hys.available ? ' · 정·역 스윕 감지(정방향 기준으로 표시)' : ''}`);
  notes.push(...r.notes);
  if (region === 'linear' && Math.abs(vd) > 0.3) notes.push('선형영역으로 계산했지만 |Vd| 가 큽니다. 포화영역을 고르는 것이 맞을 수 있습니다.');
  if (r.ss.decades < 2) notes.push(`SS 맞춤 구간이 ${fmt(r.ss.decades, 2)} decade 뿐이라 신뢰도가 낮습니다.`);
  renderNotes(notes);

  // 결과 행
  const rows = [];
  const G = 'Vth';
  rows.push({ group: G, name: '선형외삽 ELR', value: r.vth.ELR, unit: 'V', note: region === 'linear' ? `절편 ${fmt(r.vth.ELR_raw)} V − Vd/2 · 회귀 ${r.elr.points}점 (Vg ${fmt(r.vg[r.elr.lo] * s, 3)}~${fmt(r.vg[r.elr.hi] * s, 3)} V)` : `√Id 절편 · 회귀 ${r.elr.points}점` });
  rows.push({ group: G, name: '정전류 CC', value: r.vth.CC, unit: 'V', note: `Icc = ${fmtSI(r.cc.Icc, 'A')}` });
  rows.push({ group: G, name: '이차미분 SD', value: r.vth.SD, unit: 'V', note: region === 'linear' ? 'd²Id/dVg² 최대점 · 잡음에 민감' : 'd²(√Id)/dVg² 최대점 · 잡음에 민감' });
  rows.push({ group: G, name: 'gm/Id (TCR)', value: r.vth.TCR, unit: 'V', note: `약반전 gm/Id ≈ ${fmt(r.tcr_m.tcrMax, 3)} /V → n ≈ ${fmt(r.tcr_m.nFromTCR, 3)}` });
  const vths = Object.values(r.vth).filter(Number.isFinite);
  if (vths.length >= 2) rows.push({ group: G, name: '기법 간 퍼짐 (최대−최소)', value: Math.max(...vths) - Math.min(...vths), unit: 'V', note: '클수록 직렬저항·이동도 저하·잡음 영향 의심' });
  rows.push({ group: '아문턱', name: 'SS', value: r.ss.value, unit: 'mV/dec', note: `맞춤 Vg ${fmt(r.ss.vgLo, 3)}~${fmt(r.ss.vgHi, 3)} V · ${fmt(r.ss.decades, 2)} dec · ${r.ss.points}점 · R² ${fmt(r.ss.r2, 4)}` });
  rows.push({ group: '아문턱', name: 'SS 로 본 n = SS/(VT·ln10)', value: r.ss.value / (thermalVoltage(r.T) * Math.LN10 * 1e3), unit: '', note: `T = ${r.T} K` });
  rows.push({ group: '전류', name: 'Ion', value: r.ionoff.ion, unit: 'A', note: `Vg = ${fmt(r.ionoff.vgOn, 3)} V` });
  rows.push({ group: '전류', name: 'Ioff', value: r.ionoff.ioff, unit: 'A', note: `Vg = ${fmt(r.ionoff.vgOff, 3)} V · |Id| 최솟값 ${fmtSI(r.ionoff.ioffMin, 'A')}` });
  rows.push({ group: '전류', name: 'Ion/Ioff', value: r.ionoff.ratio, unit: '', note: `|Id| 최솟값 기준 ${fmt(r.ionoff.ratioMin, 3)}` });
  rows.push({ group: '전류', name: 'gm,max', value: r.gmMax.value, unit: 'S', note: `Vg = ${fmt(r.gmMax.vg, 3)} V · 회귀 기울기 ${fmtSI(r.elr.slope, region === 'linear' ? 'S' : '√A/V')}` });
  if (Number.isFinite(r.Cox)) rows.push({ group: '이동도', name: 'Cox', value: r.Cox * 1e-4, unit: 'F/cm²', note: `tox ${fmt(opt.tox * 1e9, 3)} nm · εr ${opt.er}` });
  rows.push({ group: '이동도', name: region === 'linear' ? 'µFE (선형)' : 'µ (포화)', value: Number.isFinite(r.mobility.value) ? r.mobility.value * 1e4 : NaN, unit: 'cm²/V·s', note: Number.isFinite(r.mobility.value) ? (region === 'linear' ? 'gm·L/(W·Cox·Vd)' : '2L/(W·Cox)·(d√Id/dVg)²') : 'W, L, tox 입력 필요' });
  if (hys.available) {
    rows.push({ group: '히스테리시스', name: 'ΔVth (CC, 역−정)', value: hys.dVthCC, unit: 'V', note: `정 ${fmt(hys.fwd.vth.CC)} V → 역 ${fmt(hys.rev.vth.CC)} V` });
    rows.push({ group: '히스테리시스', name: 'ΔVth (ELR, 역−정)', value: hys.dVthELR, unit: 'V', note: `정 ${fmt(hys.fwd.vth.ELR)} V → 역 ${fmt(hys.rev.vth.ELR)} V` });
    rows.push({ group: '히스테리시스', name: '최대 수평 간격', value: hys.maxShift, unit: 'V', note: `Id ≈ ${fmtSI(hys.maxShiftAtId, 'A')} 에서` });
    rows.push({ group: '히스테리시스', name: 'SS (정 / 역)', value: `${fmt(hys.fwd.ss.value, 4)} / ${fmt(hys.rev.ss.value, 4)}`, unit: 'mV/dec', note: '' });
  }
  state.rows = rows;
  state.meta = { title: 'MOSFET 전달특성 추출 결과', source: state.fileName, lines: [`Vd = ${fmt(vd, 4)} V · ${region} · ${r.type}형 · 평활 창 ${r.window}`, ...(state.truth ? [`합성 정답: ${state.truth}`] : [])] };
  renderTable(rows);

  // 그래프
  const vgo = r.vgOrig;
  const plots = [];
  const ccColor = COLORS[3], ssColor = COLORS[2];
  plots.push(makePlot({
    title: 'log|Id| – Vg (SS 맞춤, CC 기준선)', xLabel: 'Vg [V]', yLabel: '|Id| [A]', yScale: 'log',
    series: [{ name: '측정', x: vgo, y: r.id.map(Math.abs), type: 'both' },
      ...(hys.available ? [{ name: '역방향', x: hys.rev.vgOrig, y: hys.rev.id.map(Math.abs), type: 'line', color: COLORS[1] }] : []),
      ...(r.ss.fit ? [{ name: `SS 맞춤 ${fmt(r.ss.value, 3)} mV/dec`, x: [r.vg[r.ss.lo] - 0.1, r.vg[r.ss.hi] + 0.1].map(v => v * s), y: [r.vg[r.ss.lo] - 0.1, r.vg[r.ss.hi] + 0.1].map(v => Math.pow(10, r.ss.fit.slope * v + r.ss.fit.intercept)), type: 'line', color: ssColor, dash: '6 4', width: 2 }] : [])],
    hlines: [{ y: r.cc.Icc, label: `Icc = ${fmtSI(r.cc.Icc, 'A')}`, color: ccColor }],
    markers: Number.isFinite(r.vth.CC) ? [{ x: r.vth.CC, y: r.cc.Icc, label: `Vth,CC ${fmt(r.vth.CC, 3)} V`, color: ccColor }] : [],
  }));
  const yv = region === 'linear' ? r.id : r.id.map(v => v > 0 ? Math.sqrt(v) : 0);
  const xl = r.elr.lo >= 0 ? r.vg[r.elr.lo] : NaN, xh = r.elr.hi >= 0 ? r.vg[r.elr.hi] : NaN;
  const lineX = [r.elr.vth / s, r.vg[r.n - 1]];
  const elrRows = Number.isFinite(r.elr.slope) ? [{ name: 'ELR 직선', x: lineX.map(v => v * s), y: lineX.map(v => r.elr.slope * v + r.elr.intercept), type: 'line', color: COLORS[1], dash: '6 4', width: 2 }] : [];
  plots.push(makePlot({
    title: region === 'linear' ? 'Id – Vg (선형 눈금, ELR 접선)' : '√Id – Vg (ELR 접선)', xLabel: 'Vg [V]', yLabel: region === 'linear' ? 'Id [A]' : '√Id [√A]',
    series: [{ name: '측정', x: vgo, y: yv, type: 'both' }, ...elrRows,
      ...(r.elr.lo >= 0 ? [{ name: '회귀 구간', x: r.vg.slice(r.elr.lo, r.elr.hi + 1).map(v => v * s), y: yv.slice(r.elr.lo, r.elr.hi + 1), type: 'points', color: COLORS[1], r: 3 }] : [])],
    markers: Number.isFinite(r.vth.ELR_raw) ? [{ x: r.vth.ELR_raw, y: 0, label: `절편 ${fmt(r.vth.ELR_raw, 3)} V`, color: COLORS[1] }] : [],
    yRange: [0, Math.max(...yv.filter(Number.isFinite)) * 1.05],
  }));
  const gmMaxV = Math.max(...r.gm.filter(Number.isFinite));
  const d2Max = Math.max(...r.d2.map((v, i) => Number.isFinite(v) && i > 0 ? Math.abs(v) : 0));
  const tcrMax = Math.max(...r.tcr.filter(Number.isFinite));
  plots.push(makePlot({
    title: '정규화 gm · d²Id/dVg² · gm/Id (SD, TCR 위치)', xLabel: 'Vg [V]', yLabel: '최댓값 = 1 로 정규화',
    series: [{ name: 'gm', x: vgo, y: r.gm.map(v => v / gmMaxV) },
      { name: 'd²Id/dVg²', x: vgo, y: r.d2.map(v => v / d2Max), color: COLORS[1] },
      { name: 'gm/Id', x: vgo, y: r.tcr.map(v => v / tcrMax), color: COLORS[3] }],
    vlines: [...(Number.isFinite(r.vth.SD) ? [{ x: r.vth.SD, label: `SD ${fmt(r.vth.SD, 3)} V`, color: COLORS[1] }] : []),
      ...(Number.isFinite(r.vth.TCR) ? [{ x: r.vth.TCR, label: `TCR ${fmt(r.vth.TCR, 3)} V`, color: COLORS[3] }] : []),
      ...(Number.isFinite(r.gmMax.vg) ? [{ x: r.gmMax.vg, label: 'gm,max', color: COLORS[0] }] : [])],
    yRange: [-1.1, 1.1], legend: 'top',
  }));
  renderPlots(plots);

  // 여러 Vd 곡선이 있으면 Vd 별 요약표 추가
  let extra = '';
  if (cols.vd) {
    const groups = groupBy(cols.vd, null, 1e-6);
    if (groups.length > 1) {
      const trs = groups.map(g => {
        const vg2 = g.idx.map(i => cols.vg[i]), id2 = g.idx.map(i => cols.id[i]);
        const reg2 = o.region === 'auto' ? (Math.abs(g.key) <= 0.2 ? 'linear' : 'saturation') : o.region;
        const rr = extractTransfer(vg2, id2, { ...opt, vd: g.key, region: reg2 });
        return `<tr><td>${fmt(g.key, 4)}</td><td class="n">${reg2 === 'linear' ? '선형' : '포화'}</td><td class="v">${fmt(rr.vth.ELR)}</td><td class="v">${fmt(rr.vth.CC)}</td><td class="v">${fmt(rr.vth.SD)}</td><td class="v">${fmt(rr.vth.TCR)}</td><td class="v">${fmt(rr.ss.value)}</td><td class="v">${fmt(rr.ionoff.ratio, 3)}</td></tr>`;
      }).join('');
      extra += `<h3 style="font-size:14px;margin:18px 0 6px">Vd 별 비교 (${groups.length}개 곡선)</h3><div class="tblwrap"><table class="res"><tr><th>Vd [V]</th><th>영역</th><th>Vth ELR</th><th>Vth CC</th><th>Vth SD</th><th>Vth TCR</th><th>SS [mV/dec]</th><th>Ion/Ioff</th></tr>${trs}</table></div><p class="hint">Vd 가 커질수록 Vth 가 줄어들면 DIBL(드레인 전압이 문턱을 낮추는 단채널 효과)을 의심할 수 있습니다.</p>`;
    }
  }
  $('extra').innerHTML = extra;
}

// ── 출력특성 ──────────────────────────────────────────
function runOutput(cols) {
  const o = baseOpts();
  let curves;
  if (cols.vg) {
    const groups = groupBy(cols.vg, null, 1e-6);
    curves = groups.map(g => ({ vg: g.key, vd: g.idx.map(i => cols.vd[i]), id: g.idx.map(i => cols.id[i]) }));
  } else curves = [{ vg: NaN, vd: cols.vd, id: cols.id }];
  const r = extractOutput(curves, { polarity: o.polarity, vth: o.vth, vdSatMin: o.vdSatMin });
  const notes = [`곡선 ${r.count}개 · 포화 회귀 시작: ${Number.isFinite(o.vdSatMin) ? `지정 ${fmt(o.vdSatMin)} V` : Number.isFinite(o.vth) ? 'max(1.1·|Vg−Vth|, Vd 범위의 40%)' : 'Vd 범위의 상위 40%'}`];
  renderNotes(notes);
  const rows = [];
  for (const c of r.curves) {
    const G = Number.isFinite(c.vg) ? `Vg = ${fmt(c.vg, 3)} V` : '곡선';
    rows.push({ group: G, name: 'gd (출력 컨덕턴스)', value: c.sat.gd, unit: 'S', note: `회귀 Vd ≥ ${fmt(c.sat.vStart, 3)} V · ${c.sat.points}점 · R² ${fmt(c.sat.r2, 4)}` });
    rows.push({ group: G, name: 'ro = 1/gd', value: c.sat.ro, unit: 'Ω', note: '' });
    rows.push({ group: G, name: 'λ (채널길이 변조)', value: c.sat.lambda, unit: '1/V', note: `Id,sat(Vd→0 외삽) = ${fmtSI(c.sat.idSat0, 'A')}` });
    rows.push({ group: G, name: 'VA = 1/λ', value: c.sat.VA, unit: 'V', note: 'Early 전압' });
    rows.push({ group: G, name: 'Ron (선형영역)', value: c.ron, unit: 'Ω', note: `첫 ${c.ronPoints}점 기울기` });
    rows.push({ group: G, name: 'Id 최대', value: c.idMax * c.sign, unit: 'A', note: `Vd = ${fmt(c.vd[c.vd.length - 1] * c.sign, 3)} V` });
  }
  if (r.count > 1) rows.push({ group: '요약', name: 'λ 평균', value: r.lambdaMean, unit: '1/V', note: `${r.count}개 곡선` });
  state.rows = rows;
  state.meta = { title: 'MOSFET 출력특성 추출 결과', source: state.fileName, lines: state.truth ? [`합성 정답: ${state.truth}`] : [] };
  renderTable(rows);
  const series = [], lines = [];
  r.curves.forEach((c, i) => {
    const sg = c.sign;
    series.push({ name: Number.isFinite(c.vg) ? `Vg ${fmt(c.vg, 3)} V` : '측정', x: c.vd.map(v => v * sg), y: c.id.map(v => v * sg), type: 'both', color: COLORS[i % COLORS.length] });
    if (c.sat.fit) {
      const x1 = 0, x2 = c.vd[c.vd.length - 1];
      lines.push({ x1: x1 * sg, y1: (c.sat.fit.intercept) * sg, x2: x2 * sg, y2: (c.sat.fit.slope * x2 + c.sat.fit.intercept) * sg, color: COLORS[i % COLORS.length], dash: '5 4', width: 1.3 });
    }
  });
  const plots = [makePlot({ title: 'Id – Vd 와 포화영역 회귀선 (Vd=0 까지 연장)', xLabel: 'Vd [V]', yLabel: 'Id [A]', series, lines, legend: 'top' })];
  if (r.curves.length > 1 && r.curves.every(c => Number.isFinite(c.vg))) {
    plots.push(makePlot({ title: 'λ 와 Ron 의 Vg 의존성', xLabel: 'Vg [V]', yLabel: 'λ [1/V]  (점: Ron/최대 Ron)', series: [
      { name: 'λ', x: r.curves.map(c => c.vg), y: r.curves.map(c => c.sat.lambda), type: 'both' },
      { name: 'Ron (정규화)', x: r.curves.map(c => c.vg), y: (() => { const m = Math.max(...r.curves.map(c => c.ron).filter(Number.isFinite)); return r.curves.map(c => c.ron / m * Math.max(...r.curves.map(c => c.sat.lambda).filter(Number.isFinite))); })(), type: 'both', color: COLORS[1] },
    ], legend: 'top' }));
  }
  renderPlots(plots);
  $('extra').innerHTML = '';
}

// ── 다이오드 ──────────────────────────────────────────
function runDiode(cols) {
  const o = baseOpts();
  const r = extractDiode(cols.v, cols.i, { T: o.T || 300, Iref: o.Iref > 0 ? o.Iref * 1e-3 : 1e-3, window: o.window > 2 ? (o.window | 1) : undefined, polarity: o.polarity });
  if (!r.ok) { renderNotes([r.error]); state.rows = []; renderTable([]); renderPlots([]); return; }
  const notes = [`순방향 ${r.v.length}점 사용 · T = ${r.T} K (VT = ${fmt(r.VT * 1e3, 4)} mV) · 평활 창 ${r.window}점${r.sign < 0 ? ' · 극성을 뒤집어 계산' : ''}`, ...r.notes];
  if (Number.isFinite(r.cheung.Rs) && Number.isFinite(r.rsDev) && Math.abs(r.cheung.Rs - r.rsDev) > 0.3 * Math.max(Math.abs(r.cheung.Rs), Math.abs(r.rsDev))) notes.push('두 방법의 Rs 가 30% 넘게 다릅니다. 고전류 구간 자료가 부족하거나 자기발열이 있을 수 있습니다.');
  renderNotes(notes);
  const rows = [
    { group: '이상계수', name: 'n (ln I 기울기)', value: r.expo.n, unit: '', note: `맞춤 V ${fmt(r.expo.vLo, 3)}~${fmt(r.expo.vHi, 3)} V · ${r.expo.points}점 · R² ${fmt(r.expo.r2, 5)}` },
    { group: '이상계수', name: 'n (Cheung 절편)', value: r.cheung.n, unit: '', note: `I ${fmtSI(r.cheung.iLo, 'A')}~${fmtSI(r.cheung.iHi, 'A')} · ${r.cheung.points}점` },
    { group: '포화전류', name: 'Is', value: r.expo.Is, unit: 'A', note: 'ln I 절편' },
    { group: '직렬저항', name: 'Rs (Cheung)', value: r.cheung.Rs, unit: 'Ω', note: 'dV/dlnI – I 기울기' },
    { group: '직렬저항', name: 'Rs (편차법)', value: r.rsDev, unit: 'Ω', note: '상위 전류 20% 점 중앙값' },
    { group: '턴온', name: `V @ ${fmtSI(r.turnOn.Iref, 'A')}`, value: r.turnOn.atIref, unit: 'V', note: '기준 전류 정의' },
    { group: '턴온', name: 'V (고전류 직선 외삽)', value: r.turnOn.extrap, unit: 'V', note: '전류 상위 30% 직선의 I=0 절편' },
    { group: '턴온', name: `V @ 1% Imax (${fmtSI(r.iMax * 0.01, 'A')})`, value: r.turnOn.pct1, unit: 'V', note: '' },
  ];
  if (r.reverse.available) {
    rows.push({ group: '역방향', name: `I @ −${fmt(r.reverse.vRef, 3)} V`, value: r.reverse.iAtMinusRef, unit: 'A', note: '' });
    rows.push({ group: '역방향', name: `정류비 (±${fmt(r.reverse.vRef, 3)} V)`, value: r.reverse.rectRatio, unit: '', note: '' });
  }
  state.rows = rows;
  state.meta = { title: '다이오드 추출 결과', source: state.fileName, lines: [`T = ${r.T} K`, ...(state.truth ? [`합성 정답: ${state.truth}`] : [])] };
  renderTable(rows);
  const plots = [];
  const fitLine = r.expo.fit ? (() => { const x = [Math.max(0, r.expo.vLo - 0.1), Math.min(r.v[r.v.length - 1], r.expo.vHi + 0.15)]; return [{ name: `n = ${fmt(r.expo.n, 3)} 직선`, x, y: x.map(v => Math.exp(r.expo.fit.slope * v + r.expo.fit.intercept)), type: 'line', color: COLORS[1], dash: '6 4', width: 2 }]; })() : [];
  plots.push(makePlot({ title: 'log|I| – V (지수영역 맞춤)', xLabel: 'V [V]', yLabel: '|I| [A]', yScale: 'log',
    series: [{ name: '측정', x: r.vAll, y: r.iAll.map(Math.abs), type: 'both' }, ...fitLine], legend: 'top' }));
  const hf = r.turnOn.extrapFit;
  plots.push(makePlot({ title: 'I – V (선형 눈금, 턴온 외삽)', xLabel: 'V [V]', yLabel: 'I [A]',
    series: [{ name: '측정', x: r.v, y: r.i, type: 'both' }, ...(hf && hf.slope > 0 ? [{ name: '고전류 직선', x: [r.turnOn.extrap, r.v[r.v.length - 1]], y: [0, hf.slope * r.v[r.v.length - 1] + hf.intercept], type: 'line', color: COLORS[1], dash: '6 4', width: 2 }] : [])],
    markers: [...(Number.isFinite(r.turnOn.extrap) ? [{ x: r.turnOn.extrap, y: 0, label: `외삽 ${fmt(r.turnOn.extrap, 3)} V`, color: COLORS[1] }] : []), ...(Number.isFinite(r.turnOn.atIref) ? [{ x: r.turnOn.atIref, y: r.turnOn.Iref, label: `${fmtSI(r.turnOn.Iref, 'A')} @ ${fmt(r.turnOn.atIref, 3)} V`, color: COLORS[3] }] : [])],
    yRange: [0, r.iMax * 1.05], legend: 'top' }));
  if (r.cheung.fit) {
    const cx = [], cy = [];
    for (let k = 0; k < r.v.length; k++) if (Number.isFinite(r.dVdln[k]) && r.i[k] > r.iMax * 0.005) { cx.push(r.i[k]); cy.push(r.dVdln[k]); }
    plots.push(makePlot({ title: 'Cheung: dV/d(lnI) – I', xLabel: 'I [A]', yLabel: 'dV/d(ln I) [V]',
      series: [{ name: '측정', x: cx, y: cy, type: 'points' }, { name: `Rs ${fmt(r.cheung.Rs, 3)} Ω`, x: [0, r.iMax], y: [r.cheung.fit.intercept, r.cheung.fit.slope * r.iMax + r.cheung.fit.intercept], type: 'line', color: COLORS[1], dash: '6 4', width: 2 }],
      yRange: [0, Math.max(...cy) * 1.1], legend: 'top' }));
  }
  renderPlots(plots);
  $('extra').innerHTML = '';
}

// ── 렌더 유틸 ─────────────────────────────────────────
function renderNotes(notes) {
  $('notes').innerHTML = notes.map((t, i) => `<div class="note${i === 0 ? ' ok' : ''}">${escapeHtml(t)}</div>`).join('') + (state.truth ? `<div class="note">이 예제의 정답: ${escapeHtml(state.truth)}</div>` : '');
}
function renderTable(rows) {
  const t = $('resTable');
  let html = '<tr><th>항목</th><th>값</th><th>단위</th><th>비고</th></tr>';
  let g = null;
  for (const r of rows) {
    if (r.group !== g) { g = r.group; html += `<tr class="grp"><td colspan="4">${escapeHtml(g)}</td></tr>`; }
    const v = typeof r.value === 'number' ? (r.unit === 'A' || r.unit === 'S' || r.unit === 'Ω' || r.unit === 'F/cm²' ? fmtSI(r.value, '').trim() : fmt(r.value, 4)) : (r.value ?? '—');
    html += `<tr><td>${escapeHtml(r.name)}</td><td class="v">${escapeHtml(String(v))}</td><td>${escapeHtml(r.unit || '')}</td><td class="n">${escapeHtml(r.note || '')}</td></tr>`;
  }
  t.innerHTML = html;
}
function renderPlots(svgs) {
  const box = $('plots'); box.innerHTML = '';
  svgs.forEach((svg, i) => {
    const d = document.createElement('div'); d.className = 'plotbox'; d.appendChild(svg);
    const pb = document.createElement('div'); pb.className = 'pb';
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'SVG 저장';
    b.addEventListener('click', () => downloadText(svgToString(svg), `devparam-${state.mode}-${i + 1}.svg`, 'image/svg+xml'));
    pb.appendChild(b); d.appendChild(pb); box.appendChild(d);
  });
}
function renderExplain() {
  $('explain').innerHTML = EXPLAIN[state.mode].map(e => `<details class="ex"><summary>${escapeHtml(e.title)}</summary><p><b>원리.</b> ${escapeHtml(e.principle)}</p><p><b>한계.</b> ${escapeHtml(e.limits)}</p></details>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

$('copyMd').addEventListener('click', async () => { const ok = await copyText(buildMarkdown(state.rows, state.meta)); $('copyHint').textContent = ok ? '마크다운 표를 복사했습니다.' : '복사 실패'; });
$('copyCsv').addEventListener('click', async () => { const ok = await copyText(buildCSV(state.rows, state.meta)); $('copyHint').textContent = ok ? 'CSV 를 복사했습니다.' : '복사 실패'; });
$('dlCsv').addEventListener('click', () => downloadText(buildCSV(state.rows, state.meta), `devparam-${state.mode}-결과.csv`, 'text/csv'));

// 초기화
setMode('transfer');
