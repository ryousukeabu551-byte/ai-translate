(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const frame = $('page');
const params = new URLSearchParams(location.search);
const targetUrl = (params.get('url') || '').trim();
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'ai-translate' };
let CONCURRENCY = 1, BATCH_CHARS = 12000, BATCH_ITEMS = 100;
const FATAL = ['API_KEY_MISSING', 'API_KEY_INVALID', 'UNAUTHORIZED', 'DAILY_LIMIT'];

const HINTS = {
  BAD_URL: ['URLを認識できません', 'ショートカットの設定（URLエンコード）を確認してください。'],
  FETCH_FAILED: ['ページを取得できません', 'URLが正しいか、サイトが公開されているか確認してください。'],
  TIMEOUT: ['取得がタイムアウトしました', '時間をおいて再度お試しください。'],
  BLOCKED_HOST: ['このアドレスは利用できません', '公開されているWebサイトのURLのみ翻訳できます。'],
  ROBOTS_DISALLOWED: ['取得が許可されていません', 'サイトのrobots.txtで自動取得が禁止されています。元のページをそのままご利用ください。'],
  LOGIN_REQUIRED: ['ログインが必要です', 'サーバーはあなたのログイン状態を使えないため、ログイン後のページは翻訳できません。'],
  DYNAMIC_PAGE: ['動的ページは未対応です', 'JavaScriptで本文を描画するサイトは、サーバー側では本文を取得できません。'],
  NO_TEXT: ['翻訳できる本文がありません', 'ページに本文テキストが見つかりませんでした。'],
  NOT_HTML: ['HTMLページではありません', 'PDFや画像などは翻訳できません。'],
  PAGE_TOO_LARGE: ['ページが大きすぎます', '上限を超えています。サーバーの MAX_TRANSLATE_CHARS / MAX_PAGE_BYTES で調整できます。'],
  API_KEY_MISSING: ['APIキーが未設定です', 'サーバーの .env に AI_API_KEY と AI_MODEL を設定し、サーバーを再起動してください。'],
  API_KEY_INVALID: ['APIキーが無効です', 'OpenAIのキーと権限（プロジェクト・利用可能モデル）を確認してください。'],
  API_UNREACHABLE: ['AI APIに接続できません', 'サーバーの外向き通信やOpenAIの障害情報を確認してください。'],
  RATE_LIMITED: ['AI APIの無料枠の制限です', '1分あたり／1日あたりの上限に達しました。しばらく待ってから「失敗分を再試行」を押すか、明日また試してください。'],
  DAILY_LIMIT: ['本日の上限に達しました', '無料枠を守るためのサーバー側の自主上限です。明日また使うか、.env の AI_DAILY_LIMIT を調整してください。'],
  TRANSLATE_FAILED: ['翻訳に失敗しました', 'AI_MODEL・AI_BASE_URL・AI_RESPONSE_FORMAT の設定や、サーバーログ（journalctl）を確認してください。'],
  UNAUTHORIZED: ['認証エラー', 'ショートカットのURLの token が、サーバーの ACCESS_TOKEN と一致しているか確認してください。'],
  SERVER_UNREACHABLE: ['翻訳サーバーに接続できません', '通信状況、ドメイン、サーバーの稼働状況を確認してください。'],
};

let finalUrl = targetUrl, pageTitle = '', maxChars = 300000;
let units = [], showJa = true, done = 0, aborted = false, doc = null, origLang = '';

class ApiErr extends Error {
  constructor(code, message) { super(message); this.code = code; this.fatal = FATAL.includes(code); }
}

async function api(path, body) {
  let r;
  try { r = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body), credentials: 'same-origin' }); }
  catch { throw new ApiErr('SERVER_UNREACHABLE', '翻訳サーバーに接続できません。'); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const err = new ApiErr(j?.code || 'HTTP_' + r.status, j?.message || `サーバーエラー（HTTP ${r.status}）`);
    err.retryAfter = j?.retryAfter;
    throw err;
  }
  return j;
}

