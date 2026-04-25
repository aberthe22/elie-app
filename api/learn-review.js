// ═══════════════════════════════════════════════════════════
//  api/learn-review.js  —  Vercel Serverless Function
//
//  Met à jour une carte après révision :
//    action "know"   → avance le palier, calcule prochaine révision
//    action "review" → remet à J+1, révision demain
//
//  Body : { cardId: string, action: "know" | "review", currentPalier: string }
//
//  Variables d'env requises :
//    NOTION_TOKEN
// ═══════════════════════════════════════════════════════════

const PALIERS = ['J+1', 'J+3', 'J+7', 'J+14', 'J+30', 'J+60', 'Maîtrisé'];
const DAYS    = { 'J+1': 1, 'J+3': 3, 'J+7': 7, 'J+14': 14, 'J+30': 30, 'J+60': 60 };

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextPalier(current) {
  const idx = PALIERS.indexOf(current);
  if (idx === -1 || idx >= PALIERS.length - 1) return 'Maîtrisé';
  return PALIERS[idx + 1];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) return res.status(500).json({ error: 'NOTION_TOKEN manquant' });

  const { cardId, action, currentPalier } = req.body ?? {};
  if (!cardId || !action || !['know', 'review'].includes(action)) {
    return res.status(400).json({ error: 'cardId et action (know|review) requis' });
  }

  try {
    let newPalier, nextReview, newMastery;

    if (action === 'know') {
      newPalier   = nextPalier(currentPalier ?? 'J+1');
      newMastery  = newPalier === 'Maîtrisé' ? 'Maîtrisé' : 'En cours';
      nextReview  = newPalier === 'Maîtrisé' ? null : addDays(DAYS[newPalier]);
    } else {
      // "À revoir" — remet à J+1
      newPalier   = 'J+1';
      newMastery  = 'À revoir';
      nextReview  = addDays(1);
    }

    // Construction des propriétés à mettre à jour
    const properties = {
      'Palier':   { select: { name: newPalier } },
      'Maîtrise': { select: { name: newMastery } },
    };

    if (nextReview) {
      properties['Prochaine révision'] = { date: { start: nextReview } };
    } else {
      // Carte maîtrisée → on efface la date de révision
      properties['Prochaine révision'] = { date: null };
    }

    const notionRes = await fetch(`https://api.notion.com/v1/pages/${cardId}`, {
      method: 'PATCH',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({ properties })
    });

    if (!notionRes.ok) {
      const err = await notionRes.text();
      throw new Error(`Notion ${notionRes.status}: ${err}`);
    }

    return res.status(200).json({
      success:    true,
      newPalier,
      newMastery,
      nextReview,
    });

  } catch (error) {
    console.error('[api/learn-review]', error.message);
    return res.status(500).json({ error: error.message });
  }
}
