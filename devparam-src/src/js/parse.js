// parse.js — CSV/TSV 텍스트 파싱, 장비별 프리셋, 열 자동 매핑, 단위 환산, 그룹 나누기

export const PRESETS = {
  auto:    { label: '자동 감지', hint: '구분자·헤더를 자동으로 판단합니다' },
  keithley:{ label: 'Keithley (4200 / KXCI 내보내기)', hint: '헤더에 GateV, DrainI, DrainV 같은 이름이 있는 CSV' },
  b1500:   { label: 'Agilent/Keysight B1500 EasyEXPERT', hint: 'DataName, ... / DataValue, ... 줄로 된 CSV' },
  generic2:{ label: '일반 2열 (x, y)', hint: '첫 열이 전압, 둘째 열이 전류' },
};

export const UNIT_V = { V: 1, mV: 1e-3, kV: 1e3 };
export const UNIT_I = { A: 1, mA: 1e-3, 'µA': 1e-6, uA: 1e-6, nA: 1e-9, pA: 1e-12, fA: 1e-15 };

const COMMENT_RE = /^\s*(#|\/\/|!|%|;;)/;

/** 숫자 토큰인지 (소수점 쉼표, 지수, ±, 공백 허용) */
function toNumber(tok) {
  if (tok === undefined || tok === null) return NaN;
  let t = String(tok).trim().replace(/^"|"$/g, '').trim();
  if (t === '' ) return NaN;
  // 소수점 쉼표 (예: 0,123) → 점으로 (구분자가 쉼표가 아닐 때만 호출됨)
  if (/^[+-]?\d+,\d+(e[+-]?\d+)?$/i.test(t)) t = t.replace(',', '.');
  t = t.replace(/[−–]/g, '-'); // 유니코드 마이너스
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}

/** 한 줄을 구분자로 나눈다 (따옴표 안의 구분자는 유지) */
function splitLine(line, delim) {
  if (delim === 'ws') return line.trim().split(/\s+/);
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === delim && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** 구분자 추정: 탭 > 세미콜론 > 쉼표 > 공백 (첫 20개 데이터 줄에서 가장 일관된 것) */
function detectDelimiter(lines) {
  const cands = ['\t', ';', ',', 'ws'];
  let best = 'ws', bestScore = -1;
  for (const d of cands) {
    const counts = lines.slice(0, 20).map(l => splitLine(l, d).length);
    if (!counts.length) continue;
    const maxc = Math.max(...counts);
    if (maxc < 2) continue;
    const consistent = counts.filter(c => c === maxc).length / counts.length;
    const score = consistent * 10 + maxc * 0.01 + (d === '\t' ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * 텍스트 → {headers, rows(number[][]), delimiter, skipped, preset}
 * opt.preset: 'auto' | 'keithley' | 'b1500' | 'generic2'
 */
export function parseText(text, opt = {}) {
  const preset = opt.preset || 'auto';
  let raw = text.replace(/\r\n?/g, '\n').split('\n');
  let lines = raw.map(l => l.replace(/ /g, ' ')).filter(l => l.trim() !== '' && !COMMENT_RE.test(l));

  // EasyEXPERT 형식: DataName / DataValue 접두어
  const isEasy = preset === 'b1500' || (preset === 'auto' && lines.some(l => /^DataValue\s*,/i.test(l)));
  if (isEasy) {
    const nameLine = lines.find(l => /^DataName\s*,/i.test(l));
    const headers = nameLine ? splitLine(nameLine, ',').slice(1) : [];
    const rows = [];
    for (const l of lines) {
      if (!/^DataValue\s*,/i.test(l)) continue;
      const vals = splitLine(l, ',').slice(1).map(toNumber);
      if (vals.some(Number.isFinite)) rows.push(vals);
    }
    const ncol = Math.max(headers.length, ...rows.map(r => r.length));
    const hdr = headers.length ? headers : Array.from({ length: ncol }, (_, i) => `열${i + 1}`);
    return { headers: hdr, rows, delimiter: ',', skipped: lines.length - rows.length, preset: 'b1500', ncol };
  }

  // 메타데이터 줄(예: "Device: xxx") 을 건너뛰기 위해, 숫자 열이 2개 이상인 줄부터 데이터 후보로 본다
  const delim = opt.delimiter || detectDelimiter(lines);
  const split = lines.map(l => splitLine(l, delim));
  const numericCount = split.map(cells => cells.filter(c => Number.isFinite(toNumber(c))).length);
  const dataStart = numericCount.findIndex(c => c >= 2);
  if (dataStart < 0) return { headers: [], rows: [], delimiter: delim, skipped: lines.length, preset, error: '숫자 열이 2개 이상인 줄을 찾지 못했습니다.' };
  const ncol = Math.max(...split.slice(dataStart).map(c => c.length));
  // 헤더: 데이터 시작 직전 줄에 숫자가 아닌 셀이 절반 이상이면 헤더로 사용
  let headers = null;
  if (dataStart > 0) {
    const cand = split[dataStart - 1];
    if (cand.length >= 2 && cand.filter(c => !Number.isFinite(toNumber(c))).length >= cand.length / 2) headers = cand;
  }
  if (!headers) headers = Array.from({ length: ncol }, (_, i) => `열${i + 1}`);
  while (headers.length < ncol) headers.push(`열${headers.length + 1}`);
  const rows = [];
  let skipped = dataStart;
  for (let i = dataStart; i < split.length; i++) {
    const vals = split[i].map(toNumber);
    if (vals.filter(Number.isFinite).length >= 2) rows.push(vals); else skipped++;
  }
  return { headers, rows, delimiter: delim, skipped, preset, ncol };
}

const PAT = {
  vg: [/^(v_?gs?|vgate|gate\s*v(oltage)?|gatev|vgs?\b|v_g)/i, /gate/i, /\bvg\b/i],
  vd: [/^(v_?ds?|vdrain|drain\s*v(oltage)?|drainv|vds?\b|v_d)/i, /drain.*v/i, /\bvd\b/i],
  id: [/^(i_?ds?|idrain|drain\s*i|drain\s*current|draini|ids?\b|i_d)/i, /drain.*i/i, /\bid\b/i],
  v:  [/^(v|volt|voltage|va|v_?a|anode\s*v|vf|v_?f)\b/i, /volt/i, /\bv\b/i, /anode/i],
  i:  [/^(i|curr|current|ia|i_?a|anode\s*i|if|i_?f)\b/i, /curr/i, /\bi\b/i],
};

/** 헤더 이름으로 열 자동 매핑. mode: 'transfer'|'output'|'diode'. 찾지 못하면 -1 */
export function detectHeaderMapping(headers, mode) {
  const H = headers.map(h => String(h).trim());
  const find = (key, used) => {
    for (const re of PAT[key]) {
      const k = H.findIndex((h, i) => !used.has(i) && re.test(h));
      if (k >= 0) return k;
    }
    return -1;
  };
  const used = new Set();
  const take = (key) => { const k = find(key, used); if (k >= 0) used.add(k); return k; };
  if (mode === 'diode') {
    let v = take('v'), i = take('i');
    if (v < 0 && i < 0 && H.length >= 2) { v = 0; i = 1; }
    else if (v < 0) v = [0, 1].find(k => k !== i) ?? 0;
    else if (i < 0) i = [1, 0].find(k => k !== v) ?? 1;
    return { v, i };
  }
  let vg = take('vg'), vd = take('vd'), id = take('id');
  // 못 찾으면 위치 규칙: 2열이면 (x, Id), 3열 이상이면 순서대로
  if (vg < 0 && id < 0 && vd < 0) {
    if (mode === 'output') return { vd: 0, id: 1, vg: H.length >= 3 ? 2 : -1 };
    return { vg: 0, id: 1, vd: H.length >= 3 ? 2 : -1 };
  }
  const free = () => H.findIndex((_, i) => !used.has(i));
  if (id < 0) { id = free(); if (id >= 0) used.add(id); }
  if (mode === 'output' && vd < 0) { vd = free(); if (vd >= 0) used.add(vd); }
  if (mode !== 'output' && vg < 0) { vg = free(); if (vg >= 0) used.add(vg); }
  return { vg, vd, id };
}

/** 매핑과 단위 배율로 열 배열 뽑기. mapping 값이 -1 이면 그 열은 null */
export function applyMapping(parsed, mapping, units = { v: 1, i: 1 }) {
  const col = (k, scale) => (mapping[k] === undefined || mapping[k] < 0) ? null
    : parsed.rows.map(r => r[mapping[k]] * scale);
  const out = {};
  for (const k of Object.keys(mapping)) {
    const isI = k === 'id' || k === 'i';
    out[k] = col(k, isI ? units.i : units.v);
  }
  // 유효 행만 남기기 (매핑된 열 전부 유한한 행)
  const keys = Object.keys(out).filter(k => out[k]);
  const n = parsed.rows.length;
  const keep = [];
  for (let r = 0; r < n; r++) if (keys.every(k => Number.isFinite(out[k][r]))) keep.push(r);
  for (const k of keys) out[k] = keep.map(r => out[k][r]);
  out.count = keep.length;
  return out;
}

/** key 배열 값이 같은 행끼리 묶는다 (tol 이내면 같은 값). 측정 순서는 유지 */
export function groupBy(keys, idx, tol = 1e-6) {
  const groups = [];
  for (let r = 0; r < keys.length; r++) {
    const k = keys[r];
    let g = groups.find(x => Math.abs(x.key - k) <= tol * Math.max(1, Math.abs(k)));
    if (!g) { g = { key: k, idx: [] }; groups.push(g); }
    g.idx.push(idx ? idx[r] : r);
  }
  return groups.sort((a, b) => a.key - b.key);
}
