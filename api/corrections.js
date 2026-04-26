// ═══════════════════════════════════════════════════════════
//  api/corrections.js  —  Vercel Serverless Function
//
//  GET  → retourne les 25 dernières corrections depuis Notion
//  POST → ajoute une nouvelle correction dans Notion
//
//  Variables d'env requises :
//    NOTION_TOKEN, NOTION_CORRECTIONS_DB_ID
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token  = process.env.NOTION_TOKEN;
  const rawId  = process.env.NOTION_CORRECTIONS_DB_ID;

  if (!token || !rawId) {
    return res.status(500).json({ error: 'NOTION_TOKEN ou NOTION_CORRECTIONS_DB_ID manquant' });
  }

  // Normalise l'ID en UUID valide (avec ou sans tirets, quelle que soit la colle)
  const stripped = rawId.replace(/-/g, '');
  const dbId = stripped.length === 32
    ? `${stripped.slice(0,8)}-${stripped.slice(8,12)}-${stripped.slice(12,16)}-${stripped.slice(16,20)}-${stripped.slice(20)}`
    : rawId;

  const headers = {
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  // ── GET : récupérer les corrections ──────────────────────
  if (req.method === 'GET') {
    try {
      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sorts: [{ property: 'Date', direction: 'descending' }],
          page_size: 25,
        }),
      });
      if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);

      const data = await r.json();
      const corrections = data.results.map(page => {
        const p = page.properties;
        return {
          from:    p['From']?.title?.[0]?.plain_text    ?? '',
          subject: p['Subject']?.rich_text?.[0]?.plain_text ?? '',
          snippet: p['Snippet']?.rich_text?.[0]?.plain_text ?? '',
          fromCat: p['FromCat']?.select?.name ?? '',
          toCat:   p['ToCat']?.select?.name   ?? '',
        };
      }).filter(c => c.fromCat && c.toCat); // ignorer les entrées incomplètes

      return res.status(200).json({ corrections });
    } catch (err) {
      console.error('[api/corrections GET]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST : enregistrer une nouvelle correction ────────────
  if (req.method === 'POST') {
    const { from, subject, snippet, fromCat, toCat } = req.body ?? {};
    if (!fromCat || !toCat) {
      return res.status(400).json({ error: 'fromCat et toCat sont requis' });
    }

    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          parent: { database_id: dbId },
          properties: {
            'From':    { title:     [{ text: { content: (from    || '').slice(0, 100) } }] },
            'Subject': { rich_text: [{ text: { content: (subject || '').slice(0, 200) } }] },
            'Snippet': { rich_text: [{ text: { content: (snippet || '').slice(0, 200) } }] },
            'FromCat': { select: { name: fromCat } },
            'ToCat':   { select: { name: toCat   } },
            'Date':    { date:   { start: today   } },
          },
        }),
      });
      if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);

      return res.status(201).json({ success: true });
    } catch (err) {
      console.error('[api/corrections POST]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
