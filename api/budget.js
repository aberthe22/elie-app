// ═══════════════════════════════════════════════════════════
//  api/budget.js  —  Budget mensuel persisté dans Notion Config
//
//  GET ?month=YYYY-MM        → données du mois (ou mois courant)
//  GET ?list=1               → liste des mois disponibles
//  POST action=saveMonth     → sauvegarde/fusion données mois
//  POST action=addExpense    → ajoute dépense manuelle
//  POST action=removeExpense → supprime dépense manuelle (par id)
//  POST action=setCatBudget  → définit plafond d'une catégorie
//  POST action=setGlobalBudget → définit budget mensuel global
// ═══════════════════════════════════════════════════════════

const NOTION_API = 'https://api.notion.com/v1';

function notionHeaders(token) {
  return {
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };
}

async function getConfig(token, dbId, key) {
  const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
  });
  const d = await r.json();
  return d.results?.[0]?.properties['Valeur']?.rich_text?.[0]?.plain_text ?? null;
}

async function setConfig(token, dbId, key, value) {
  const search = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({ filter: { property: 'Clé', title: { equals: key } } }),
  });
  const found = await search.json();
  const props = {
    'Clé':    { title:     [{ text: { content: key   } }] },
    'Valeur': { rich_text: [{ text: { content: value } }] },
  };
  if (found.results?.length > 0) {
    await fetch(`${NOTION_API}/pages/${found.results[0].id}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({ properties: { 'Valeur': props['Valeur'] } }),
    });
  } else {
    await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
    });
  }
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token  = process.env.NOTION_TOKEN;
  const dbId   = process.env.NOTION_CONFIG_DB_ID;
  if (!token || !dbId) return res.status(500).json({ error: 'NOTION_TOKEN ou NOTION_CONFIG_DB_ID manquant' });

  // ── GET ?list=1 ─────────────────────────────────────────
  if (req.method === 'GET' && req.query?.list === '1') {
    const raw = await getConfig(token, dbId, 'budget_month_list');
    const list = raw ? JSON.parse(raw) : [];
    return res.status(200).json({ months: list });
  }

  // ── GET ?month=YYYY-MM ──────────────────────────────────
  if (req.method === 'GET') {
    const month = req.query?.month || currentMonth();
    const raw   = await getConfig(token, dbId, `budget_${month}`);
    if (!raw) return res.status(200).json({ month, empty: true });
    return res.status(200).json(JSON.parse(raw));
  }

  // ── POST ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, month: reqMonth, data, category, amount, note, id, budget: catBudget, globalBudget, image, mimeType } = req.body ?? {};

    // ── action=vision : analyse capture Revolut via Claude Haiku ──
    if (action === 'vision') {
      if (!image) return res.status(400).json({ error: 'image (base64) requis' });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquant' });
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
              { type: 'text', text: `Tu analyses une capture d'écran de l'application Revolut (budgets ou dépenses) d'un entrepreneur français.\n\nExtrais toutes les informations visibles. Réponds UNIQUEMENT avec un JSON valide sans texte autour :\n{\n  "month": "mois/période visible ou null",\n  "totalSpent": montant_total_dépensé_nombre_ou_null,\n  "totalBudget": budget_total_nombre_ou_null,\n  "categories": [\n    { "name": "nom", "spent": montant_nombre, "budget": budget_nombre_ou_null, "percentage": pourcentage_utilisé_ou_null }\n  ],\n  "advice": "2-3 lignes de conseils concrets et personnalisés sur la gestion du budget visible, en français"\n}\n\nSi les chiffres ne sont pas lisibles, retourne categories:[] et explique dans advice.` },
            ]}],
          }),
        });
        if (!aiRes.ok) throw new Error(`Claude ${aiRes.status}`);
        const aiData = await aiRes.json();
        const text   = aiData.content?.[0]?.text ?? '';
        const match  = text.match(/\{[\s\S]*\}/);
        if (!match) return res.status(500).json({ error: 'Parsing échoué', raw: text.slice(0, 300) });
        return res.status(200).json(JSON.parse(match[0]));
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    const month = reqMonth || currentMonth();

    // Helpers
    async function loadMonth() {
      const raw = await getConfig(token, dbId, `budget_${month}`);
      return raw ? JSON.parse(raw) : { month, categories: [], totalSpent: 0, balance: null, manualExpenses: [], catBudgets: {}, globalBudget: 0, uploadedAt: null };
    }
    async function saveMonth(obj) {
      await setConfig(token, dbId, `budget_${month}`, JSON.stringify(obj));
      // Mettre à jour la liste des mois
      const listRaw = await getConfig(token, dbId, 'budget_month_list');
      const list = listRaw ? JSON.parse(listRaw) : [];
      if (!list.includes(month)) {
        list.unshift(month);
        list.sort((a, b) => b.localeCompare(a));
        await setConfig(token, dbId, 'budget_month_list', JSON.stringify(list.slice(0, 24)));
      }
    }

    // saveMonth : fusion screenshot avec données existantes
    if (action === 'saveMonth' && data) {
      const existing = await loadMonth();
      // Fusionner les catégories (ajouter ou mettre à jour spent)
      const catMap = {};
      (existing.categories || []).forEach(c => { catMap[c.name] = { ...c }; });
      (data.categories || []).forEach(c => {
        if (catMap[c.name]) {
          // Prendre le montant le plus élevé (le screenshot peut être partiel)
          catMap[c.name].spent = Math.max(catMap[c.name].spent || c.spent || 0, c.spent || 0);
        } else {
          catMap[c.name] = { name: c.name, spent: c.spent || 0 };
        }
      });
      existing.categories   = Object.values(catMap);
      existing.totalSpent   = data.totalSpent   ?? existing.totalSpent;
      existing.balance      = data.balance      ?? existing.balance;
      existing.month        = data.month        ?? existing.month;
      existing.uploadedAt   = new Date().toISOString();
      await saveMonth(existing);
      return res.status(200).json({ ok: true, data: existing });
    }

    // addExpense : ajoute une dépense manuelle
    if (action === 'addExpense' && category && amount) {
      const m = await loadMonth();
      m.manualExpenses = m.manualExpenses || [];
      m.manualExpenses.unshift({
        id:       Date.now().toString(),
        category: category.slice(0, 60),
        amount:   Math.round(Number(amount) * 100) / 100,
        note:     (note || '').slice(0, 100),
        date:     new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      });
      await saveMonth(m);
      return res.status(200).json({ ok: true, data: m });
    }

    // removeExpense : supprime par id
    if (action === 'removeExpense' && id) {
      const m = await loadMonth();
      m.manualExpenses = (m.manualExpenses || []).filter(e => e.id !== String(id));
      await saveMonth(m);
      return res.status(200).json({ ok: true, data: m });
    }

    // setCatBudget : plafond d'une catégorie
    if (action === 'setCatBudget' && category) {
      const m = await loadMonth();
      m.catBudgets = m.catBudgets || {};
      m.catBudgets[category] = Number(catBudget) || 0;
      await saveMonth(m);
      return res.status(200).json({ ok: true });
    }

    // setGlobalBudget : budget mensuel global
    if (action === 'setGlobalBudget') {
      const m = await loadMonth();
      m.globalBudget = Number(globalBudget) || 0;
      await saveMonth(m);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'action inconnue' });
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
