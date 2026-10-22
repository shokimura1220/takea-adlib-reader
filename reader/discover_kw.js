// Meta 広告ライブラリ（公開情報）を、検索語ごとに開いて広告主を拾う。読み取りのみ・広告のクリック用URLは開かない。
// 使い方: node discover_kw.js <config.json>   config = { outDir, scrolls, keywords: [{ key, kw }] }
// 出力: <outDir>/data/discover.json = { runs: { key: { status, total, cards:[{adv,start,video,lp,pageId,id}] } } }
const fs = require('fs');
const { PUPPETEER_PATH, sleep, writeJson } = require('./common.js');
const puppeteer = require(PUPPETEER_PATH);
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const url = q => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=JP&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;
(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--lang=ja-JP', ...(process.env.CLOUD_ADLIB ? ['--no-sandbox'] : [])] });
  const runs = {}; const scrolls = cfg.scrolls || 6; let zero = 0;
  for (const j of cfg.keywords || []) {
    const p = await b.newPage(); let rec;
    try {
      await p.setViewport({ width: 1366, height: 1600 });
      await p.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
      await p.goto(url(j.kw), { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      for (let i = 0; i < scrolls; i++) { await p.evaluate(() => window.scrollBy(0, 3000)); await sleep(2500); }
      const r = await p.evaluate(() => {
        const nodes = [...document.querySelectorAll('span,div')].filter(e => e.childElementCount === 0 && /ライブラリID/.test(e.textContent));
        const seen = new Set(); const cards = [];
        for (const nd of nodes) {
          let el = nd;
          while (el && !(el.offsetWidth >= 300 && el.offsetWidth <= 520 && el.offsetHeight >= 300)) el = el.parentElement;
          if (!el || seen.has(el)) continue; seen.add(el);
          const t = el.innerText; const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
          const si = lines.indexOf('スポンサー広告'); const adv = si > 0 ? lines[si - 1] : '';
          if (!adv) continue;
          const start = (t.match(/掲載開始日: ([^\n]+)/) || [])[1] || '';
          const video = /0:00 \/ \d+:\d+/.test(t);
          let lp = '', pageId = '';
          for (const a of el.querySelectorAll('a[href]')) {
            const pm = a.href.match(/view_all_page_id=(\d+)/); if (pm && !pageId) pageId = pm[1];
            if (lp) continue;
            try { const u = new URL(a.href); const v = u.searchParams.get('u'); const h = v || a.href; if (!/facebook\.com|fb\.me/.test(h)) lp = h; } catch (x) {}
          }
          const id = (t.match(/ライブラリID: (\d+)/) || [])[1] || '';
          cards.push({ adv, start, video, lp, pageId, id });
        }
        return { total: (document.body.innerText.match(/検索結果: ([^\n]+)/) || [])[1] || '', cards };
      });
      rec = { status: 'ok', total: r.total, cards: r.cards };
    } catch (e) { rec = { status: '取得できず', reason: String(e.message || e).slice(0, 200), cards: [] }; }
    await p.close();
    if (!rec.cards.length) { zero++; if (zero >= 3) break; } else { zero = 0; runs[j.key] = rec; } // 0件は記録しない・3語続いたら止める
    await sleep(4000);
  }
  await b.close();
  writeJson(cfg.outDir + '/data/discover.json', { runs });
  console.log(`語 ${Object.keys(runs).length}/${(cfg.keywords || []).length} を記録`);
})();
