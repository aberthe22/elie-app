// ═══════════════════════════════════════════════════════════
//  api/chat.js  —  Vercel Serverless Function
//  Elie AI Chat — Claude Sonnet avec tool use
//  Outils : Notion Tasks · Gmail · Google Calendar
//
//  POST { message, history, context }
//       → { reply, history, actions_taken }
// ═══════════════════════════════════════════════════════════

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const NOTION_API    = 'https://api.notion.com/v1';
const GMAIL_BASE    = 'https://www.googleapis.com/gmail/v1/users/me';
const GCAL_BASE     = 'https://www.googleapis.com/calendar/v3';

// ── OAuth Google (Gmail + Calendar partagent le même token) ──────────
async function getGoogleToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN)
    throw new Error('Google OAuth non configuré');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google token KO: ${JSON.stringify(data)}`);
  return data.access_token;
}

function notionHeaders() {
  return {
    'Authorization':  `Bearer ${process.env.NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };
}

// ── OUTILS ──────────────────────────────────────────────────────────

async function toolGetTasks() {
  const { NOTION_TOKEN, NOTION_TASKS_DB_ID } = process.env;
  if (!NOTION_TOKEN || !NOTION_TASKS_DB_ID) return { error: 'Notion non configuré' };
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch(`${NOTION_API}/databases/${NOTION_TASKS_DB_ID}/query`, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'État',           status:   { does_not_equal: 'Terminé'  } },
          { property: 'élément parent', relation: { is_empty: true             } },
        ]
      },
      sorts: [{ property: 'Importance', direction: 'descending' }],
      page_size: 40,
    }),
  });
  if (!res.ok) throw new Error(`Notion tasks ${res.status}`);
  const data = await res.json();
  return data.results.map(p => ({
    id:         p.id,
    title:      p.properties['Tâche']?.title?.[0]?.plain_text ?? '(sans titre)',
    status:     p.properties['État']?.status?.name ?? 'Pas commencé',
    importance: p.properties['Importance']?.select?.name ?? null,
    domain:     p.properties['Domaine']?.select?.name ?? null,
    date:       p.properties['Date']?.date?.start ?? null,
    overdue:    p.properties['Date']?.date?.start
                  ? p.properties['Date'].date.start < today : false,
  }));
}

async function toolCreateTask({ title, importance, date, domain }) {
  const { NOTION_TOKEN, NOTION_TASKS_DB_ID } = process.env;
  if (!NOTION_TOKEN || !NOTION_TASKS_DB_ID) return { error: 'Notion non configuré' };
  const properties = {
    'Tâche': { title: [{ text: { content: title } }] },
    'État':  { status: { name: 'Pas commencé' } },
  };
  if (importance) properties['Importance'] = { select: { name: importance } };
  if (date)       properties['Date']       = { date:   { start: date     } };
  if (domain)     properties['Domaine']    = { select: { name: domain    } };
  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(),
    body: JSON.stringify({ parent: { database_id: NOTION_TASKS_DB_ID }, properties }),
  });
  if (!res.ok) throw new Error(`Notion create ${res.status}`);
  const page = await res.json();
  return { success: true, id: page.id, title };
}

async function toolUpdateTask({ task_id, status, importance }) {
  if (!process.env.NOTION_TOKEN) return { error: 'Notion non configuré' };
  const properties = {};
  if (status)     properties['État']       = { status: { name: status     } };
  if (importance) properties['Importance'] = { select: { name: importance } };
  const res = await fetch(`${NOTION_API}/pages/${task_id}`, {
    method: 'PATCH',
    headers: notionHeaders(),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion update ${res.status}`);
  return { success: true };
}

async function toolGetEmails({ max = 10 } = {}) {
  const gToken = await getGoogleToken();
  const listRes = await fetch(
    `${GMAIL_BASE}/messages?labelIds=INBOX&q=is:unread&maxResults=${Math.min(max, 20)}`,
    { headers: { Authorization: `Bearer ${gToken}` } }
  );
  const listData = await listRes.json();
  const messages = listData.messages ?? [];
  if (messages.length === 0) return [];
  const details = await Promise.all(
    messages.slice(0, 15).map(m =>
      fetch(`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From,Subject,Date`, {
        headers: { Authorization: `Bearer ${gToken}` },
      }).then(r => r.json())
    )
  );
  return details.map(msg => {
    const h = msg.payload?.headers ?? [];
    const g = name => h.find(x => x.name === name)?.value ?? '';
    return {
      id:      msg.id,
      from:    g('From'),
      subject: g('Subject'),
      date:    g('Date'),
      snippet: (msg.snippet ?? '').slice(0, 200),
    };
  });
}

async function toolArchiveEmails({ ids }) {
  const gToken = await getGoogleToken();
  const results = await Promise.allSettled(
    ids.map(id =>
      fetch(`${GMAIL_BASE}/messages/${id}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['INBOX', 'UNREAD'] }),
      })
    )
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  return { archived: ok, failed: results.length - ok };
}

