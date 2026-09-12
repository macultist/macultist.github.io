// plot.js — 의존성 없는 SVG 플로터 (선형/로그 축, 선·점 시리즈, 접선·마커 주석)
import { fmt } from './numeric.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const COLORS = ['#0f5fa8', '#d9531e', '#0d9f7c', '#8e44ad', '#b8860b', '#c0392b', '#2c3e50', '#16a085'];

function niceStep(range, target = 6) {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const s = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return s * p;
}

function linearTicks(lo, hi, target = 6) {
  if (!(hi > lo)) return [lo];
  const st = niceStep(hi - lo, target);
  const out = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-9; v += st) out.push(Number(v.toPrecision(12)));
  return out;
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) out.push(e);
  if (out.length > 12) return out.filter((_, i) => i % Math.ceil(out.length / 8) === 0);
  return out;
}

function tickLabel(v, isLog) {
  if (isLog) {
    const e = Math.round(v);
    return e === 0 ? '1' : `1e${e}`;
  }
  return fmt(v, 3);
}

function el(name, attrs = {}, children = []) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

/**
 * spec: { title, xLabel, yLabel, yScale:'linear'|'log', series:[{name,x,y,type,color,dash,width}],
 *         lines:[{x1,y1,x2,y2,color,dash,label}], markers:[{x,y,label,color}], vlines:[{x,label,color}],
 *         hlines:[{y,label,color}], xRange:[lo,hi], yRange:[lo,hi], width, height }
 */
export function makePlot(spec) {
  const W = spec.width || 560, H = spec.height || 340;
  const m = { l: 64, r: 16, t: spec.title ? 30 : 12, b: 46 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const isLog = spec.yScale === 'log';
  const ty = (v) => isLog ? (v > 0 ? Math.log10(v) : NaN) : v;

  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (const s of spec.series || []) {
    for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i], y = ty(s.y[i]);
      if (Number.isFinite(x)) { if (x < xlo) xlo = x; if (x > xhi) xhi = x; }
      if (Number.isFinite(y)) { if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
    }
  }
  if (spec.xRange) [xlo, xhi] = spec.xRange;
  if (spec.yRange) [ylo, yhi] = spec.yRange.map(ty);
  if (!Number.isFinite(xlo)) { xlo = 0; xhi = 1; }
  if (!Number.isFinite(ylo)) { ylo = 0; yhi = 1; }
  if (xhi === xlo) { xhi = xlo + 1; }
  if (yhi === ylo) { yhi = ylo + 1; }
  if (!isLog && !spec.yRange) { const pad = (yhi - ylo) * 0.05; ylo -= pad; yhi += pad; if (ylo > 0 && ylo < (yhi - ylo) * 0.3) ylo = 0; }
  if (isLog && !spec.yRange) { ylo = Math.floor(ylo); yhi = Math.ceil(yhi); }
  const sx = (x) => m.l + (x - xlo) / (xhi - xlo) * pw;
  const sy = (y) => m.t + ph - (ty(y) - ylo) / (yhi - ylo) * ph;
  const syT = (yt) => m.t + ph - (yt - ylo) / (yhi - ylo) * ph;

  const svg = el('svg', { xmlns: SVG_NS, viewBox: `0 0 ${W} ${H}`, class: 'plot', role: 'img', 'aria-label': spec.title || 'plot' });
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: '#ffffff', rx: 8 }));
  // 격자와 축
  const xt = linearTicks(xlo, xhi, 6);
  const yt = isLog ? logTicks(ylo, yhi) : linearTicks(ylo, yhi, 6);
  const grid = el('g', { stroke: '#e3e8ee', 'stroke-width': 1 });
  const labels = el('g', { fill: '#55627a', 'font-size': 11, 'font-family': 'inherit' });
  for (const v of xt) {
    const X = sx(v);
    grid.appendChild(el('line', { x1: X, y1: m.t, x2: X, y2: m.t + ph }));
    labels.appendChild(el('text', { x: X, y: m.t + ph + 16, 'text-anchor': 'middle' }, [tickLabel(v, false)]));
  }
  for (const v of yt) {
    const Y = syT(v);
    grid.appendChild(el('line', { x1: m.l, y1: Y, x2: m.l + pw, y2: Y }));
    labels.appendChild(el('text', { x: m.l - 6, y: Y + 4, 'text-anchor': 'end' }, [tickLabel(v, isLog)]));
  }
  svg.appendChild(grid);
  svg.appendChild(el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'none', stroke: '#9aa6b5' }));
  svg.appendChild(labels);
  if (spec.xLabel) svg.appendChild(el('text', { x: m.l + pw / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 12, fill: '#0f1b2d' }, [spec.xLabel]));
  if (spec.yLabel) svg.appendChild(el('text', { x: 14, y: m.t + ph / 2, 'text-anchor': 'middle', 'font-size': 12, fill: '#0f1b2d', transform: `rotate(-90 14 ${m.t + ph / 2})` }, [spec.yLabel]));
  if (spec.title) svg.appendChild(el('text', { x: m.l, y: 18, 'font-size': 13, 'font-weight': 700, fill: '#0f1b2d' }, [spec.title]));

  const clipId = 'clip' + Math.random().toString(36).slice(2, 8);
  const defs = el('defs', {}, [el('clipPath', { id: clipId }, [el('rect', { x: m.l, y: m.t, width: pw, height: ph })])]);
  svg.appendChild(defs);
  const body = el('g', { 'clip-path': `url(#${clipId})` });

  // 시리즈
  (spec.series || []).forEach((s, si) => {
    const color = s.color || COLORS[si % COLORS.length];
    const pts = [];
    for (let i = 0; i < s.x.length; i++) {
      const X = sx(s.x[i]), Y = sy(s.y[i]);
      if (Number.isFinite(X) && Number.isFinite(Y)) pts.push([X, Y]); else pts.push(null);
    }
    const type = s.type || 'line';
    if (type === 'line' || type === 'both') {
      let d = '', pen = false;
      for (const p of pts) { if (!p) { pen = false; continue; } d += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); pen = true; }
      body.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': s.width || 1.8, 'stroke-dasharray': s.dash, 'stroke-linejoin': 'round' }));
    }
    if (type === 'points' || type === 'both') {
      const g = el('g', { fill: color, opacity: type === 'both' ? 0.55 : 0.85 });
      const step = Math.max(1, Math.floor(pts.length / 200));
      pts.forEach((p, i) => { if (p && i % step === 0) g.appendChild(el('circle', { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: s.r || 2.2 })); });
      body.appendChild(g);
    }
  });
  // 주석 직선 (데이터 좌표)
  for (const L of spec.lines || []) {
    const X1 = sx(L.x1), Y1 = sy(L.y1), X2 = sx(L.x2), Y2 = sy(L.y2);
    if (![X1, Y1, X2, Y2].every(Number.isFinite)) continue;
    body.appendChild(el('line', { x1: X1, y1: Y1, x2: X2, y2: Y2, stroke: L.color || '#d9531e', 'stroke-width': L.width || 1.6, 'stroke-dasharray': L.dash || '6 4' }));
  }
  for (const V of spec.vlines || []) {
    const X = sx(V.x); if (!Number.isFinite(X)) continue;
    body.appendChild(el('line', { x1: X, y1: m.t, x2: X, y2: m.t + ph, stroke: V.color || '#8e44ad', 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }));
  }
  for (const Hh of spec.hlines || []) {
    const Y = sy(Hh.y); if (!Number.isFinite(Y)) continue;
    body.appendChild(el('line', { x1: m.l, y1: Y, x2: m.l + pw, y2: Y, stroke: Hh.color || '#8e44ad', 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }));
  }
  svg.appendChild(body);
  // 마커와 라벨은 클립 밖 (글자가 잘리지 않게)
  for (const M of spec.markers || []) {
    const X = sx(M.x), Y = sy(M.y);
    if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
    svg.appendChild(el('circle', { cx: X, cy: Y, r: 4.5, fill: M.color || '#d9531e', stroke: '#fff', 'stroke-width': 1.5 }));
    if (M.label) svg.appendChild(el('text', { x: X + 7, y: Y - 7, 'font-size': 11, fill: M.color || '#d9531e', 'font-weight': 600 }, [M.label]));
  }
  for (const V of spec.vlines || []) {
    const X = sx(V.x); if (!Number.isFinite(X) || !V.label) continue;
    svg.appendChild(el('text', { x: X + 4, y: m.t + 12, 'font-size': 10.5, fill: V.color || '#8e44ad' }, [V.label]));
  }
  for (const Hh of spec.hlines || []) {
    const Y = sy(Hh.y); if (!Number.isFinite(Y) || !Hh.label) continue;
    svg.appendChild(el('text', { x: m.l + pw - 4, y: Y - 4, 'text-anchor': 'end', 'font-size': 10.5, fill: Hh.color || '#8e44ad' }, [Hh.label]));
  }
  // 범례
  const leg = (spec.series || []).filter(s => s.name);
  if (leg.length) {
    const g = el('g', { 'font-size': 11 });
    let x = m.l + 8, y = m.t + ph - 8 - (leg.length - 1) * 15;
    if (spec.legend === 'top') y = m.t + 14;
    leg.forEach((s, i) => {
      const color = s.color || COLORS[(spec.series.indexOf(s)) % COLORS.length];
      g.appendChild(el('rect', { x: x - 4, y: y - 10, width: 8 + s.name.length * 6.5 + 22, height: 14, fill: '#fff', opacity: 0.8, rx: 3 }));
      g.appendChild(el('line', { x1: x, y1: y - 3, x2: x + 16, y2: y - 3, stroke: color, 'stroke-width': 2.5, 'stroke-dasharray': s.dash }));
      g.appendChild(el('text', { x: x + 21, y: y, fill: '#0f1b2d' }, [s.name]));
      y += 15;
    });
    svg.appendChild(g);
  }
  return svg;
}

/** SVG 요소 → 파일로 저장 가능한 문자열 */
export function svgToString(svg) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}
