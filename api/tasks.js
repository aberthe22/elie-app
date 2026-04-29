// ═══════════════════════════════════════════════════════════
//  api/tasks.js  —  Vercel Serverless Function
//  Retourne deux listes :
//  · suggested : top 5 tâches scorées par l'algorithme Elie
//  · today     : toutes les tâches avec Date = aujourd'hui
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;
  const dbId  = process.env.NOTION_TASKS_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Variables d\'environnement manquantes' });
  }

  // ── NOTION CONFIG (push subscriptions) ──────────────────
  const NOTION_API    = 'https://api.notion.com/v1';
  const CONFIG_DB_ID  = process.env.NOTION_CONFIG_DB_ID;
  const notionHeaders = () => ({
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  });

  async function getConfig(key) {
    if (!CONFIG_DB_ID) return null;
    const r = await fetch(`${NOTION_API}/databases/${CONFIG_DB_ID}/query`, {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
    });
    const d = await r.json();
    return d.results?.[0]?.properties['Valeur']?.rich_text?.[0]?.plain_text ?? null;
  }

  async function setConfig(key, value) {
    if (!CONFIG_DB_ID) throw new Error('NOTION_CONFIG_DB_ID manquant');
    const search = await fetch(`${NOTION_API}/databases/${CONFIG_DB_ID}/query`, {
      method: 'POST', headers: notionHeaders(),
      body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
    });
    const found = await search.json();
    const props = {
      'Clé':    { title:     [{ text: { content: key   } }] },
      'Valeur': { rich_text: [{ text: { content: value } }] },
    };
    if (found.results?.length > 0) {
      await fetch(`${NOTION_API}/pages/${found.results[0].id}`, {
        method: 'PATCH', headers: notionHeaders(),
        body: JSON.stringify({ properties: { 'Valeur': props['Valeur'] } }),
      });
    } else {
      await fetch(`${NOTION_API}/pages`, {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({ parent: { database_id: CONFIG_DB_ID }, properties: props }),
      });
    }
  }

  // ── POST : actions multiples ────────────────────────────
  if (req.method === 'POST') {
    const { action, subscription, taskId, title, key, value } = req.body ?? {};

    // Sauvegarder la subscription push
    if (action === 'subscribe' && subscription) {
      await setConfig('push_subscription', JSON.stringify(subscription));
      return res.status(200).json({ ok: true });
    }

    // Sauvegarder une clé de config (préférences notifs)
    if (action === 'setConfig' && key) {
      await setConfig(key, value ?? '');
      return res.status(200).json({ ok: true });
    }

    // Marquer une tâche comme terminée
    if (action === 'complete' && taskId) {
      const notionRes = await fetch(`https://api.notion.com/v1/pages/${taskId}`, {
        method: 'PATCH',
        headers: notionHeaders(),
        body: JSON.stringify({ properties: { 'État': { status: { name: 'Terminé' } } } }),
      });
      if (!notionRes.ok) throw new Error(`Notion ${notionRes.status}: ${await notionRes.text()}`);
      return res.status(200).json({ success: true, taskId });
    }

    // Créer une nouvelle tâche
    if (action === 'create' && title?.trim()) {
      const today = new Date().toISOString().slice(0, 10);
      const notionRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders(),
        body: JSON.stringify({
          parent: { database_id: dbId },
          properties: {
            'Tâche':   { title:  [{ text: { content: title.trim() } }] },
            'État':    { status: { name: 'Pas commencé' } },
            'Domaine': { select: { name: 'Inbox' } },
            'Date':    { date:   { start: today } },
          },
        }),
      });
      if (!notionRes.ok) throw new Error(`Notion ${notionRes.status}: ${await notionRes.text()}`);
      const page = await notionRes.json();
      return res.status(201).json({ success: true, id: page.id, title: title.trim() });
    }

    return res.status(400).json({ error: 'action inconnue' });
  }

  // ── GET ?config=1 : lire toutes les préférences ──────────
  if (req.query?.config === '1') {
    const keys = [
      'notif_morning','notif_morning_hour',
      'notif_tasks','notif_tasks_hour',
      'notif_budget','notif_budget_hour',
      'notif_invest','notif_invest_hour',
      'notif_weekly','notif_weekly_hour',
    ];
    const values = await Promise.all(keys.map(k => getConfig(k)));
    const cfg = {};
    keys.forEach((k, i) => { cfg[k] = values[i] ?? null; });
    return res.status(200).json(cfg);
  }

  // ── GET ?notify=check : cron horaire — vérifie ce qui doit partir ──
  if (req.query?.notify === 'check') {
    const subStr = await getConfig('push_subscription');
    if (!subStr) return res.status(200).json({ ok: false, msg: 'Pas de subscription' });

    // Heure et jour courants en heure de Paris
    const now    = new Date();
    const parts  = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric',
    }).formatToParts(now);
    const hour     = parseInt(parts.find(p => p.type === 'hour').value,   10);
    const minute   = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const dayNum   = now.toLocaleDateString('fr-FR', { timeZone:'Europe/Paris', weekday:'short' });
    const jsDay    = new Date(now.toLocaleString('en-US', { timeZone:'Europe/Paris' })).getDay(); // 0=dim
    const monthDay = new Date(now.toLocaleString('en-US', { timeZone:'Europe/Paris' })).getDate();

    // Définition des notifications
    const NOTIFS = [
      { key:'morning', defaultHour:7,  days:[1,2,3,4,5],   dayOfMonth:null,  body:'Ton brief du jour est prêt. Bonne journée ! ☀️' },
      { key:'tasks',   defaultHour:17, days:[1,2,3,4,5],   dayOfMonth:null,  body:'Des tâches en attente t\'attendent encore. Dernier coup de collier ? 💪' },
      { key:'budget',  defaultHour:10, days:[0],            dayOfMonth:null,  body:'Rappel : pense à uploader ta capture Revolut 📸' },
      { key:'weekly',  defaultHour:10, days:[0],            dayOfMonth:null,  body:'C\'est le week-end — ton brief hebdo t\'attend dans Elie 🗓' },
      { key:'invest',  defaultHour:9,  days:null,           dayOfMonth:1,     body:'C\'est le 1er du mois — fais le point sur tes investissements 📈' },
    ];

    const webpush = await import('web-push');
    webpush.default.setVapidDetails(
      process.env.VAPID_SUBJECT   ?? 'mailto:aberthe22@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    const sub  = JSON.parse(subStr);
    const sent = [];

    for (const n of NOTIFS) {
      // Activé ?
      const enabled = await getConfig(`notif_${n.key}`);
      if (enabled === '0') continue;

      // Heure configurée (ou défaut)
      const prefHour = parseInt(await getConfig(`notif_${n.key}_hour`) ?? n.defaultHour, 10);
      if (hour !== prefHour) continue;

      // Bon jour de semaine ?
      if (n.days !== null && !n.days.includes(jsDay)) continue;

      // Bon jour du mois ?
      if (n.dayOfMonth !== null && monthDay !== n.dayOfMonth) continue;

      // Envoyer
      await webpush.default.sendNotification(sub, JSON.stringify({
        title: '✶ Elie', body: n.body, icon: '/icon.svg', data: { url: '/' },
      }));
      sent.push(n.key);
    }

    return res.status(200).json({ ok: true, sent, hour, jsDay, monthDay });
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
