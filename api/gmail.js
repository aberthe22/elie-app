// ═══════════════════════════════════════════════════════════
//  api/gmail.js  —  Vercel Serverless Function
//
//  1. Récupère les mails NON LUS d'Alexis (max 20)
//  2. Envoie les métadonnées à Claude Haiku
//  3. Haiku catégorise chaque mail en :
//       - toDelete  : à supprimer (newsletters, notifs, etc.)
//       - toReply   : nécessite une réponse → brouillon généré
//       - toTask    : implique une action → titre de tâche généré
//  4. Retourne les trois listes enrichies avec les infos mail
//
//  Variables d'env requises :
//    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//    ANTHROPIC_API_KEY
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, ANTHROPIC_API_KEY } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Variables Google manquantes' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });
  }

  try {
    // ── 1. ACCESS TOKEN ──────────────────────────────────────
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // ── 2. MAILS NON LUS UNIQUEMENT ─────────────────────────
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=is:unread+-in:trash+-in:spam',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) throw new Error(`Gmail list: ${listRes.status}`);
    const listData   = await listRes.json();
    const messageIds = (listData.messages ?? []).map(m => m.id);

    if (messageIds.length === 0) {
      return res.status(200).json({ toDelete: [], toReply: [], toTask: [], unreadCount: 0 });
    }

    // ── 3. MÉTADONNÉES (en parallèle) ───────────────────────
    // Message-ID récupéré pour le threading des réponses (In-Reply-To)
    const details = await Promise.all(
      messageIds.map(id =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        ).then(r => r.json())
      )
    );

    // ── 4. TRANSFORMATION ────────────────────────────────────
    const emails = details.map(msg => {
      const headers  = msg.payload?.headers ?? [];
      const get      = name => headers.find(h => h.name === name)?.value ?? '';
      const from     = parseFrom(get('From'));
      return {
        id:        msg.id,
        threadId:  msg.threadId,
        messageId: get('Message-ID'),
        from:      from.name,
        email:     from.email,
        subject:   get('Subject') || '(sans objet)',
        date:      formatDate(get('Date')),
        snippet:   (msg.snippet ?? '').slice(0, 200),
      };
    });

    // ── 5. ANALYSE HAIKU ─────────────────────────────────────
    const analysis = await analyzeWithHaiku(emails, ANTHROPIC_API_KEY);

    // ── 6. ENRICHISSEMENT ────────────────────────────────────
    const emailMap = Object.fromEntries(emails.map(e => [e.id, e]));

    const toDelete = (analysis.toDelete ?? [])
      .map(item => ({ ...emailMap[item.id], reason: item.reason }))
      .filter(e => e?.id);

    const toReply  = (analysis.toReply ?? [])
      .map(item => ({ ...emailMap[item.id], draftReply: item.draftReply }))
      .filter(e => e?.id);

    const toTask   = (analysis.toTask ?? [])
      .map(item => ({ ...emailMap[item.id], taskTitle: item.taskTitle }))
      .filter(e => e?.id);

    return res.status(200).json({ toDelete, toReply, toTask, unreadCount: emails.length });

  } catch (error) {
    console.error('[api/gmail]', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// ── HELPERS ───────────────────────────────────────────────

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<(.+?)>$/);
  if (match) {
    return {
      name:  match[1].replace(/['"]/g, '').trim() || match[2],
      email: match[2].trim(),
    };
  }
  return { name: fromHeader, email: fromHeader };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d     = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const now   = new Date();
  const diffH = (now - d) / 3600000;
  if (diffH < 24)  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (diffH < 48)  return 'Hier';
  if (diffH < 168) return d.toLocaleDateString('fr-FR', { weekday: 'long' });
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

async function analyzeWithHaiku(emails, apiKey) {
  const emailsText = emails.map((e, i) =>
    `${i + 1}. [ID:${e.id}]\n   De: ${e.from} <${e.email}>\n   Sujet: ${e.subject}\n   Date: ${e.date}\n   Aperçu: ${e.snippet}`
  ).join('\n\n');

  const prompt = `Tu es l'assistante IA d'Alexis Berthe. Analyse ces ${emails.length} emails non lus et classe chacun dans exactement une catégorie. Réponds UNIQUEMENT en JSON valide, sans markdown.

EMAILS :
${emailsText}

Retourne ce JSON exact :
{
  "toDelete": [
    { "id": "messageId", "reason": "raison courte en français" }
  ],
  "toReply": [
    { "id": "messageId", "draftReply": "Brouillon complet de la réponse, naturel et professionnel. Corps du mail uniquement, signé Alexis." }
  ],
  "toTask": [
    { "id": "messageId", "taskTitle": "Titre de tâche actionnable et concis" }
  ]
}

Règles :
- toDelete : newsletters, notifications automatiques, promotions, confirmations sans valeur. Maximum 10.
- toReply : mails qui attendent une vraie réponse d'Alexis. Le draftReply doit être une réponse complète prête à envoyer. Maximum 5.
- toTask : mails qui impliquent une action concrète mais pas de réponse (document à lire, paiement, rdv). Maximum 4.
- Chaque mail dans une seule catégorie maximum. Les mails sans action claire sont ignorés.
- Réponds UNIQUEMENT avec le JSON, rien d'autre.`;

  const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!haikuRes.ok) {
    console.error('[Haiku error]', await haikuRes.text());
    return { toDelete: [], toReply: [], toTask: [] };
  }

  const haikuData = await haikuRes.json();
  const raw       = haikuData.content?.[0]?.text ?? '{}';

  try {
    return JSON.parse(raw);
  } catch {
    console.warn('[Haiku] JSON invalide:', raw.slice(0, 200));
    return { toDelete: [], toReply: [], toTask: [] };
  }
}
