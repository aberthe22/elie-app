// ═══════════════════════════════════════════════════════════
//  api/news.js  —  Vercel Serverless Function
//  Agrège les actualités RSS françaises par domaine :
//  · finance  : Les Échos, Le Figaro Économie
//  · ia       : Le Monde IA, 01net
//  · crypto   : Journal du Coin, Cryptoast
//  Renvoie les articles des 3 derniers jours
// ═══════════════════════════════════════════════════════════

const FEEDS = {
  finance: [
    'https://www.lefigaro.fr/rss/figaro_economie.xml',
    'https://www.lemonde.fr/economie/rss_full.xml',
  ],
  ia: [
    'https://www.lemonde.fr/intelligence-artificielle/rss_full.xml',
    'https://www.01net.com/rss/actualites/',
  ],
  crypto: [
    'https://journalducoin.com/feed/',
    'https://cryptoast.fr/feed/',
  ],
};

// Mots-clés pour filtrer les articles IA dans le feed 01net (généraliste)
const AI_KEYWORDS = ['ia', 'intelligence artificielle', 'machine learning', 'llm', 'chatgpt', 'openai', 'anthropic', 'gemini', 'mistral', 'modèle', 'algorithme', 'robot'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cache côté Vercel CDN : 1h (les news ne changent pas à la seconde)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');

  const days    = parseInt(req.query?.days ?? '3', 10);
  const symbols = req.query?.symbols ? req.query.symbols.split(',').map(s => s.trim()).filter(Boolean) : [];

  // ── Mode stock news (portefeuille investissements) ───────
  if (symbols.length > 0) {
    try {
      const articles = await fetchStockNews(symbols, days);
      return res.status(200).json({ articles, fetchedAt: new Date().toISOString() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const cutoff = new Date(Date.now() - days * 86_400_000);

  try {
    // ── Fetch tous les feeds en parallèle ──────────────────
    const results = await Promise.allSettled([
      ...FEEDS.finance.map(u => fetchFeed(u, 'finance')),
      ...FEEDS.ia.map(u => fetchFeed(u, 'ia')),
      ...FEEDS.crypto.map(u => fetchFeed(u, 'crypto')),
    ]);

    const allItems = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // ── Filtrer par date & dédupliquer par titre ───────────
    const seen   = new Set();
    const recent = allItems.filter(item => {
      if (!item.date || item.date < cutoff) return false;
      // Filtre IA sur TechCrunch
      if (item.domain === 'ia' && item.source === '01net') {
        const hay = (item.title + ' ' + item.summary).toLowerCase();
        if (!AI_KEYWORDS.some(kw => hay.includes(kw))) return false;
      }
      const key = item.title.slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── Top 3 par domaine, triés par date desc ─────────────
    const byDomain = {};
    for (const domain of ['finance', 'ia', 'crypto']) {
      byDomain[domain] = recent
        .filter(i => i.domain === domain)
        .sort((a, b) => b.date - a.date);
    }

    return res.status(200).json({
      finance: byDomain.finance,
      ia:      byDomain.ia,
      crypto:  byDomain.crypto,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[api/news]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Fetch + parse un feed RSS ──────────────────────────────
async function fetchFeed(url, domain) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Elie-PWA/1.0 RSS-reader' },
    });
    clearTimeout(timeout);
    if (!r.ok) return [];
    const xml = await r.text();
    return parseRss(xml, domain, url);
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

// ── Parser RSS minimal (pas de lib externe) ────────────────
function parseRss(xml, domain, feedUrl) {
  const source = feedUrl.includes('lefigaro') ? 'lefigaro'
    : feedUrl.includes('lemonde') ? 'lemonde'
    : feedUrl.includes('01net') ? '01net'
    : feedUrl.includes('journalducoin') ? 'journalducoin'
    : feedUrl.includes('cryptoast') ? 'cryptoast'
    : 'unknown';

  const items = [];
  // Extraction des blocs <item>
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title   = stripHtml(extractTag(block, 'title'));
    const link    = extractTag(block, 'link') || extractTag(block, 'guid');
    const dateStr = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'updated');
    const summary = stripHtml(
      extractTag(block, 'description') ||
      extractTag(block, 'content:encoded') ||
      extractTag(block, 'summary') || ''
    ).slice(0, 200);

    if (!title || !link) continue;

    const date = dateStr ? new Date(dateStr) : null;
    if (!date || isNaN(date.getTime())) continue;

    items.push({ title, link, summary, date, domain, source });
  }
  return items;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  return (m?.[1] ?? m?.[2] ?? '').trim();
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── STOCK NEWS via Yahoo Finance (appelé si ?symbols=NVDA,META...) ──
async function fetchStockNews(symbols, days) {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const results = await Promise.allSettled(
    symbols.slice(0, 6).map(sym => fetchYahooNews(sym))
  );
  const seen = new Set();
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(a => {
      if (a.date && a.date < cutoff) return false;
      const key = a.title.slice(0, 50).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.date || 0) - (a.date || 0));
}

async function fetchYahooNews(symbol) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6&enableFuzzyQuery=false`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Elie-PWA/1.0)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.news ?? []).map(n => ({
      title:     n.title ?? '',
      url:       n.link  ?? '',
      source:    n.publisher ?? '',
      symbol,
      date:      n.providerPublishTime ? new Date(n.providerPublishTime * 1000) : null,
    })).filter(n => n.title);
  } catch { return []; }
}