async function toolGetCalendar({ days = 7 } = {}) {
  const gToken = await getGoogleToken();
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  const params = new URLSearchParams({
    timeMin:      now.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '20',
  });
  const res = await fetch(`${GCAL_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${gToken}` },
  });
  if (!res.ok) throw new Error(`Calendar ${res.status}`);
  const data = await res.json();
  return (data.items ?? []).map(e => ({
    id:     e.id,
    title:  e.summary ?? '(sans titre)',
    start:  e.start?.dateTime ?? e.start?.date ?? '',
    end:    e.end?.dateTime   ?? e.end?.date   ?? '',
    allDay: !!e.start?.date,
  }));
}

async function toolCreateEvent({ title, date, start_time, end_time, description }) {
  const gToken = await getGoogleToken();
  const event = {
    summary: title,
    start: start_time
      ? { dateTime: `${date}T${start_time}:00`, timeZone: 'Europe/Paris' }
      : { date },
    end: end_time
      ? { dateTime: `${date}T${end_time}:00`, timeZone: 'Europe/Paris' }
      : { date },
  };
  if (description) event.description = description;
  const res = await fetch(`${GCAL_BASE}/calendars/primary/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`Calendar create ${res.status}`);
  const created = await res.json();
  return { success: true, id: created.id, title };
}

// ── Définitions des outils pour Claude ──────────────────────────────

const TOOLS = [
  {
    name: 'get_tasks',
    description: 'Récupère toutes les tâches actives depuis Notion (non terminées). Utilise pour briefings, priorisation, ou quand on cherche des tâches spécifiques (ex: URSSAF, projet X...).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_task',
    description: 'Crée une nouvelle tâche dans Notion.',
    input_schema: {
      type: 'object',
      properties: {
        title:      { type: 'string', description: 'Titre de la tâche' },
        importance: { type: 'string', enum: ['Haute', 'Moyenne', 'Basse'] },
        date:       { type: 'string', description: 'Échéance (YYYY-MM-DD)' },
        domain:     { type: 'string', description: 'Domaine (Inbox, Pro, Perso…)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Modifie le statut ou l\'importance d\'une tâche. Appelle get_tasks d\'abord pour avoir les IDs. Pour "je suis en attente de X" → statut "Bloqué" + importance "Basse".',
    input_schema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'ID Notion de la tâche' },
        status:     { type: 'string', enum: ['Pas commencé', 'En cours', 'Bloqué', 'Terminé'] },
        importance: { type: 'string', enum: ['Haute', 'Moyenne', 'Basse'] },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_emails',
    description: 'Récupère les emails non lus dans Gmail.',
    input_schema: {
      type: 'object',
      properties: {
        max: { type: 'number', description: 'Nombre max (défaut 10, max 20)' },
      },
      required: [],
    },
  },
  {
    name: 'archive_emails',
    description: 'Archive des emails Gmail (retire de l\'inbox + marque lu).',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs Gmail à archiver' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_calendar',
    description: 'Récupère les événements du calendrier Google.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Jours à récupérer (défaut 7)' },
      },
      required: [],
    },
  },
  {
    name: 'create_event',
    description: 'Crée un événement dans Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'Titre de l\'événement' },
        date:        { type: 'string', description: 'Date (YYYY-MM-DD)' },
        start_time:  { type: 'string', description: 'Heure début (HH:MM)' },
        end_time:    { type: 'string', description: 'Heure fin (HH:MM)' },
        description: { type: 'string', description: 'Notes/description' },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'get_budget',
    description: 'Récupère les données budget actuelles (catégories, montants, dépenses)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_expense',
    description: 'Ajoute une dépense manuelle à une catégorie budget',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        amount:   { type: 'number' },
        note:     { type: 'string' },
      },
      required: ['category', 'amount'],
    },
  },
];

// ── Handler principal ────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST uniquement' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquant' });

  const { message, history = [], context = '', image } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ error: 'message requis' });

  try {

  const now      = new Date();
  const datetime = now.toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const systemPrompt = `Tu es Elie, l'assistante IA personnelle d'Alexis Berthe, entrepreneur français.
Tu es intégrée dans son app de productivité avec accès direct à ses outils.

Capacités via tools :
- Tâches Notion : lecture, création, modification de statut/priorité
- Gmail : lecture des non-lus, archivage
- Google Calendar : lecture des événements, création

Comportement :
- Réponds TOUJOURS en français, concis (2-4 lignes max sauf briefing demandé)
- Actions directes : si tu peux agir, agis et confirme brièvement ("✓ Tâche créée", "✓ 3 mails archivés")
- Briefing (quand le message est "Brief-moi") = lance get_tasks + get_emails + get_calendar en parallèle, puis réponds avec format structuré : "📋 **Priorités**" (3 tâches urgentes/en retard max), "📅 **Agenda**" (events du jour), "📬 **Mails**" (non-lus notables), "🎯 **Focus**" (reco d'action principale). Puces (•) et **gras**. Max 18 lignes.
- "J'attends un retour de X" → cherche les tâches liées, passe-les en statut "Bloqué" + importance "Basse", confirme
- Pour modifier des tâches : appelle d'abord get_tasks pour avoir les IDs, cherche par mots-clés dans le titre
- Enchaîne les actions sans demander confirmation sauf si ambigu

Contexte mémorisé des sessions précédentes :
${context || '(aucun contexte encore)'}

Date et heure : ${datetime}`;

  // Construire les messages pour Claude
  const userContent = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } },
        { type: 'text', text: message },
      ]
    : message;

  const messages = [
    ...history.slice(-20).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];

  const actionsTaken = [];
  let currentMessages = [...messages];
  const MAX_ITER = 6;

  // ── Boucle agentique ────────────────────────────────────────────
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const aiRes = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     systemPrompt,
        tools:      TOOLS,
        messages:   currentMessages,
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      throw new Error(`Claude ${aiRes.status}: ${err.slice(0, 200)}`);
    }

    const aiData = await aiRes.json();

    // Réponse textuelle finale
    if (aiData.stop_reason === 'end_turn') {
      const reply = aiData.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const updatedHistory = [
        ...history.slice(-28),
        { role: 'user',      content: message },
        { role: 'assistant', content: reply   },
      ];

      return res.status(200).json({ reply, history: updatedHistory, actions_taken: actionsTaken });
    }

    // Appels d'outils
    if (aiData.stop_reason === 'tool_use') {
      const toolBlocks = aiData.content.filter(b => b.type === 'tool_use');
      currentMessages.push({ role: 'assistant', content: aiData.content });

      const toolResults = await Promise.all(
        toolBlocks.map(async tb => {
          let result;
          try {
            switch (tb.name) {
              case 'get_tasks':      result = await toolGetTasks();                   break;
              case 'create_task':    result = await toolCreateTask(tb.input);         break;
              case 'update_task':    result = await toolUpdateTask(tb.input);         break;
              case 'get_emails':     result = await toolGetEmails(tb.input);          break;
              case 'archive_emails': result = await toolArchiveEmails(tb.input);      break;
              case 'get_calendar':   result = await toolGetCalendar(tb.input);        break;
              case 'create_event':   result = await toolCreateEvent(tb.input);        break;
              case 'get_budget':     result = { info: 'Budget non chargé côté serveur — consulte l\'onglet Budget dans l\'app' }; break;
              case 'add_expense':    result = { info: 'Dépense enregistrée côté client — utilise le bouton + Dépense manuelle dans l\'app' }; break;
              default:               result = { error: `Outil inconnu: ${tb.name}` };
            }
            actionsTaken.push(tb.name);
          } catch (e) {
            result = { error: e.message };
            console.error(`[chat/${tb.name}]`, e.message);
          }
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) };
        })
      );

      currentMessages.push({ role: 'user', content: toolResults });
    }
  }

  // Sécurité : max itérations atteint
  return res.status(200).json({
    reply: 'J\'ai traité ta demande mais ai atteint la limite de traitement. Reformule si besoin.',
    history: [...history.slice(-28), { role: 'user', content: message }],
    actions_taken: actionsTaken,
  });

  } catch (err) {
    console.error('[chat] erreur:', err.message);
    return res.status(500).json({ error: err.message ?? 'Erreur interne' });
  }
}
