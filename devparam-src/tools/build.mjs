// tools/build.mjs — src/ → site/ : JS 뭉개기(terser), CSS 압축, 무단 복제 금지 표시 삽입
// 실행: node tools/build.mjs   (site/ 폴더가 공개 저장소로 올라가는 완성 화면)
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src'), OUT = join(ROOT, 'site');
const YEAR = new Date().getFullYear();
const NOTICE = `© ${YEAR} Macultist. All rights reserved. 화면·문구·디자인·코드의 무단 복제를 금합니다. Unauthorized copying is prohibited.`;
const BANNER = `/*! ${NOTICE} */`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'js'), { recursive: true });
mkdirSync(join(OUT, 'css'), { recursive: true });

// 1) JS: ES 모듈 구조는 유지하고(다른 파일이 import 하므로 내보내는 이름은 보존) 나머지는 압축·이름 뭉개기
let jsBytesIn = 0, jsBytesOut = 0;
for (const f of readdirSync(join(SRC, 'js')).filter(n => n.endsWith('.js'))) {
  const code = readFileSync(join(SRC, 'js', f), 'utf8');
  const r = await minify(code, {
    module: true, ecma: 2020,
    compress: { passes: 2, drop_console: true, pure_getters: true },
    mangle: { toplevel: false },
    format: { comments: false, preamble: BANNER },
  });
  if (!r.code) throw new Error(`terser 실패: ${f}`);
  jsBytesIn += code.length; jsBytesOut += r.code.length;
  writeFileSync(join(OUT, 'js', f), r.code);
}

// 2) CSS: 주석·공백 제거
const css = readFileSync(join(SRC, 'css', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*([{}:;,>])\s*/g, '$1').replace(/;}/g, '}').replace(/\n+/g, '');
writeFileSync(join(OUT, 'css', 'style.css'), BANNER + '\n' + css);

// 3) HTML: 맨 위 주석 + 하단 무단 복제 금지 문구 + 복사 방지용 메타
let html = readFileSync(join(SRC, 'index.html'), 'utf8');
html = html.replace(/© \d{4} Macultist\. All rights reserved\./, `${NOTICE}`);
html = html.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n<!-- ${NOTICE} -->`);
html = html.replace('</head>', '<meta name="copyright" content="Macultist"><meta name="robots" content="index,follow,noimageindex">\n</head>');
writeFileSync(join(OUT, 'index.html'), html);

// 4) 부속 파일
if (existsSync(join(SRC, 'sitemap.xml'))) cpSync(join(SRC, 'sitemap.xml'), join(OUT, 'sitemap.xml'));
writeFileSync(join(OUT, '.nojekyll'), '');
writeFileSync(join(OUT, 'README.md'), `# 반도체 소자 파라미터 추출기\n\n공개 사이트의 완성된 화면 파일입니다. https://macultist.github.io/devparam/\n\n${NOTICE}\n`);

console.log(`build ok → site/  (js ${(jsBytesIn / 1024).toFixed(1)} KB → ${(jsBytesOut / 1024).toFixed(1)} KB)`);
