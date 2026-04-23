// ═══════════════════════════════════════════════════════════
//  api/tasks.js  —  Vercel Serverless Function
//  Ce fichier tourne sur les SERVEURS de Vercel, pas sur ton
//  iPhone. Il peut lire tes clés secrètes sans jamais les
//  exposer dans le navigateur.
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {

  // ── CORS ────────────────────────────────────────────────
  // "CORS" = qui a le droit d'appeler cette fonction.
  // On autorise seulement les requêtes GET depuis n'importe
  // quelle origine (ton app Elie sur Vercel ou en local).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── VARIABLES D'ENVIRONNEMENT ────────────────────────────
  // Ces valeurs existent dans le "coffre-fort" Vercel.
  // Jamais dans GitHub, jamais visibles côté client.
  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_TASKS_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({
      error: 'Variables d\'environnement manquantes (NOTION_TOKEN, NOTION_TASKS_DB_ID)'
    });
  }

  try {
    // ── APPEL API NOTION ──────────────────────────────────
    // On interroge la base de données avec un filtre :
    // "donne-moi toutes les tâches dont l'état ≠ Terminé"
    const notionRes = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization':   `Bearer ${token}`,
          'Notion-Version':  '2022-06-28',   // version stable de l'API
          'Content-Type':    'application/json',
        },
        body: JSON.stringify({
          filter: {
            and: [
              {
                // Seulement les tâches pas encore terminées
                property: 'État',
                status: { does_not_equal: 'Terminé' }
              },
              {
                // Seulement les tâches de niveau racine (pas les sous-tâches)
                property: 'élément parent',
                relation: { is_empty: true }
              }
            ]
          },
          sorts: [
            // 1. Les tâches "Haute" importance en premier
            { property: 'Importance', direction: 'descending' },
            // 2. Puis par date croissante (les plus urgentes en tête)
            { property: 'Date', direction: 'ascending'  }
          ],
          page_size: 10
        })
      }
    );

    if (!notionRes.ok) {
      const err = await notionRes.text();
      throw new Error(`Notion ${notionRes.status}: ${err}`);
    }

    const data = await notionRes.json();

    // ── TRANSFORMATION ────────────────────────────────────
    // L'API Notion renvoie un objet très verbeux.
    // On ne garde que ce dont Elie a besoin — propre et léger.
    const today = new Date().toISOString().split('T')[0]; // "2026-04-23"

    const tasks = data.results.map(page => {
      const p = page.properties;
      const dateRaw  = p['Date']?.date?.start ?? null;
      const statut   = p['État']?.status?.name ?? 'Pas commencé';
      const importance = p['Importance']?.select?.name ?? null;

      // Calcul du tag affiché dans Elie
      let tag = null;
      let tagClass = null;

      if (dateRaw && dateRaw < today) {
        tag = 'En retard'; tagClass = 'urgent';
      } else if (importance === 'Haute') {
        tag = 'Urgent'; tagClass = 'urgent';
      } else if (dateRaw === today) {
        tag = 'Aujourd\'hui'; tagClass = 'today';
      } else if (importance === 'Moyenne' || dateRaw) {
        tag = dateRaw
          ? new Date(dateRaw).toLocaleDateString('fr-FR', { weekday: 'long' })
          : 'Bientôt';
        tagClass = 'soon';
      }

      return {
        id:         page.id,
        title:      p['Tâche']?.title?.[0]?.plain_text ?? 'Sans titre',
        status:     statut,
        done:       statut === 'Terminé',
        importance,
        domain:     p['Domaine']?.select?.name ?? null,
        date:       dateRaw,
        tag,
        tagClass,
        url:        page.url
      };
    });

    // On trie : tâches non-faites d'abord
    tasks.sort((a, b) => Number(a.done) - Number(b.done));

    // ── RÉPONSE ───────────────────────────────────────────
    return res.status(200).json({
      tasks,
      total: tasks.length,
      done:  tasks.filter(t => t.done).length
    });

  } catch (error) {
    console.error('[api/tasks] Erreur:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
