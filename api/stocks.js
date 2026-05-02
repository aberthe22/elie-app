// ═══════════════════════════════════════════════════════════
//  api/stocks.js  —  Vercel Serverless Function
//  · GET ?symbols=AAPL,IWDA.AS → cours Yahoo Finance (cache 5 min)
//  · GET ?portfolio=1           → holdings + settings + history depuis Notion
//  · POST action=saveHoldings   → sauvegarde les positions
//  · POST action=saveSettings   → sauvegarde les paramètres
//  · POST action=saveSnapshot   → snapshot journalier {date, value, qqq}
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token        = process.env.NOTION_TOKEN;
  const CONFIG_DB_ID = process.env.NOTION_CONFIG_DB_ID;
  const NOTION_API   = 'https://api.notion.com/v1';

  const notionHeaders = () => ({
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  });

  async function getConfig(key) {
    if (!CONFIG_DB_ID) return null;
    const r = await fetch(`${NOTION_API}/databases/${CONFIG_DB_ID}/query`, {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
    });
    const d = await r.json();
    return d.results?.[0]?.properties['Valeur']?.rich_text?.[0]?.plain_text ?? null;
  }

  async function setConfig(key, value) {
    if (!CONFIG_DB_ID) throw new Error('NOTION_CONFIG_DB_ID manquant');
    const search = await fetch(`${NOTION_API}/databases/${CONFIG_DB_ID}/query`, {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
    });
    const found = await search.json();
    const props = {
      'Clé':    { title:     [{ text: { content: key   } }] },
      'Valeur': { rich_text: [{ text: { content: value } }] },
    };
    if (found.results?.length > 0) {
      await fetch(`${NOTION_API}/pages/${found.results[0].id}`, {
        method: 'PATCH', headers: notionHeaders(),
        body: JSON.stringify({ properties: { 'Valeur': props['Valeur'] } }),
      });
    } else {
      await fetch(`${NOTION_API}/pages`, {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: CONFIG_DB_ID }, properties: props }),
      });
    }
  }

  // ── POST ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, holdings, settings, date, value, qqq } = req.body ?? {};

    if (action === 'saveHoldings' && holdings !== undefined) {
      await setConfig('portfolio_holdings', JSON.stringify(holdings));
      return res.status(200).json({ ok: true });
    }

    if (action === 'saveSettings' && settings !== undefined) {
      await setConfig('portfolio_settings', JSON.stringify(settings));
      return res.status(200).json({ ok: true });
    }

    // Snapshot journalier : upsert du jour, garde 400 points max
    if (action === 'saveSnapshot' && date && value !== undefined) {
      const histStr = await getConfig('portfolio_history');
      const hist    = histStr ? JSON.parse(histStr) : [];
      const idx     = hist.findIndex(p => p.date === date);
      const entry   = { date, value: Math.round(value * 100) / 100, ...(qqq ? { qqq } : {}) };
      if (idx >= 0) hist[idx] = entry;
      else          hist.push(entry);
      hist.sort((a, b) => a.date.localeCompare(b.date));
      await setConfig('portfolio_history', JSON.stringify(hist.slice(-400)));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'action inconnue' });
  }

  // ── GET ?portfolio=1 ──────────────────────────────────────
  if (req.query?.portfolio === '1') {
    const [holdingsStr, settingsStr, historyStr] = await Promise.all([
      getConfig('portfolio_holdings'),
      getConfig('portfolio_settings'),
      getConfig('portfolio_history'),
    ]);

    const holdings = holdingsStr ? JSON.parse(holdingsStr) : [];
    const settings = settingsStr ? JSON.parse(settingsStr) : {
      annualReturn:   8,
      targetValue:    1000000,
      monthlyContrib: 0,
    };
    const history = historyStr ? JSON.parse(historyStr) : [];

    return res.status(200).json({ holdings, settings, history });
  }

  // ── GET ?symbols=AAPL,IWDA.AS ─────────────────────────────
  const symbolsParam = req.query?.symbols;
  if (symbolsParam) {
    const symbols    = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
    // Toujours inclure EURUSD=X et QQQ pour le benchmark
    const allSymbols = [...new Set([...symbols, 'EURUSD=X', 'QQQ'])];

    const results = await Promise.allSettled(allSymbols.map(sym => fetchPrice(sym)));

    const prices = {};
    allSymbols.forEach((sym, i) => {
      if (results[i].status === 'fulfilled') prices[sym] = results[i].value;
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ prices, fetchedAt: new Date().toISOString() });
  }

  return res.status(400).json({ error: 'Paramètres manquants' });
}

// ── Yahoo Finance ─────────────────────────────────────────
async function fetchPrice(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Elie-PWA/1.0)',
      'Accept':     'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const data = await r.json();
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No data for ${symbol}`);
  return {
    symbol,
    price:    meta.regularMarketPrice    ?? meta.previousClose,
    currency: meta.currency              ?? 'USD',
    change:   meta.regularMarketChangePercent ?? 0,
    name:     meta.longName ?? meta.shortName ?? symbol,
  };
}