/* ---------- UI ---------- */
function setStatus(text, ratio) {
  $('statusText').textContent = text;
  if (ratio != null) $('progressBar').style.width = Math.round(ratio * 100) + '%';
}
function showError(e) {
  aborted = true;
  const h = HINTS[e.code] || ['エラーが発生しました', ''];
  $('status').hidden = true;
  $('errTitle').textContent = h[0];
  $('errMsg').textContent = e.message || '';
  $('errHint').textContent = h[1] + (e.code ? `（コード: ${e.code}）` : '');
  $('error').hidden = false;
  $('errOpen').onclick = () => { location.href = finalUrl; };
  if (!units.length) frame.style.display = 'none';
}
function fit() {
  try {
    const d = frame.contentDocument;
    if (!d || !d.body) return;
    const cs = frame.contentWindow.getComputedStyle(d.body);
    const h = Math.ceil(d.body.getBoundingClientRect().bottom + (parseFloat(cs.marginBottom) || 0));
    if (Math.abs(h - frame.offsetHeight) > 2) frame.style.height = h + 'px';
  } catch {}
}
setInterval(fit, 600);

/* ---------- 翻訳単位の抽出 ---------- */
const INLINE = new Set('A ABBR ACRONYM B BDI BDO BIG BR BUTTON CANVAS CITE CODE DATA DEL DFN EM FONT I IMG INPUT INS KBD LABEL MARK METER OUTPUT PICTURE PROGRESS Q S SAMP SELECT SMALL SPAN STRIKE STRONG SUB SUP SVG TEXTAREA TIME TT U VAR WBR NOBR'.split(' '));
const ATOMIC = new Set('IMG BR WBR PICTURE SVG CANVAS INPUT SELECT TEXTAREA METER PROGRESS CODE KBD SAMP VAR'.split(' '));
const SKIP_BLOCK = new Set('SCRIPT STYLE NOSCRIPT PRE NAV ASIDE FOOTER TEMPLATE HEAD TITLE MATH'.split(' '));
const SKIP_RE = /(^|[\s_-])(cookies?|consent|gdpr|advert(isement)?s?|ads?|adsense|popup|modal|newsletter|sponsor(ed)?|breadcrumbs?)([\s_-]|$)/i;

