// ═══════════════════════════════════════════════════════════
//  api/gmail.js  —  Vercel Serverless Function
//
//  Analyse les mails NON LUS par batch de 15.
//  Chaque appel traite un batch et retourne le pageToken suivant
//  si des mails restent à analyser.
//
//  Query params (optionnels) :
//    ?pageToken=xxx   → reprend à la page suivante Gmail
//
//  Réponse :
//  {
//    toDelete: [...], toReply: [...], toTask: [...],
//    batchSize: 15,
//    totalEstimate: 200,
//    nextPageToken: "xxx" | null
//  }
//
//  Variables d'env requises :
//    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//    ANTHROPIC_API_KEY
// ═══════════════════════════════════════════════════════════

const BATCH_SIZE = 15;

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

  const pageToken = req.query?.pageToken ?? null;

  try {
    // ── 1. ACCESS TOKEN ──────────────────────────────────────
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // ── 2. LISTE DES MAILS NON LUS (batch) ──────────────────
    const params = new URLSearchParams({
      maxResults: String(BATCH_SIZE),
      q: 'is:unread in:inbox',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) throw new Error(`Gmail list: ${listRes.status}`);
    const listData = await listRes.json();

    const messageIds    = (listData.messages ?? []).map(m => m.id);
    const nextPageToken = listData.nextPageToken ?? null;
    const totalEstimate = listData.resultSizeEstimate ?? messageIds.length;

    if (messageIds.length === 0) {
      return res.status(200).json({
        toDelete: [], toReply: [], toTask: [],
        batchSize: 0, totalEstimate: 0, nextPageToken: null,
      });
    }

    // ── 3. MÉTADONNÉES (en parallèle) ───────────────────────
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

    const toReply = (analysis.toReply ?? [])
      .map(item => ({ ...emailMap[item.id], draftReply: item.draftReply }))
      .filter(e => e?.id);

    const toTask = (analysis.toTask ?? [])
      .map(item => ({ ...emailMap[item.id], taskTitle: item.taskTitle }))
      .filter(e => e?.id);

    return res.status(200).json({
      toDelete, toReply, toTask,
      batchSize:     emails.length,
      totalEstimate,
      nextPageToken,
    });

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
- toDelete : newsletters, notifications automatiques, promotions, confirmations sans valeur.
- toReply : mails qui attendent une vraie réponse d'Alexis. Le draftReply doit être une réponse complète prête à envoyer.
- toTask : mails qui impliquent une action concrète (document à lire, paiement, rdv à confirmer).
- Chaque mail dans une seule catégorie. Les mails sans action claire vont en toDelete.
- Réponds UNIQUEMENT avec le JSON, rien d'autre.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);

  try {
    const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1200,
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
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[Haiku] Timeout 8.5s');
    } else {
      console.error('[Haiku]', err.message);
    }
    return { toDelete: [], toReply: [], toTask: [] };
  } finally {
    clearTimeout(timer);
  }
}
