// One-shot lint for public/ HTML inline scripts + standalone JS.
// Uses ESLint Linter API directly (no CLI plugin needed).
// 実行: cd functions && node scripts/lint-public.js
// 結果: 1 ファイルにつき問題件数を表示、詳細は scripts/lint-public-report.txt。

const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// caption.html などのインライン JS で参照されるグローバル類。
// undef を「設計上 OK な参照」と「タイポ」で区別するため、ここに列挙してホワイトリスト化。
const browserGlobals = {
  // 標準ブラウザ
  window: 'readonly', document: 'readonly', console: 'readonly',
  fetch: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
  Blob: 'readonly', File: 'readonly', FileReader: 'readonly',
  Image: 'readonly', Audio: 'readonly',
  navigator: 'readonly', location: 'readonly', history: 'readonly',
  Promise: 'readonly', Set: 'readonly', Map: 'readonly',
  JSON: 'readonly', Math: 'readonly', Date: 'readonly',
  Object: 'readonly', Array: 'readonly', String: 'readonly', Number: 'readonly',
  Boolean: 'readonly', Error: 'readonly', RegExp: 'readonly', Symbol: 'readonly',
  Intl: 'readonly', NaN: 'readonly', isNaN: 'readonly', isFinite: 'readonly',
  parseInt: 'readonly', parseFloat: 'readonly',
  encodeURIComponent: 'readonly', decodeURIComponent: 'readonly',
  encodeURI: 'readonly', decodeURI: 'readonly',
  HTMLElement: 'readonly', HTMLInputElement: 'readonly',
  Element: 'readonly', Node: 'readonly', NodeList: 'readonly',
  CSS: 'readonly', getComputedStyle: 'readonly',
  // 外部ライブラリ (script src で読まれる)
  firebase: 'readonly',
  qrcode: 'readonly',     // qrcode-generator
  XLSX: 'readonly',       // sheetjs
  marked: 'readonly',     // marked.js
  Sortable: 'readonly',   // SortableJS
  // プロジェクト共有 (field-defs.js / version.js 経由でグローバル定義)
  APP_VERSION: 'readonly', APP_RELEASED_AT: 'readonly', APP_NAME: 'readonly',
  renderVersionFooter: 'readonly', renderInquiryLink: 'readonly',
  // operator-auth.js
  operatorAuth: 'readonly',
  // sessionid.js
  getOrCreateSessionId: 'readonly',
  // field-defs.js は readonly でもグローバル列挙すると本体ファイルで no-redeclare
  // が出るので、ここには入れず crossGlobals 抽出に任せる。
};

// ESLint ルール選定 (信号品質重視、ノイズ少なめ)
const rules = {
  'no-undef':                ['error'],     // タイポ・グローバル参照ミス
  'no-unreachable':          ['error'],     // return 後のコード
  'no-dupe-keys':            ['error'],     // object literal キー重複
  'no-dupe-args':            ['error'],     // 関数引数の重複
  'no-duplicate-case':       ['error'],     // switch case 重複
  'no-redeclare':            ['error'],     // 同名 var/let 再宣言
  'no-cond-assign':          ['error'],     // if (a = 1) のような誤代入
  'no-empty':                ['warn'],      // 空 {} ブロック
  'no-unused-vars':          ['warn', {     // 未使用変数
    args: 'none',                            //   関数引数は除外 (ハンドラ等で必要)
    ignoreRestSiblings: true,
    varsIgnorePattern: '^_',                 //   _name は意図的 unused
  }],
  'no-fallthrough':          ['warn'],     // switch case fall-through
  'no-self-assign':          ['error'],     // a = a
  'no-constant-condition':   ['warn'],     // while(true) 等
  'use-isnan':               ['error'],     // x === NaN は常に false
  'valid-typeof':            ['error'],     // typeof x === 'strnig'
};

// HTML から inline <script> (src 無し) を抽出。返り値: [{ code, startLine }, ...]
function extractInlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = re.exec(html))) {
    const fullMatch = m[0];
    const innerStart = m.index + fullMatch.indexOf('>') + 1;
    const beforeInner = html.slice(0, innerStart);
    const startLine = beforeInner.split('\n').length;
    blocks.push({ code: m[1], startLine });
  }
  return blocks;
}

