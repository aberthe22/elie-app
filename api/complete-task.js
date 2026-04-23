// ═══════════════════════════════════════════════════════════
//  api/complete-task.js  —  Vercel Serverless Function
//  Reçoit un taskId en POST et met son État à "Terminé"
//  dans Notion via l'API officielle.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cette route n'accepte que les POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'NOTION_TOKEN manquant' });
  }

  // On récupère le taskId depuis le body de la requête
  const { taskId } = req.body ?? {};
  if (!taskId) {
    return res.status(400).json({ error: 'taskId requis' });
  }

  try {
    // ── APPEL NOTION : PATCH /pages/{taskId} ─────────────
    // On met à jour UNIQUEMENT la propriété "État" → "Terminé"
    // Notion ne touche à rien d'autre dans la page.
    const notionRes = await fetch(
      `https://api.notion.com/v1/pages/${taskId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization':  `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type':   'application/json',
        },
        body: JSON.stringify({
          properties: {
            'État': {
              status: { name: 'Terminé' }
            }
          }
        })
      }
    );

    if (!notionRes.ok) {
      const err = await notionRes.text();
      throw new Error(`Notion ${notionRes.status}: ${err}`);
    }

    return res.status(200).json({ success: true, taskId });

  } catch (error) {
    console.error('[api/complete-task]', error.message);
    return res.status(500).json({ error: error.message });
  }
}
