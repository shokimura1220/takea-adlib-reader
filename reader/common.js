// Meta 広告ライブラリ（公開情報）を読む部品。読み取りのみ・広告のクリック用URLは開かない。
// 共通ヘルパ（competitor-diagnosis の各スクリプトが読む）。値・鍵は一切扱わない。
const fs = require('fs');
const path = require('path');

const PUPPETEER_PATH = process.env.PUPPETEER_PATH || 'puppeteer';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 引数: <config.json> [--flag value ...]。--only a,b でブランドを絞る
function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const nx = argv[i + 1];
      if (nx === undefined || nx.startsWith('--')) flags[k] = true; else { flags[k] = nx; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function loadConfig(argv) {
  const { pos, flags } = parseArgs(argv);
  if (!pos[0]) { console.error('usage: <script> <config.json> [flags]'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(path.resolve(pos[0]), 'utf8'));
  cfg.outDir = path.resolve(cfg.outDir);
  cfg.location_code = cfg.location_code || 2392;
  cfg.language_code = cfg.language_code || 'ja';
  cfg.dataDir = path.join(cfg.outDir, 'data');
  cfg.imgDir = path.join(cfg.outDir, 'images');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.imgDir, { recursive: true });
  if (flags.only) {
    const set = new Set(String(flags.only).split(','));
    cfg.brands = cfg.brands.filter(b => set.has(b.key));
  }
  return { cfg, flags };
}

const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));

// URL 正規化: クエリ・ハッシュ・末尾スラッシュを除く
function norm(u) {
  try { const x = new URL(u); return 'https://' + x.host + x.pathname.replace(/\/$/, ''); } catch (e) { return u; }
}

// 行き先の種類
const KIND_LABEL = { form: '募集フォーム', instagram: 'Instagram', article_lp: '記事型 LP', lp: 'LP', product: '商品ページ', other: 'トップ・その他' };
function destKind(u) {
  if (/docs\.google\.com\/forms|forms\.gle|typeform\.com/.test(u)) return 'form';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/\/ab\/[^/]+/.test(u)) return 'article_lp';
  if (/\/pages\/|\/lp[-_]?\d*(\/|$|\?)/i.test(u)) return 'lp';
  if (/\/products\//.test(u)) return 'product';
  if (/\/[A-Za-z]{1,6}\d{2,}(\/|$|\?)/.test(u)) return 'lp';
  return 'other';
}

// 掲載開始日 "2026/10/07 ..." / "2026年10月7日" -> epoch ms (JST 0時扱い) or null
function parseStart(s) {
  const m = String(s || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600e3;
}
const ymd = ms => ms == null ? null : new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

const adLibUrl = q => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=JP&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;
const advRegexOf = b => b.advertiserRegex || String(b.adLibQuery || b.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- 広告が「その会社のもの」かの判定（2026-10-19 夜・部分一致の廃止） ----
// 2026-10-19 の実測: 広告主名の部分一致（advertiserRegex）は、ブランド名が一般語の会社で別会社を拾った
//   例: arne → 「Arne Jacobsen Watches」12/13本、グロウ → 美容室・ヨガ教室 6/6本、ベルタ → 「belta_face」3本、ウェルネスダイニング → 「ヒルトン東京お台場」（TOKYO に一致）
// 規則（brands[].own = { domains: [...], names: [...] } があるときだけ有効。無ければ従来の advertiserRegex）:
//   ① 行き先URLのホストが own.domains（会社のドメイン＋そのサブドメイン）のどれかに入る
//   ② 広告主名が own.names のどれかと「完全一致」（株式会社等・空白・「X スポンサー: Y」の X・括弧書きの内外を分けて比べる。語尾の 本店/公式/オンラインショップ 等は除く）
// ★2026-10-20: 共用のサイト（予約・モール・SNS・リンク集）のホストは own.domains に足さない。美容室の予約ページ（beauty.hotpepper.jp）を足したため、同じサイトに出ている別の美容室の広告を自社分として数えた
const SHARED_HOST_RE = /instagram\.com|facebook\.com|apple\.com|play\.google\.com|lin\.ee|line\.me|hotpepper\.jp|rakuten\.co\.jp|amazon\.co\.jp|amazon\.com|yahoo\.co\.jp|shopping\.yahoo|qoo10|zozo\.jp|mercari|minne\.com|creema\.jp|linktr\.ee|lit\.link|tiktok\.com|youtube\.com|x\.com|twitter\.com|note\.com|ameblo\.jp|peatix\.com|google\.com|forms\.gle|bit\.ly/;
//   ①か②のどちらかで採用。②で採用した広告主の行き先ホストは、その場で own.domains に足す（同じ広告主の Instagram・アプリストア行きの広告を拾うため）
//   採用しなかったカードは excluded（広告主名 → 本数）に残す（人が見て own.names / own.domains に足せる）
const NAME_FORM_RE = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|\(株\)|（株）|\(有\)|（有）|㈱|㈲|co\.?,?\s*ltd\.?|inc\.?|k\.k\.?|corp\.?|corporation|company/gi;
const NAME_TAIL_RE = /(本店|公式|公式ショップ|公式ストア|公式サイト|公式通販|公式オンラインショップ|公式オンラインストア|オンラインショップ|オンラインストア|オンライン|通販|ショップ|ストア|official|officialshop|officialstore|onlineshop|onlinestore|online|shop|store|japan|jp)+$/i;
function normName(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(NAME_FORM_RE, '').replace(/[\s　・･,.、。!！?？&＆\-－_/／|｜:：「」『』【】'’"]/g, '');
}
// 広告主名 → 比べる語の一覧（外側・括弧の中・「スポンサー:」の右）。それぞれ正規化し、語尾の汎用語を除いた形も足す
function advNameTokens(adv) {
  let s = String(adv || '').normalize('NFKC');
  const sp = s.match(/スポンサー\s*[:：]\s*(.+)$/); if (sp) s = sp[1];
  const parts = [s.replace(/[（(][^）)]*[）)]/g, ''), ...[...s.matchAll(/[（(]([^）)]+)[）)]/g)].map(m => m[1])];
  const out = new Set();
  for (const p of parts) { const n = normName(p); if (!n) continue; out.add(n); const t = n.replace(NAME_TAIL_RE, ''); if (t.length >= 2) out.add(t); }
  return [...out];
}
function hostOfUrl(u) { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }
function ownershipOf(b) {
  if (!b || !b.own) return null;
  const names = new Set((b.own.names || []).map(normName).filter(n => n.length >= 2));
  for (const n of [...names]) { const t = n.replace(NAME_TAIL_RE, ''); if (t.length >= 2) names.add(t); }
  const domains = new Set((b.own.domains || []).map(d => String(d).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean).filter(d => !SHARED_HOST_RE.test(d)));
  return { names, domains };
}
const hostIn = (h, domains) => !!h && [...domains].some(d => h === d || h.endsWith('.' + d));
// 1枚のカードの判定。{ own: bool, by: 'domain'|'name'|null }
function judgeCard(card, own) {
  const h = hostOfUrl(card.lp);
  if (hostIn(h, own.domains)) return { own: true, by: 'domain' };
  const toks = advNameTokens(card.adv);
  // 短い英字名（arne 等）は同名の別会社が多いので、名前だけでは採用しない（行き先ドメインが要る）。実測: 「ＡＲＮＥ」＝花とギフトの店（楽天）が arne に混入
  const strong = t => t.length >= 5 || /[^\x00-\x7f]/.test(t);
  if (toks.some(t => own.names.has(t) && strong(t))) { if (h && !SHARED_HOST_RE.test(h)) own.domains.add(h); return { own: true, by: 'name' }; }
  return { own: false, by: null };
}
// カード一覧を採用・除外に分ける。採用の順番は元のまま。②で増えたドメインも返す
function splitOwn(cards, own) {
  const kept = [], excluded = {}, by = { domain: 0, name: 0 };
  // 先に②（名前の完全一致）を全カードに通してドメインを増やし、次に①②で判定する（並び順に依存しない）
  for (const c of cards) judgeCard(c, own);
  for (const c of cards) { const j = judgeCard(c, own); if (j.own) { kept.push(c); by[j.by]++; } else { const k = c.adv || '(広告主名なし)'; excluded[k] = (excluded[k] || 0) + 1; } }
  return { kept, excluded, by, domains: [...own.domains] };
}

module.exports = { PUPPETEER_PATH, sleep, parseArgs, loadConfig, readJson, writeJson, norm, destKind, KIND_LABEL, parseStart, ymd, adLibUrl, advRegexOf, esc, normName, advNameTokens, ownershipOf, judgeCard, splitOwn, hostOfUrl };
