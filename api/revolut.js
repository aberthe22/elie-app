// ═══════════════════════════════════════════════════════════
//  api/revolut.js  —  Vercel Serverless Function
//  Budget : catégorisation de transactions CSV via Haiku
//
//  POST  { transactions: [{date, label, amount}] }
//        → { categories, transactions, monthTotal, month }
//
//  Variables d'env requises :
//    ANTHROPIC_API_KEY
// ═══════════════════════════════════════════════════════════

const CATEGORY_KEYWORDS = {
  'Restaurants':  ['restaurant', 'bistrot', 'brasserie', 'café', 'pizza', 'sushi', 'burger', 'mc donald', 'mcdonald', 'kfc', 'subway', 'kebab', 'uber eat', 'deliveroo', 'just eat'],
  'Courses':      ['monoprix', 'carrefour', 'leclerc', 'lidl', 'aldi', 'intermarché', 'franprix', 'casino', 'picard', 'biocoop', 'naturalia'],
  'Transport':    ['sncf', 'ratp', 'navigo', 'blablacar', 'uber', 'bolt', 'free now', 'taxi', 'vélib', 'lime', 'tier'],
  'Voyages':      ['airbnb', 'booking', 'hotel', 'hôtel', 'ryanair', 'easyjet', 'air france', 'airport', 'aéroport'],
  'Shopping':     ['amazon', 'fnac', 'darty', 'zara', 'h&m', 'uniqlo', 'asos', 'zalando', 'vinted', 'leboncoin'],
  'Sorties':      ['cinema', 'cinéma', 'théâtre', 'concert', 'allocine', 'netflix', 'disney', 'spotify', 'deezer', 'canal'],
  'Logement':     ['loyer', 'edf', 'engie', 'eau', 'orange', 'free', 'sfr', 'bouygues', 'assurance habitation'],
  'Santé':        ['pharmacie', 'médecin', 'docteur', 'dentiste', 'kiné', 'ophtalmo', 'mutuelle', 'alan', 'doctolib'],
  'Abonnements':  ['apple', 'google', 'microsoft', 'adobe', 'chatgpt', 'openai', 'anthropic', 'github', 'notion', 'figma'],
  'Sport':        ['salle de sport', 'fitness', 'gym', 'decathlon', 'intersport', 'tennis', 'piscine', 'fit'],
  'Revenus':      [],   // montant positif → traité dans le code
};

function quickCategory(label, amount) {
  if (amount > 0) return 'Revenus';
  const low = label.toLowerCase();
  for (const [cat, keys] of Object.entries(CATEGORY_KEYWORDS)) {
    if (cat === 'Revenus') continue;
    if (keys.some(k => low.includes(k))) return cat;
  }
  return 'Autres';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST uniquement' });

  const { transactions } = req.body ?? {};
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'transactions[] requis' });
  }

  // ── Catégorisation : règles d'abord, Haiku pour les "Autres" ─────
  const categorized = transactions.map(tx => ({
    ...tx,
    category: quickCategory(tx.label ?? '', tx.amount ?? 0),
  }));

  // Passer les "Autres" à Haiku si la clé Claude est disponible
  const unknowns = categorized.filter(tx => tx.category === 'Autres' && tx.amount < 0);
  if (unknowns.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `Tu es un assistant de catégorisation de dépenses bancaires françaises.
Catégorise chaque transaction dans UNE seule catégorie parmi :
Restaurants, Courses, Transport, Voyages, Shopping, Sorties, Logement, Santé, Abonnements, Sport, Autres.

Réponds UNIQUEMENT avec un JSON valide : [{"id":1,"cat":"..."},{"id":2,"cat":"..."},...]

Transactions à catégoriser :
${unknowns.map((tx, i) => `[${i + 1}] ${tx.label} (${tx.amount}€)`).join('\n')}`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 512,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });

      if (aiRes.ok) {
        const aiData  = await aiRes.json();
        const rawText = aiData.content?.[0]?.text ?? '';
        const match   = rawText.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          parsed.forEach(item => {
            const idx = unknowns[item.id - 1];
            if (idx) {
              const tx = categorized.find(t => t === idx);
              if (tx) tx.category = item.cat || 'Autres';
            }
          });
        }
      }
    } catch (e) {
      console.warn('[budget/haiku]', e.message);
      // On continue avec les catégories par règles
    }
  }

  // ── Agrégation par catégorie ──────────────────────────────────────
  const byCategory = {};
  categorized.filter(t => t.amount < 0).forEach(t => {
    byCategory[t.category] = (byCategory[t.category] ?? 0) + Math.abs(t.amount);
  });
  const monthTotal  = Object.values(byCategory).reduce((s, v) => s + v, 0);
  const categories  = Object.entries(byCategory)
    .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  const now = new Date();
  return res.status(200).json({
    transactions: categorized.sort((a, b) => (b.date > a.date ? 1 : -1)),
    categories,
    monthTotal:   Math.round(monthTotal * 100) / 100,
    month:        now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
  });
}
