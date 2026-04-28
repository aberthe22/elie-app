// ═══════════════════════════════════════════════════════════
//  api/tasks.js  —  Vercel Serverless Function
//  Retourne deux listes :
//  · suggested : top 5 tâches scorées par l'algorithme Elie
//  · today     : toutes les tâches avec Date = aujourd'hui
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_TASKS_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
  }

  const today = new Date().toISOString().split('T')[0]; // "2026-04-23"

  // ── FILTRE DE BASE ────────────────────────────────────────
  // Conditions communes aux deux requêtes
  const baseFilter = {
    and: [
      { property: 'État',           status:   { does_not_equal: 'Terminé'  } },
      { property: 'élément parent', relation: { is_empty: true             } }
    ]
  };

  try {
    // ── DEUX APPELS EN PARALLÈLE ──────────────────────────
    // Promise.all = on lance les deux requêtes Notion en même
    // temps au lieu d'attendre la première pour faire la seconde.
    // Résultat : 2x plus rapide.
    const [allRes, todayRes] = await Promise.all([

      // 1. Toutes les tâches non-terminées (pour le scoring Elie)
      fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({
          filter: baseFilter,
          sorts: [{ property: 'Importance', direction: 'descending' }],
          page_size: 50
        })
      }),

      // 2. Tâches avec Date ≤ aujourd'hui (en retard + aujourd'hui)
      //    on_or_before = "aujourd'hui ou avant" → aucune tâche du passé ne passe à travers
      fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({
          filter: {
            and: [
              ...baseFilter.and,
              { property: 'Date', date: { on_or_before: today } }
            ]
          },
          sorts: [
            { property: 'Date',       direction: 'ascending'  },
            { property: 'Importance', direction: 'descending' }
          ],
          page_size: 25
        })
      })
    ]);

    if (!allRes.ok)   throw new Error(`Notion all: ${allRes.status}`);
    if (!todayRes.ok) throw new Error(`Notion today: ${todayRes.status}`);

    const [allData, todayData] = await Promise.all([
      allRes.json(),
      todayRes.json()
    ]);

    // ── TRANSFORMATION ────────────────────────────────────
    const allTasks   = allData.results.map(p  => parsePage(p, today));
    const todayTasks = todayData.results.map(p => parsePage(p, today));

    // ── SCORING ELIE ──────────────────────────────────────
    // Chaque tâche reçoit un score. On prend les 5 meilleurs.
    //
    // Logique :
    //   En retard              → +40 pts  (priorité absolue)
    //   Date = aujourd'hui     → +25 pts
    //   Date dans 3 jours      → +15 pts
    //   Date dans 7 jours      → +10 pts
    //   Importance Haute       → +30 pts
    //   Importance Moyenne     → +15 pts
    //   Statut "En cours"      → +20 pts  (déjà commencé)
    //   Statut "Bloqué"        → +10 pts  (à débloquer)
    const scored = allTasks
      .map(t => ({ ...t, score: scoreTask(t, today) }))
      .filter(t => t.score > 0)           // on ignore les tâches sans contexte
      .sort((a, b) => b.score - a.score)  // les mieux scorées en premier
      .slice(0, 10);                       // top 10 : 5 affichés + 5 en réserve

    const blocked = allTasks.filter(tk => tk.status === 'Bloqué');

    return res.status(200).json({
      suggested: scored,
      today:     todayTasks,
      blocked,
      meta: {
        totalActive: allTasks.length,
        todayCount:  todayTasks.length
      }
    });

  } catch (error) {
    console.error('[api/tasks]', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// ── HELPERS ───────────────────────────────────────────────

function headers(token) {
  return {
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };
}

function parsePage(page, today) {
  const p = page.properties;
  const dateRaw    = p['Date']?.date?.start ?? null;
  const importance = p['Importance']?.select?.name ?? null;
  const status     = p['État']?.status?.name ?? 'Pas commencé';

  // Tag affiché dans la carte
  let tag = null, tagClass = null;
  if (dateRaw && dateRaw < today) {
    tag = 'En retard'; tagClass = 'urgent';
  } else if (importance === 'Haute') {
    tag = 'Urgent'; tagClass = 'urgent';
  } else if (dateRaw === today) {
    tag = 'Aujourd\'hui'; tagClass = 'today';
  } else if (dateRaw) {
    const label = new Date(dateRaw + 'T12:00:00')
      .toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' });
    tag = label.charAt(0).toUpperCase() + label.slice(1);
    tagClass = 'soon';
  } else if (importance === 'Moyenne') {
    tag = 'Moyenne'; tagClass = 'soon';
  }

  return {
    id:         page.id,
    title:      p['Tâche']?.title?.[0]?.plain_text ?? 'Sans titre',
    status,
    done:       status === 'Terminé',
    importance,
    domain:     p['Domaine']?.select?.name ?? null,
    date:       dateRaw,
    tag,
    tagClass,
    url:        page.url,
    lastEdited: page.last_edited_time ?? null,
  };
}

function scoreTask(task, today) {
  let score = 0;

  // Score par date
  if (task.date) {
    if (task.date < today)  score += 40;  // en retard
    else if (task.date === today) score += 25;  // aujourd'hui
    else {
      const days = Math.ceil(
        (new Date(task.date) - new Date(today)) / 86400000
      );
      if (days <= 3) score += 15;
      else if (days <= 7) score += 10;
    }
  }

  // Score par importance
  if (task.importance === 'Haute')   score += 30;
  if (task.importance === 'Moyenne') score += 15;

  // Score par statut
  if (task.status === 'En cours') score += 20;
  if (task.status === 'Bloqué')   score += 10;

  return score;
}
