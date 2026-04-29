// ═══════════════════════════════════════════════════════════
//  api/news.js  —  Vercel Serverless Function
//  Agrège les actualités RSS par domaine :
//  · finance  : Yahoo Finance (marchés), Reuters Biz
//  · ia       : MIT Tech Review, TechCrunch AI
//  · crypto   : CoinDesk, CoinTelegraph
//  Renvoie top 3 par domaine + les articles des 3 derniers jours
// ═══════════════════════════════════════════════════════════

const FEEDS = {
  finance: [
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US',
    'https://feeds.reuters.com/reuters/businessNews',
  ],
  ia: [
    'https://www.technologyreview.com/feed/',
    'https://techcrunch.com/feed/',
  ],
  crypto: [
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss',
  ],
};

// Mots-clés pour filtrer les articles IA dans le feed TechCrunch (généraliste)
const AI_KEYWORDS = ['ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'openai', 'anthropic', 'google deepmind', 'mistral', 'model', 'neural'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cache côté Vercel CDN : 1h (les news ne changent pas à la seconde)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');

  const days = parseInt(req.query?.days ?? '3', 10); // nb de jours d'historique
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
      if (item.domain === 'ia' && item.source === 'techcrunch') {
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
  const source = feedUrl.includes('yahoo') ? 'yahoo'
    : feedUrl.includes('reuters') ? 'reuters'
    : feedUrl.includes('technologyreview') ? 'mit'
    : feedUrl.includes('techcrunch') ? 'techcrunch'
    : feedUrl.includes('coindesk') ? 'coindesk'
    : feedUrl.includes('cointelegraph') ? 'cointelegraph'
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
