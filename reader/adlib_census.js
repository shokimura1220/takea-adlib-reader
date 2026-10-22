// Meta 広告ライブラリ（公開情報）を読む部品。読み取りのみ・広告のクリック用URLは開かない。
// adlib_census.js — Meta 広告ライブラリ（日本・配信中）をブランドごとにスクロールし、全カードの
// 広告主 / 掲載開始日 / 動画か / 行き先URL を集める。スクショは撮らない。
//
// 使い方:
//   node adlib_census.js <config.json> [--only silkfull,zinzo]
// 出力: <outDir>/data/adlib_census.json と、ブランドごとの要約を標準出力。
//   status "ok" = 広告主名が一致するカードを取得 / "取得できず" = 一致0件（広告主名が検索語と違う等。0本とは別物）
// 軽い一回限りの利用を前提: スクロール間 2.5 秒・ブランド間 4 秒、ページは並列に開かない。
// 設定: brands[].adLibQuery（検索語）/ advertiserRegex（広告主名の一致）/ scrolls（既定6）
// brands[].own = { domains, names } があるときは advertiserRegex を使わず「行き先ドメイン一致 or 広告主名の完全一致」で採用する（common.js の splitOwn）。除外は excluded に残す
const { PUPPETEER_PATH, sleep, loadConfig, writeJson, norm, destKind, parseStart, ymd, adLibUrl, advRegexOf, ownershipOf, splitOwn } = require('./common.js');
const puppeteer = require(PUPPETEER_PATH);

function summarize(cards, now = Date.now()) {
  const starts = cards.map(c => parseStart(c.start)).filter(x => x != null);
  const dest = {};
  for (const c of cards) if (c.lp) { const n = norm(c.lp); dest[n] = (dest[n] || 0) + 1; }
  const destList = Object.entries(dest).sort((a, b) => b[1] - a[1]);
  const kinds = {}; for (const [u] of destList) { const k = destKind(u); kinds[k] = (kinds[k] || 0) + 1; }
  return {
    cards: cards.length,
    video: cards.filter(c => c.video).length,
    new30: starts.filter(s => now - s < 30 * 864e5).length,
    over1y: starts.filter(s => now - s > 365 * 864e5).length,
    oldestStart: starts.length ? ymd(Math.min(...starts)) : null,
    uniqueDestinations: destList.length,
    destKinds: kinds,
    destinations: destList.map(([url, n]) => ({ url, n, kind: destKind(url) })),
  };
}

(async () => {
  const { cfg } = loadConfig(process.argv.slice(2));
  const b = await puppeteer.launch({ headless: 'new', args: ['--lang=ja-JP', ...(process.env.CLOUD_ADLIB ? ['--no-sandbox'] : [])] });
  const out = { fetchedAt: new Date().toISOString(), brands: {} };
  for (const br of cfg.brands) {
    const q = br.adLibQuery || br.name; const scrolls = br.scrolls || 6;
    const p = await b.newPage();
    let rec;
    try {
      await p.setViewport({ width: 1366, height: 1600 });
      await p.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
      await p.goto(adLibUrl(q), { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      for (let i = 0; i < scrolls; i++) { await p.evaluate(() => window.scrollBy(0, 3000)); await sleep(2500); }
      const own = ownershipOf(br);
      const r = await p.evaluate((advReS) => {
        const re = advReS == null ? null : new RegExp(advReS, 'i'); // null = 全カードを返す（採用の判定は Node 側の splitOwn）
        const nodes = [...document.querySelectorAll('span,div')].filter(e => e.childElementCount === 0 && /ライブラリID/.test(e.textContent));
        const seen = new Set(); const cards = []; let allCards = 0; const advs = {};
        for (const nd of nodes) {
          let el = nd;
          while (el && !(el.offsetWidth >= 300 && el.offsetWidth <= 520 && el.offsetHeight >= 300)) el = el.parentElement;
          if (!el || seen.has(el)) continue; seen.add(el); allCards++;
          const t = el.innerText; const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
          const si = lines.indexOf('スポンサー広告'); const adv = si > 0 ? lines[si - 1] : '';
          if (adv) advs[adv] = (advs[adv] || 0) + 1;
          if (re && !re.test(adv)) continue;
          const start = (t.match(/掲載開始日: ([^\n]+)/) || [])[1] || '';
          const video = /0:00 \/ \d+:\d+/.test(t); const multi = /複数のバージョン|複数版/.test(t);
          let lp = '';
          for (const a of el.querySelectorAll('a[href]')) { try { const u = new URL(a.href); const v = u.searchParams.get('u'); const h = v || a.href; if (!/facebook\.com|fb\.me/.test(h)) { lp = h; break; } } catch (x) {} }
          const id = (t.match(/ライブラリID: (\d+)/) || [])[1] || '';
          const text = si >= 0 ? lines.slice(si + 1, si + 14).filter(l => !/^\d+:\d+(\s*\/\s*\d+:\d+)?$/.test(l)).slice(0, 10).join(' / ').slice(0, 600) : ''; // 広告の本文（スポンサー広告の次の行から）。追加項目
          cards.push({ adv, start, video, multi, lp, id, text });
        }
        return { total: (document.body.innerText.match(/検索結果: ([^\n]+)/) || [])[1] || '', allCards, cards, advs };
      }, own ? null : advRegexOf(br));
      const seenAdvertisers = Object.fromEntries(Object.entries(r.advs || {}).sort((a, b) => b[1] - a[1]).slice(0, 20)); // 一致しなかったカードも含む（ブランド名の修正材料）
      let uniq = []; const ids = new Set();
      for (const c of r.cards) { if (c.id && ids.has(c.id)) continue; if (c.id) ids.add(c.id); uniq.push(c); }
      let ownInfo = null;
      if (own) { const s = splitOwn(uniq, own); uniq = s.kept; ownInfo = { rule: 'domain_or_exact_name', names: [...own.names], domains: s.domains, matched_by: s.by, excluded: s.excluded }; }
      if (!uniq.length) rec = { key: br.key, status: '取得できず', reason: own ? `会社のものと判定できるカード0件（読み込んだ全カード ${r.allCards}・検索結果 ${r.total || '不明'}）。excluded の広告主名を見て own.names / own.domains を直す` : `広告主名が一致するカード0件（読み込んだ全カード ${r.allCards}・検索結果 ${r.total || '不明'}）。advertiserRegex を確認`, query: q, total: r.total, loadedCards: r.allCards, seenAdvertisers, own: ownInfo, cards: [] };
      else rec = { key: br.key, status: 'ok', query: q, total: r.total, loadedCards: r.allCards, seenAdvertisers, own: ownInfo, cards: uniq, summary: summarize(uniq) };
    } catch (e) {
      rec = { key: br.key, status: '取得できず', reason: String(e.message || e).slice(0, 200), query: q, cards: [] };
    }
    out.brands[br.key] = rec;
    if (rec.status === 'ok') {
      const s = rec.summary;
      console.log(`${br.key}: cards ${s.cards} / video ${s.video} / new30 ${s.new30} / >1y ${s.over1y} / oldest ${s.oldestStart} / destinations ${s.uniqueDestinations} ${JSON.stringify(s.destKinds)}  (検索結果: ${rec.total})${rec.own ? ` 採用 domain ${rec.own.matched_by.domain}・name ${rec.own.matched_by.name} / 除外 ${Object.values(rec.own.excluded).reduce((a, b) => a + b, 0)}本 ${JSON.stringify(rec.own.excluded).slice(0, 200)}` : ''}`);
    } else console.log(`${br.key}: 取得できず — ${rec.reason}`);
    await p.close(); await sleep(4000);
  }
  // cfg.merge = 'c' のとき: 複数の検索語（brands[]）で採ったカードを ID で重複を除いて1つ（brands[c]）にまとめる（ブランド名検索が0件になる会社を業種の語で引くため・2026-10-20）
  if (cfg.merge) {
    const recs = Object.values(out.brands); const ids = new Set(); const cards = []; const excluded = {}; const by = { domain: 0, name: 0 }; const seenAdv = {}; let loaded = 0;
    for (const r of recs) { loaded += r.loadedCards || 0; for (const [k, v] of Object.entries(r.seenAdvertisers || {})) seenAdv[k] = (seenAdv[k] || 0) + v; for (const [k, v] of Object.entries(r.own?.excluded || {})) excluded[k] = (excluded[k] || 0) + v; by.domain += r.own?.matched_by?.domain || 0; by.name += r.own?.matched_by?.name || 0; for (const c of r.cards || []) { if (c.id && ids.has(c.id)) continue; if (c.id) ids.add(c.id); cards.push(c); } }
    const queries = recs.map(r => r.query);
    out.brands[cfg.merge] = cards.length
      ? { key: cfg.merge, status: 'ok', query: queries.join(' | '), queries, total: null, loadedCards: loaded, seenAdvertisers: Object.fromEntries(Object.entries(seenAdv).sort((a, b) => b[1] - a[1]).slice(0, 20)), own: { rule: 'domain_or_exact_name', matched_by: by, excluded, merged_from: recs.length }, cards, summary: summarize(cards) }
      : { key: cfg.merge, status: '取得できず', reason: `会社のものと判定できるカード0件（検索語 ${recs.length} 本・読み込んだ全カード ${loaded}）`, query: queries.join(' | '), queries, loadedCards: loaded, seenAdvertisers: seenAdv, own: { excluded, matched_by: by, merged_from: recs.length }, cards: [] };
    console.log(`merge → ${cfg.merge}: cards ${cards.length}（検索語 ${recs.length} 本・読み込み ${loaded}）`);
  }
  writeJson(cfg.dataDir + '/adlib_census.json', out);
  await b.close();
  console.log('wrote', cfg.dataDir + '/adlib_census.json');
})();
