// ═══════════════════════════════════════════════════════════
//  api/create-task.js  —  Vercel Serverless Function
//  Reçoit un titre (POST) et crée une nouvelle page dans la
//  base de tâches Notion avec le statut "Pas commencé" (Inbox).
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_TASKS_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
  }

  const { title } = req.body ?? {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Le titre est requis' });
  }

  const today = new Date().toISOString().slice(0, 10);

  try {
    // ── CRÉATION DE LA PAGE NOTION ────────────────────────
    // On crée une page dans la base de tâches avec :
    //   - "Tâche"  : le titre saisi par l'utilisateur
    //   - "État"   : "Pas commencé" → atterrit dans l'Inbox Notion
    //   - "Date"   : date du jour
    //   - "Domaine": "Inbox"
    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          'Tâche': {
            title: [{ text: { content: title.trim() } }]
          },
          'État': {
            status: { name: 'Pas commencé' }
          },
          'Domaine': {
            select: { name: 'Inbox' }
          },
          'Date': {
            date: { start: today }
          }
        }
      })
    });

    if (!notionRes.ok) {
      const err = await notionRes.text();
      throw new Error(`Notion ${notionRes.status}: ${err}`);
    }

    const page = await notionRes.json();
    return res.status(201).json({
      success: true,
      id:    page.id,
      title: title.trim(),
      url:   page.url
    });

  } catch (error) {
    console.error('[api/create-task]', error.message);
    return res.status(500).json({ error: error.message });
  }
}