function skipEl(el) {
  if (SKIP_BLOCK.has(el.tagName)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
  if (el.getAttribute('role') === 'navigation') return true;
  const st = (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
  if (st.includes('display:none') || st.includes('visibility:hidden')) return true;
  const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
  return SKIP_RE.test(cls);
}
const isAtomic = (el) => ATOMIC.has(el.tagName) || skipEl(el);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function ser(nodes, map) {
  let s = '';
  for (const n of nodes) {
    if (n.nodeType === 3) s += esc(n.nodeValue.replace(/\s+/g, ' '));
    else if (n.nodeType === 1) {
      const id = map.length; map.push(n);
      s += isAtomic(n) ? `<g${id}/>` : `<g${id}>${ser(n.childNodes, map)}</g${id}>`;
    }
  }
  return s;
}

function collect(d) {
  const out = [], memo = new WeakMap();
  const blockish = (el) => {
    if (memo.has(el)) return memo.get(el);
    let r = !INLINE.has(el.tagName);
    if (!r) for (const c of el.children) if (blockish(c)) { r = true; break; }
    memo.set(el, r);
    return r;
  };
  const makeUnit = (run) => {
    const map = [];
    const src = ser(run, map);
    const text = unesc(src.replace(/<\/?g\d+\/?>/g, '')).trim();
    if (!/\p{L}/u.test(text) || /^https?:\/\/\S+$/.test(text)) return;
    const letters = (text.match(/\p{L}/gu) || []).length;
    const ja = (text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    if (ja / letters > 0.3) return;
    out.push({ orig: run, cur: run, trans: null, map, src });
  };
  const proc = (el) => {
    let run = [];
    const flush = () => { if (run.length) makeUnit(run); run = []; };
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 || n.nodeType === 8) { run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      if (!blockish(n)) { run.push(n); continue; }
      flush();
      if (!skipEl(n)) proc(n);
    }
    flush();
  };
  if (d.body) proc(d.body);
  return out;
}

/* ---------- 翻訳結果 → DOM ---------- */
function build(unit, str) {
  const d = unit.orig[0].ownerDocument;
  const root = [], stack = [{ id: -1, kids: root, el: null }], used = new Set();
  const re = /<g(\d+)\/>|<g(\d+)>|<\/g(\d+)>|([^<]+)/g;
  let m, last = 0;
  try {
    while ((m = re.exec(str))) {
      if (m.index !== last) throw new Error('stray');
      last = re.lastIndex;
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) {
        const id = +m[1]; const src = unit.map[id];
        if (!src || used.has(id)) throw new Error('bad id');
        used.add(id); top.kids.push(src.cloneNode(true));
      } else if (m[2] !== undefined) {
        const id = +m[2]; const src = unit.map[id];
        if (!src || used.has(id) || isAtomic(src)) throw new Error('bad id');
        used.add(id);
        const el = src.cloneNode(false);
        top.kids.push(el); stack.push({ id, kids: [], el });
      } else if (m[3] !== undefined) {
        if (top.id !== +m[3]) throw new Error('unbalanced');
        top.el.append(...top.kids); stack.pop();
      } else top.kids.push(d.createTextNode(unesc(m[4])));
    }
    if (last !== str.length || stack.length !== 1) throw new Error('incomplete');
    // モデルが落とした画像などのマーカーは末尾に補う
    unit.map.forEach((el, id) => { if (!used.has(id) && ATOMIC.has(el.tagName)) root.push(el.cloneNode(true)); });
    return root;
  } catch {
    // タグが壊れていた場合は書式を諦めて文字だけ表示
    return [d.createTextNode(unesc(str.replace(/<\/?g\d+\/?>/g, '')))];
  }
}

function setView(u, ja) {
  const target = ja && u.trans ? u.trans : u.orig;
  if (u.cur === target || !u.cur[0] || !u.cur[0].parentNode) return;
  const parent = u.cur[0].parentNode, anchor = u.cur[0];
  for (const n of target) parent.insertBefore(n, anchor);
  for (const n of u.cur) if (n.parentNode === parent) parent.removeChild(n);
  u.cur = target;
}
function setAllViews(ja) {
  showJa = ja;
  $('btnJa').setAttribute('aria-pressed', String(ja));
  $('btnOrig').setAttribute('aria-pressed', String(!ja));
  for (const u of units) setView(u, ja);
  if (doc) doc.documentElement.lang = ja ? 'ja' : origLang;
  fit();
}

/* ---------- 翻訳ループ ---------- */
function makeBatches(list) {
  const batches = []; let cur = [], chars = 0;
  const push = () => { if (cur.length) batches.push(cur); cur = []; chars = 0; };
  for (const e of list) {
    if (cur.length && (chars + e.text.length > BATCH_CHARS || cur.length >= BATCH_ITEMS)) push();
    cur.push(e); chars += e.text.length;
  }
  push();
  return batches;
}
async function translateBatch(batch) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return (await api('/api/translate', { items: batch, title: pageTitle })).items; }
    catch (e) {
      lastErr = e;
      if (e.fatal || e.code === 'BAD_REQUEST' || e.code === 'PAGE_TOO_LARGE' || attempt === 3) throw e;
      let sec = 2 * (attempt + 1);
      if (e.code === 'RATE_LIMITED') sec = Math.min(e.retryAfter || 20 * (attempt + 1), 90);
      for (let s = sec; s > 0; s--) {
        setStatus(e.code === 'RATE_LIMITED' ? `無料枠の制限のため待機中… あと${s}秒（翻訳済み：${done} / ${units.length}）` : `再試行しています…`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr;
}
function applyResult(items) {
  for (const it of items) {
    if (it.id === -1) { if (it.text.trim()) document.title = it.text.trim(); continue; }
    const u = units[it.id];
    if (!u || u.trans) continue;
    u.trans = build(u, it.text);
    done++;
    if (showJa) setView(u, true);
  }
  setStatus(`翻訳しています… 翻訳済み：${done} / ${units.length}`, done / units.length);
  fit();
}
async function runTranslation() {
  const list = [];
  if (pageTitle && document.title === 'AI翻訳') list.push({ id: -1, text: pageTitle });
  units.forEach((u, i) => { if (!u.trans) list.push({ id: i, text: u.src }); });
  const batches = makeBatches(list);
  let next = 0, fatalErr = null;
  $('btnRetry').hidden = true;
  const worker = async () => {
    while (next < batches.length && !fatalErr) {
      const b = batches[next++];
      try { applyResult(await translateBatch(b)); } catch (e) { if (e.fatal) fatalErr = e; }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (fatalErr) return showError(fatalErr);
  const failed = units.filter((u) => !u.trans).length;
  $('status').classList.add('done');
  if (failed) {
    setStatus(`一部を翻訳できませんでした（${failed}件）。翻訳済み：${done} / ${units.length}`);
    $('btnRetry').hidden = false;
  } else setStatus(`翻訳が完了しました（${done} / ${units.length}）`);
}

/* ---------- 起動 ---------- */
function mount(html) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 15000);
    frame.onload = () => { clearTimeout(t); resolve(); };
    frame.srcdoc = html;
  });
}
function wireLinks(d) {
  d.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    const raw = a.getAttribute('href') || '';
    if (raw.startsWith('#')) {
      let id = raw.slice(1); try { id = decodeURIComponent(id); } catch {}
      const t = d.getElementById(id) || d.getElementsByName(id)[0];
      if (t) window.scrollTo({ top: frame.getBoundingClientRect().top + window.scrollY + t.getBoundingClientRect().top });
      return;
    }
    if (/^(mailto|tel):/i.test(a.href)) { location.href = a.href; return; }
    // リンク先も翻訳ページとして開く
    if (/^https?:/i.test(a.href)) location.href = '/t?url=' + encodeURIComponent(a.href);
  });
}

