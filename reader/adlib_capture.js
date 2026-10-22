// Meta 広告ライブラリ（公開情報）を読む部品。読み取りのみ・広告のクリック用URLは開かない。
// adlib_capture.js — ブランドごとに Meta 広告ライブラリのカードのスクショ（最大 N 枚）と、
// 行き先 LP のスマホ表示スクショ（LP 最大2本 × 3画面）・LP 本文テキストを撮る。
//
// 使い方:
//   node adlib_capture.js <config.json> [--max 12] [--only silkfull,zinzo]
// 出力: <outDir>/images/ad_{key}_{i}.png ・ lp_{key}_{j}_{s}.png
//       <outDir>/data/adlib_capture.json
// 軽い一回限りの利用を前提: スクロール間 2.2 秒・ブランド間 3 秒、ページは並列に開かない。
// 広告主名が一致しないブランドは status "取得できず"（0本とは別物）。
// brands[].own = { domains, names } があるときは advertiserRegex を使わず「行き先ドメイン一致 or 広告主名の完全一致」で撮る（common.js の judgeCard）
const { PUPPETEER_PATH, sleep, loadConfig, writeJson, norm, adLibUrl, advRegexOf, ownershipOf, judgeCard } = require('./common.js');
const puppeteer = require(PUPPETEER_PATH);

(async () => {
  const { cfg, flags } = loadConfig(process.argv.slice(2));
  const MAX = parseInt(flags.max, 10) || 12;
  const b = await puppeteer.launch({ headless: 'new', args: ['--lang=ja-JP', ...(process.env.CLOUD_ADLIB ? ['--no-sandbox'] : [])] });
  const all = { fetchedAt: new Date().toISOString(), brands: {} };

  for (const br of cfg.brands) {
    const q = br.adLibQuery || br.name;
    const p = await b.newPage();
    try {
      await p.setViewport({ width: 1366, height: 1600 });
      await p.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
      await p.goto(adLibUrl(q), { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      for (let i = 0; i < 5; i++) { await p.evaluate(() => window.scrollBy(0, 2500)); await sleep(2200); }
      await p.evaluate(() => window.scrollTo(0, 0)); await sleep(1200);
      const own = ownershipOf(br);
      // 1) 全カードに通し番号を付け、広告主名と行き先を Node 側へ返す
      const allCards = await p.evaluate(() => {
        const nodes = [...document.querySelectorAll('span,div')].filter(e => e.childElementCount === 0 && /ライブラリID/.test(e.textContent));
        let k = 0; const seen = new Set(); const list = [];
        for (const nd of nodes) {
          let el = nd;
          while (el && !(el.offsetWidth >= 300 && el.offsetWidth <= 520 && el.offsetHeight >= 350)) el = el.parentElement;
          if (!el || seen.has(el)) continue; seen.add(el);
          const lines = el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
          const si = lines.indexOf('スポンサー広告');
          const adv = si > 0 ? lines[si - 1] : '';
          let lp = '';
          for (const a of el.querySelectorAll('a[href]')) { try { const u = new URL(a.href); const v = u.searchParams.get('u'); const h = v || a.href; if (!/facebook\.com|fb\.me/.test(h)) { lp = h; break; } } catch (x) {} }
          el.setAttribute('data-all', String(k)); list.push({ i: k, adv, lp }); k++;
        }
        return list;
      });
      // 2) 採用するカードを決める（own があればドメイン一致/名前の完全一致、無ければ従来の正規表現）
      let keep;
      if (own) { for (const c of allCards) judgeCard(c, own); keep = allCards.filter(c => judgeCard(c, own).own); }
      else { const re = new RegExp(advRegexOf(br), 'i'); keep = allCards.filter(c => re.test(c.adv)); }
      // 3) 採用カードに data-comp を振る
      const n = await p.evaluate(idx => { let k = 0; for (const i of idx) { const el = document.querySelector(`[data-all="${i}"]`); if (el) el.setAttribute('data-comp', String(k++)); } return k; }, keep.map(c => c.i));
      const total = await p.evaluate(() => (document.body.innerText.match(/検索結果: ([^\n]+)/) || [])[1] || '');
      const ads = [];
      for (let i = 0; i < Math.min(n, MAX); i++) {
        const el = await p.$(`[data-comp="${i}"]`); if (!el) continue;
        try {
          await el.scrollIntoView(); await sleep(600);
          const info = await p.evaluate(e => {
            const t = e.innerText;
            const start = (t.match(/掲載開始日: ([^\n]+)/) || [])[1] || '';
            const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
            const si = lines.indexOf('スポンサー広告');
            const body = si > 0 ? lines.slice(si + 1, si + 8).join(' / ') : '';
            const dur = (t.match(/0:00 \/ (\d+:\d+)/) || [])[1] || '';
            const links = [...e.querySelectorAll('a[href]')].map(a => a.href).filter(h => /l\.facebook\.com\/l\.php\?u=|^https?:\/\/(?!www\.facebook\.com)/.test(h));
            let lp = '';
            for (const h of links) { try { const u = new URL(h); lp = u.searchParams.get('u') || h; if (lp && !/facebook\.com/.test(lp)) break; } catch (x) {} }
            return { start, body: body.slice(0, 400), dur, lp };
          }, el);
          const file = `ad_${br.key}_${i + 1}.png`;
          await el.screenshot({ path: `${cfg.imgDir}/${file}` });
          ads.push({ file, ...info });
        } catch (e) { /* この1枚は飛ばす */ }
      }
      all.brands[br.key] = n === 0
        ? { key: br.key, status: '取得できず', reason: '広告主名が一致するカード0件。advertiserRegex を確認', q, total, matchedCards: 0, ads: [], lps: [] }
        : { key: br.key, status: 'ok', q, total, matchedCards: n, ads, lps: [] };
      console.log(br.key, total, 'matched', n, 'captured', ads.length);
    } catch (e) {
      all.brands[br.key] = { key: br.key, status: '取得できず', reason: String(e.message || e).slice(0, 200), q, ads: [], lps: [] };
      console.log(br.key, '取得できず', e.message);
    }
    await p.close(); await sleep(3000);
  }

  // LP（行き先が同じものは1本とみなし、ブランドごとに最大2本）をスマホ幅で3画面撮る
  for (const br of cfg.brands) {
    const rec = all.brands[br.key]; if (!rec || rec.status !== 'ok') continue;
    const seen = new Set(); const lps = [];
    // 広告の計測・クリック用URL（l.facebook / 楽天 ias / a8 等）は開かない（相手の広告費を使わせる）。楽天 ias は r= の着地URLに置き換える
    const TRK = /(^|\.)(l\.facebook\.com|lm\.facebook\.com|ias\.rakuten\.co\.jp|resultplus2\.jp|a8\.net|valuecommerce\.com|afi-b\.com|accesstrade\.net|rentracks\.jp|adsrvr\.org|doubleclick\.net|googleadservices\.com)$|^(ad|ads|click|clk|track|trk|redirect|go|link)\d*\./i;
    const safeLp = u => { try { const x = new URL(u); if (/(^|\.)ias\.rakuten\.co\.jp$/.test(x.host)) { const r = x.searchParams.get('r'); if (r && /^https?:\/\//.test(r)) return safeLp(r); } return TRK.test(x.host.replace(/^www\./, '')) ? null : u; } catch (e) { return null; } };
    for (const a of rec.ads) { if (!a.lp) continue; const s = safeLp(a.lp); if (!s) continue; const k = norm(s); if (seen.has(k)) continue; seen.add(k); lps.push(s); if (lps.length >= 2) break; }
    for (let j = 0; j < lps.length; j++) {
      const p = await b.newPage();
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
      try {
        await p.goto(lps[j], { waitUntil: 'networkidle2', timeout: 60000 }); await sleep(3500);
        const final = p.url();
        const text = await p.evaluate(() => document.body.innerText.replace(/\n+/g, ' / ').slice(0, 3000));
        const shots = [];
        for (let s = 0; s < 3; s++) {
          await p.evaluate(y => window.scrollTo(0, y), s * 844); await sleep(900);
          const f = `lp_${br.key}_${j + 1}_${s + 1}.png`;
          await p.screenshot({ path: `${cfg.imgDir}/${f}` }); shots.push(f);
        }
        rec.lps.push({ url: lps[j], final, text, shots });
      } catch (e) { rec.lps.push({ url: lps[j], err: String(e.message || e).slice(0, 200), shots: [] }); }
      await p.close(); await sleep(2000);
    }
    console.log(br.key, 'LP captured', rec.lps.filter(l => l.shots.length).length, '/', lps.length);
  }
  // cfg.merge = 'c' のとき: 検索語ごとの撮影物を1つ（brands[c]）にまとめる（画像ファイル名は ad_<key>_i.png で衝突しない）
  if (cfg.merge) {
    const recs = Object.values(all.brands); const ads = []; const lps = []; const seenLp = new Set(); let matched = 0;
    for (const r of recs) { matched += r.matchedCards || 0; for (const a of r.ads || []) if (ads.length < MAX) ads.push(a); for (const l of r.lps || []) { const k = norm(l.url); if (!seenLp.has(k)) { seenLp.add(k); lps.push(l); } } }
    all.brands[cfg.merge] = ads.length ? { key: cfg.merge, status: 'ok', q: recs.map(r => r.q).join(' | '), total: null, matchedCards: matched, ads, lps } : { key: cfg.merge, status: '取得できず', reason: '会社のものと判定できるカード0件', q: recs.map(r => r.q).join(' | '), matchedCards: 0, ads: [], lps: [] };
  }
  writeJson(cfg.dataDir + '/adlib_capture.json', all);
  await b.close();
  console.log('wrote', cfg.dataDir + '/adlib_capture.json');
})();
