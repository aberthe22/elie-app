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

  // ── GET ?notify=morning : brief du matin lun-ven (cron 7h30) ──
  // ── GET ?notify=check   : dimanche + 1er du mois (cron 10h) ──
  const notifyType = req.query?.notify;
  if (notifyType === 'morning' || notifyType === 'check') {
    const subStr = await getConfig('push_subscription');
    if (!subStr) return res.status(200).json({ ok: false, msg: 'Pas de subscription' });

    const nowParis  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jsDay     = nowParis.getDay();   // 0=dim, 1=lun…
    const monthDay  = nowParis.getDate();

    const webpush = await import('web-push');
    webpush.default.setVapidDetails(
      process.env.VAPID_SUBJECT ?? 'mailto:aberthe22@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    const sub  = JSON.parse(subStr);
    const sent = [];

    const send = async (key, title, body) => {
      const enabled = await getConfig(`notif_${key}`);
      if (enabled === '0') return;
      await webpush.default.sendNotification(sub, JSON.stringify({
        title: title || '✶ Elie', body, icon: '/icon-192.png', data: { url: '/' },
      }));
      sent.push(key);
    };

    // ── Fetch tâches du jour pour enrichir les notifs ──────────
    const todayStr  = new Date().toISOString().split('T')[0];
    let todayTasks  = [];
    let urgentTasks = [];
    try {
      const tRes = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
        method: 'POST', headers: notionHeaders(),
        body: JSON.stringify({
          filter: {
            and: [
              { property: 'État',           status:   { does_not_equal: 'Terminé' } },
              { property: 'élément parent', relation: { is_empty: true            } },
              { property: 'Date',           date:     { on_or_before: todayStr   } },
            ]
          },
          sorts: [{ property: 'Importance', direction: 'descending' }],
          page_size: 8,
        }),
      });
      if (tRes.ok) {
        const tData = await tRes.json();
        todayTasks  = (tData.results || []).map(p => p.properties['Tâche']?.title?.[0]?.plain_text ?? '').filter(Boolean);
        urgentTasks = (tData.results || [])
          .filter(p => {
            const imp  = p.properties['Importance']?.select?.name;
            const date = p.properties['Date']?.date?.start;
            return imp === 'Haute' || (date && date < todayStr);
          })
          .map(p => p.properties['Tâche']?.title?.[0]?.plain_text ?? '')
          .filter(Boolean)
          .slice(0, 3);
      }
    } catch {}

    if (notifyType === 'morning') {
      // Lun-Ven : brief du matin avec top tâches
      if ([1,2,3,4,5].includes(jsDay)) {
        const top = (urgentTasks.length ? urgentTasks : todayTasks).slice(0, 3);
        const body = top.length
          ? '☀️ Aujourd\'hui : ' + top.map(t => t.length > 28 ? t.slice(0, 26) + '…' : t).join(' · ')
          : '☀️ Bonne journée, Alexis ! Ton brief est prêt.';
        await send('morning', '✶ Elie — Brief du jour', body);
      }
    }

    if (notifyType === 'check') {
      // Dimanche : brief hebdo + rappel budget
      if (jsDay === 0) {
        await send('weekly', '✶ Elie — Récap hebdo', 'C\'est le week-end — ton bilan de semaine t\'attend 🗓');
        await send('budget', '✶ Elie — Budget', 'Rappel : pense à uploader ta capture Revolut 📸');
      }
      // 1er du mois : bilan investissements
      if (monthDay === 1) {
        await send('invest', '✶ Elie — Investissements', 'C\'est le 1er du mois — fais le point sur ton portefeuille 📈');
      }
      // Tâches en attente : lun-ven — liste les titres
      if ([1,2,3,4,5].includes(jsDay) && todayTasks.length > 0) {
        const listed = todayTasks.slice(0, 3).map(t => t.length > 28 ? t.slice(0, 26) + '…' : t).join(' · ');
        const body   = todayTasks.length <= 3
          ? `N'oublie pas : ${listed} 💪`
          : `${todayTasks.length} tâches : ${listed}… 💪`;
        await send('tasks', '✶ Elie — Tâches du jour', body);
      } else if ([1,2,3,4,5].includes(jsDay)) {
        await send('tasks', '✶ Elie — Tâches', 'Pas de tâche urgente aujourd\'hui — bien joué ! 🎯');
      }
    }

    return res.status(200).json({ ok: true, sent });
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

// ── HELPERS ─────