function lintCode(linter, code) {
  return linter.verify(code, {
    parserOptions: { ecmaVersion: 2022, sourceType: 'script' },
    env: { browser: true, es2022: true },
    globals: browserGlobals,
    rules,
  });
}

// HTML 内 inline ハンドラ (onclick="foo()" 等) で参照される識別子を抽出。
// no-unused-vars の false positive 削減に使う。
function extractInlineHandlerRefs(html) {
  const refs = new Set();
  // onclick="..."  onclick='...'  oninput= etc.
  const re = /\bon\w+\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(html))) {
    const code = m[1] || m[2] || '';
    // 識別子っぽいトークンを全部拾う (関数呼び出し / 参照 / プロパティ名)
    const ids = code.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [];
    ids.forEach(id => refs.add(id));
  }
  // href="javascript:..." も拾う
  const hrefRe = /\bhref\s*=\s*"javascript:([^"]*)"/g;
  while ((m = hrefRe.exec(html))) {
    const ids = m[1].match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [];
    ids.forEach(id => refs.add(id));
  }
  return refs;
}

// HTML 内の他 <script> ブロックで定義されているグローバル風識別子を抽出。
// 同一 HTML 内の cross-script no-undef を抑制するため。
function extractCrossScriptGlobals(blocks) {
  const defined = new Set();
  blocks.forEach(b => {
    // top-level: const/let/var/function/async function/function*/class foo
    const re = /^[ \t]*(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
    let m;
    while ((m = re.exec(b.code))) defined.add(m[1]);
    // window.foo = ...  および  globalThis.foo = ...
    const winRe = /\b(?:window|globalThis)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
    while ((m = winRe.exec(b.code))) defined.add(m[1]);
  });
  return defined;
}

// field-defs.js から外部に提供される定数群。caption.html / register.html 等で参照される。
const FIELD_DEFS_EXPORTS = new Set([
  'FIELD_DEFS', 'FIELD_MAP',
  'ARTIST_FIELDS', 'SNS_FIELDS', 'ALL_ARTIST_FIELDS',
  'GRID_FIELDS', 'DEFAULT_FIELDS',
  'ARTIST_LABELS', 'SNS_PLACEHOLDERS', 'FORM_FIELD_DEFS',
]);

// 全 script ブロックから参照される識別子を抽出 (定義の使用判定用)。
// no-unused-vars の cross-script false positive 削減。
function extractAllRefs(blocks) {
  const refs = new Set();
  blocks.forEach(b => {
    const tokens = b.code.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [];
    tokens.forEach(t => refs.add(t));
  });
  return refs;
}

// 共通フィルタ: 1 メッセージを許可するか判断 (true = 残す / false = 除外)
function shouldKeep(msg, opts) {
  const { filepath, inlineRefs, crossGlobals, crossBlockRefs, currentBlockIdx, definedAt, textLines, htmlLineOffset } = opts;
  const idMatch = /'([^']+)'/.exec(msg.message || '');
  const id = idMatch && idMatch[1];

  if (msg.ruleId === 'no-unused-vars' && id) {
    // HTML inline ハンドラから参照されていれば除外
    if (inlineRefs && inlineRefs.has(id)) return false;
    // 他の script ブロックで参照されていれば除外 (cross-script visibility)
    if (crossBlockRefs && definedAt !== undefined) {
      // 自分のブロック以外で参照されているかチェック
      for (let i = 0; i < crossBlockRefs.length; i++) {
        if (i === currentBlockIdx) continue;
        if (crossBlockRefs[i].has(id)) return false;
      }
    }
    // field-defs.js の export 定数は外部利用前提
    if (filepath.endsWith('field-defs.js') && FIELD_DEFS_EXPORTS.has(id)) return false;
  }
  if (msg.ruleId === 'no-undef' && id) {
    // 同一 HTML 内の他 script で定義 / field-defs.js export なら除外
    if (crossGlobals && crossGlobals.has(id)) return false;
    if (FIELD_DEFS_EXPORTS.has(id)) return false;
  }
  if (msg.ruleId === 'no-empty' && textLines) {
    // catch(_e){} のような意図的サイレント catch は除外
    const lineIdx = (htmlLineOffset || 0) + msg.line - 1;
    const codeLine = textLines[lineIdx] || '';
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(codeLine)) return false;
  }
  return true;
}

function lintFile(linter, filepath, isHtml) {
  const text = fs.readFileSync(filepath, 'utf8');
  const textLines = text.split('\n');
  if (!isHtml) {
    const messages = lintCode(linter, text);
    return messages
      .filter(msg => shouldKeep(msg, { filepath, textLines }))
      .map(m => ({ ...m, file: filepath }));
  }
  const blocks = extractInlineScripts(text);
  const inlineRefs = extractInlineHandlerRefs(text);
  const crossGlobals = extractCrossScriptGlobals(blocks);
  // 各ブロックで参照される識別子を block index 別に保持
  const crossBlockRefs = blocks.map(b => {
    const refs = new Set();
    const tokens = b.code.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) || [];
    tokens.forEach(t => refs.add(t));
    return refs;
  });
  const all = [];
  blocks.forEach((b, blockIdx) => {
    const messages = lintCode(linter, b.code);
    messages.forEach(msg => {
      const htmlLineOffset = b.startLine - 1;
      if (!shouldKeep(msg, {
        filepath, inlineRefs, crossGlobals,
        crossBlockRefs, currentBlockIdx: blockIdx, definedAt: blockIdx,
        textLines, htmlLineOffset,
      })) return;
      all.push({
        ...msg,
        file: filepath,
        blockIdx,
        htmlLine: b.startLine + msg.line - 1,
      });
    });
  });
  return all;
}

function* walkFiles(dir, exts) {
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'docs') continue;
      yield* walkFiles(p, exts);
    } else if (exts.some(e => ent.name.endsWith(e))) {
      yield p;
    }
  }
}

function severityName(s) { return s === 2 ? 'error' : 'warn'; }

(function main() {
  const linter = new Linter();
  const targets = [];
  for (const f of walkFiles(PUBLIC_DIR, ['.html', '.js'])) targets.push(f);
  targets.sort();

  const allMessages = [];
  const fileSummary = [];
  for (const f of targets) {
    const isHtml = f.endsWith('.html');
    const messages = lintFile(linter, f, isHtml);
    if (messages.length === 0) continue;
    fileSummary.push({ file: f, count: messages.length });
    allMessages.push(...messages);
  }

  // 集計
  const byRule = {};
  allMessages.forEach(m => {
    const key = m.ruleId || '(parser)';
    byRule[key] = (byRule[key] || 0) + 1;
  });

  const lines = [];
  lines.push('=== lint-public.js report ===');
  lines.push(`scanned: ${targets.length} files`);
  lines.push(`with issues: ${fileSummary.length} files, ${allMessages.length} messages`);
  lines.push('');
  lines.push('=== by rule ===');
  Object.entries(byRule).sort((a, b) => b[1] - a[1]).forEach(([rule, n]) => {
    lines.push(`  ${n.toString().padStart(4)}  ${rule}`);
  });
  lines.push('');
  lines.push('=== by file ===');
  fileSummary.sort((a, b) => b.count - a.count).forEach(({ file, count }) => {
    const rel = path.relative(ROOT, file);
    lines.push(`  ${count.toString().padStart(4)}  ${rel}`);
  });
  lines.push('');
  lines.push('=== details ===');
  allMessages.forEach(m => {
    const rel = path.relative(ROOT, m.file);
    const line = m.htmlLine !== undefined ? m.htmlLine : m.line;
    lines.push(`${rel}:${line}:${m.column}  ${severityName(m.severity)}  ${m.ruleId || '(parser)'}  ${m.message}`);
  });

  const report = lines.join('\n');
  const out = path.join(__dirname, 'lint-public-report.txt');
  fs.writeFileSync(out, report, 'utf8');
  console.log(report.split('\n').slice(0, 60).join('\n'));
  console.log('...');
  console.log(`(full report: ${out})`);
})();
