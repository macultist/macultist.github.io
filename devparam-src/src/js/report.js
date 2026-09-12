// report.js — 결과 행 배열을 마크다운 표 / CSV 텍스트로 만든다
import { fmt } from './numeric.js';

/** rows: [{group, name, value, unit, note}] , meta: {title, source, lines:[...]} */
export function buildMarkdown(rows, meta = {}) {
  const out = [];
  out.push(`## ${meta.title || '파라미터 추출 결과'}`);
  if (meta.source) out.push(`- 자료: ${meta.source}`);
  for (const l of meta.lines || []) out.push(`- ${l}`);
  out.push('');
  out.push('| 구분 | 항목 | 값 | 단위 | 비고 |');
  out.push('|---|---|---:|---|---|');
  for (const r of rows) {
    out.push(`| ${r.group || ''} | ${r.name} | ${typeof r.value === 'number' ? fmt(r.value, 4) : (r.value ?? '—')} | ${r.unit || ''} | ${(r.note || '').replace(/\|/g, '/')} |`);
  }
  out.push('');
  out.push(`_생성: 반도체 소자 파라미터 추출기 (https://macultist.github.io/devparam/) · ${new Date().toISOString().slice(0, 10)}_`);
  return out.join('\n');
}

export function buildCSV(rows, meta = {}) {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const out = ['group,name,value,unit,note'];
  for (const r of rows) {
    out.push([q(r.group || ''), q(r.name), typeof r.value === 'number' ? (Number.isFinite(r.value) ? r.value.toPrecision(6) : '') : q(r.value ?? ''), q(r.unit || ''), q(r.note || '')].join(','));
  }
  if (meta.source) out.push(`"자료",${q(meta.source)},,,`);
  return out.join('\n');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function downloadText(text, filename, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