async function main() {
  $('btnOpen').onclick = () => { location.href = finalUrl; };
  $('btnJa').onclick = () => setAllViews(true);
  $('btnOrig').onclick = () => setAllViews(false);
  $('btnRetry').onclick = () => { $('status').classList.remove('done'); runTranslation(); };
  if (!/^https?:\/\//i.test(targetUrl)) return showError(new ApiErr('BAD_URL', 'URLを受け取れませんでした。'));
  setStatus('ページを取得しています…');
  let data;
  try { data = await api('/api/fetch', { url: targetUrl }); } catch (e) { return showError(e); }
  finalUrl = data.finalUrl; pageTitle = data.title || ''; maxChars = data.maxChars || maxChars;
  CONCURRENCY = data.concurrency || CONCURRENCY; BATCH_CHARS = data.batchChars || BATCH_CHARS; BATCH_ITEMS = data.batchItems || BATCH_ITEMS;
  await mount(data.html);
  doc = frame.contentDocument;
  if (!doc || !doc.body) return showError(new ApiErr('FETCH_FAILED', 'ページを表示できませんでした。'));
  origLang = doc.documentElement.lang || '';
  wireLinks(doc);
  fit();
  units = collect(doc);
  if (!units.length) return showError(new ApiErr('NO_TEXT', '翻訳できる本文が見つかりませんでした。'));
  if (units.reduce((n, u) => n + u.src.length, 0) > maxChars) return showError(new ApiErr('PAGE_TOO_LARGE', 'ページが大きすぎるため翻訳できません。'));
  $('bar').hidden = false;
  setStatus(`翻訳しています… 翻訳済み：0 / ${units.length}`, 0);
  await runTranslation();
}
main();
})();
