// ═══════════════════════════════════════════════════════════
//  api/gmail.js  —  Vercel Serverless Function
//
//  1. Échange le refresh token Google contre un access token
//  2. Récupère les 15 derniers mails (non-lus + récents)
//  3. Envoie les métadonnées à Claude Haiku pour analyse
//  4. Retourne : { emails, analysis: { synthesis, toDelete, taskSuggestions } }
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
    // ── 1. ACCESS TOKEN ──────────────────────────────────
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // ── 2. LISTE DES MESSAGES ────────────────────────────
    // On prend les 15 plus récents non-supprimés (lu + non-lu)
    const listRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=-in:trash+-in:spam',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!listRes.ok) throw new Error(`Gmail list: ${listRes.status}`);
    const listData = await listRes.json();
    const messageIds = (listData.messages ?? []).map(m => m.id);

    if (messageIds.length === 0) {
      return res.status(200).json({
        emails: [],
        analysis: { synthesis: 'Boîte mail vide.', toDelete: [], taskSuggestions: [] }
      });
    }

    // ── 3. DÉTAILS DES MESSAGES (en parallèle, metadata only) ──
    // "metadata" = on ne télécharge PAS le corps complet → rapide + économique
    const emailDetails = await Promise.all(
      messageIds.map(id =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        ).then(r => r.json())
      )
    );

    // ── 4. TRANSFORMATION ────────────────────────────────
    const emails = emailDetails.map(msg => {
      const headers = msg.payload?.headers ?? [];
      const get = name => headers.find(h => h.name === name)?.value ?? '';
      const from = parseFrom(get('From'));
      const isUnread = (msg.labelIds ?? []).includes('UNREAD');

      return {
        id:       msg.id,
        from:     from.name,
        email:    from.email,
        subject:  get('Subject') || '(sans objet)',
        date:     formatDate(get('Date')),
        snippet:  msg.snippet ?? '',
        unread:   isUnread,
        labels:   msg.labelIds ?? [],
      };
    });

    // ── 5. ANALYSE CLAUDE HAIKU ──────────────────────────
    // On envoie UNIQUEMENT les métadonnées (from, subject, snippet)
    // → environ 500-800 tokens par analyse → coût ~0.001€
    const analysis = await analyzeWithHaiku(emails, ANTHROPIC_API_KEY);

    return res.status(200).json({ emails, analysis });

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
  // "Prénom Nom <email@domain.com>" → { name, email }
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
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const now = new Date();
  const diffH = (now - d) / 3600000;
  if (diffH < 24) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (diffH < 48) return 'Hier';
  if (diffH < 168) return d.toLocaleDateString('fr-FR', { weekday: 'long' });
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

async function analyzeWithHaiku(emails, apiKey) {
  // Construit un résumé compact des mails pour Haiku
  const emailsText = emails.map((e, i) =>
    `${i + 1}. [${e.id}] De: ${e.from} (${e.email}) | Sujet: ${e.subject} | ${e.date}${e.unread ? ' [NON LU]' : ''}\n   Aperçu: ${e.snippet.slice(0, 120)}`
  ).join('\n');

  const prompt = `Tu es l'assistante IA d'Alexis. Analyse ces ${emails.length} emails et réponds UNIQUEMENT en JSON valide, sans markdown.

EMAILS :
${emailsText}

Retourne ce JSON exact :
{
  "synthesis": "2-3 phrases résumant l'essentiel de la boîte mail aujourd'hui",
  "toDelete": [
    { "id": "messageId", "reason": "raison courte en français" }
  ],
  "taskSuggestions": [
    { "title": "Titre de la tâche suggérée", "reason": "Basé sur quel mail" }
  ]
}

Règles :
- toDelete : newsletters, notifications automatiques, promotions, accusés de réception sans valeur. Maximum 6.
- taskSuggestions : uniquement pour les mails qui nécessitent une action réelle d'Alexis. Maximum 4.
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
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!haikuRes.ok) {
    const err = await haikuRes.text();
    console.error('[Haiku error]', err);
    // En cas d'erreur Haiku, on renvoie une analyse vide plutôt que de planter
    return { synthesis: 'Analyse IA indisponible.', toDelete: [], taskSuggestions: [] };
  }

  const haikuData = await haikuRes.json();
  const raw = haikuData.content?.[0]?.text ?? '{}';

  try {
    return JSON.parse(raw);
  } catch {
    // Si le JSON est mal formé, extraction basique
    console.warn('[Haiku] JSON invalide:', raw.slice(0, 200));
    return { synthesis: raw.slice(0, 200), toDelete: [], taskSuggestions: [] };
  }
}
