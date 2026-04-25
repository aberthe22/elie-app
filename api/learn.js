// ═══════════════════════════════════════════════════════════
//  api/learn.js  —  Vercel Serverless Function
//
//  Retourne les cartes d'apprentissage dues aujourd'hui :
//    - Prochaine révision <= aujourd'hui  OU  vide
//    - Maîtrise ≠ "Maîtrisé"
//
//  Variables d'env requises :
//    NOTION_TOKEN, NOTION_LEARN_DB_ID
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_LEARN_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Variables NOTION manquantes' });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    const notionRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        filter: {
          and: [
            // Pas encore maîtrisé
            {
              property: 'Maîtrise',
              select: { does_not_equal: 'Maîtrisé' }
            },
            // Due aujourd'hui ou sans date planifiée
            {
              or: [
                {
                  property: 'Prochaine révision',
                  date: { on_or_before: today }
                },
                {
                  property: 'Prochaine révision',
                  date: { is_empty: true }
                }
              ]
            }
          ]
        },
        sorts: [
          { property: 'Prochaine révision', direction: 'ascending' }
        ],
        page_size: 20,
      })
    });

    if (!notionRes.ok) {
      const err = await notionRes.text();
      throw new Error(`Notion ${notionRes.status}: ${err}`);
    }

    const data  = await notionRes.json();
    const cards = data.results.map(page => {
      const props = page.properties;
      return {
        id:       page.id,
        term:     props['Terme']?.title?.[0]?.plain_text ?? '',
        category: props['Catégorie']?.select?.name ?? '',
        def:      props['Définition']?.rich_text?.[0]?.plain_text ?? '',
        image:    props['Image mentale']?.rich_text?.[0]?.plain_text ?? '',
        example:  props['Exemple concret']?.rich_text?.[0]?.plain_text ?? '',
        palier:   props['Palier']?.select?.name ?? 'J+1',
        mastery:  props['Maîtrise']?.select?.name ?? 'À revoir',
      };
    });

    return res.status(200).json({ cards, total: cards.length });

  } catch (error) {
    console.error('[api/learn]', error.message);
    return res.status(500).json({ error: error.message });
  }
}
