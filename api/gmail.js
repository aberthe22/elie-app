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

  const action = req.query?.action ?? null;

  // ── ACTION : draft-single — génère un brouillon pour un mail reclassé ──
  if (action === 'draft-single') {
    const mailId = req.query?.id;
    if (!mailId) return res.status(400).json({ error: 'id manquant' });
    try {
      const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

      // Récupérer le mail complet
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${mailId}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!msgRes.ok) throw new Error(`Gmail fetch mail: ${msgRes.status}`);
      const msg = await msgRes.json();

      const headers = msg.payload?.headers ?? [];
      const get = name => headers.find(h => h.name === name)?.value ?? '';
      const from    = get('From');
      const subject = get('Subject') || '(sans objet)';
      const body    = extractMailBody(msg.payload);
      const snippet = (msg.snippet ?? '').slice(0, 300);

      // Appel Haiku pour générer le brouillon
      const prompt = `Tu es l'assistante IA d'Alexis Berthe. Génère un brouillon de réponse pour ce mail.

De : ${from}
Objet : ${subject}
Contenu : ${body ? body.slice(0, 800) : snippet}

Réponds UNIQUEMENT avec le corps du mail (sans objet, sans en-tête).
Naturel, 2-4 phrases, signé "Alexis". Français. Pas de formules trop formelles.`;

      const haikuRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      if (!haikuRes.ok) throw new Error(`Haiku: ${haikuRes.status}`);
      const haikuData = await haikuRes.json();
      const draft = haikuData.content?.[0]?.text?.trim() ?? '';
      return res.status(200).json({ draftReply: draft });
    } catch (err) {
      console.error('[gmail/draft-single]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  const pageToken  = req.query?.pageToken ?? null;

  // Corrections utilisateur passées depuis le frontend pour l'apprentissage
  let corrections = [];
  if (req.query?.corrections) {
    try { corrections = JSON.parse(req.query.corrections); } catch {}
  }

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
    const analysis = await analyzeWithHaiku(emails, ANTHROPIC_API_KEY, corrections);

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

    const toArchive = (analysis.toArchive ?? [])
      .map(item => ({ ...emailMap[item.id], summary: item.summary, label: item.label }))
      .filter(e => e?.id);

    // ── 7. FILET DE SÉCURITÉ — aucun mail ne doit être perdu ─
    // Tout email non classé par Haiku atterrit automatiquement en toArchive
    const classifiedIds = new Set([
      ...toDelete.map(e => e.id),
      ...toReply.map(e => e.id),
      ...toTask.map(e => e.id),
      ...toArchive.map(e => e.id),
    ]);
    const unclassified = emails.filter(e => !classifiedIds.has(e.id));
    for (const mail of unclassified) {
      toArchive.push({
        ...mail,
        summary: mail.subject || mail.from || '(sans objet)',
        label:   'Autres',
      });
    }

    return res.status(200).json({
      toDelete, toReply, toTask, toArchive,
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

async function analyzeWithHaiku(emails, apiKey, corrections = []) {
  // Utiliser des numéros séquentiels comme IDs dans le prompt pour éviter que Haiku
  // mélange les longs IDs Gmail hexadécimaux → décorrélation titre/contenu impossible
  const seqToReal = {}; // "1" → vrai ID Gmail
  emails.forEach((e, i) => { seqToReal[String(i + 1)] = e.id; });

  const emailsText = emails.map((e, i) =>
    `[${i + 1}] De: ${e.from} <${e.email}>\n    Sujet: ${e.subject}\n    Date: ${e.date}\n    Aperçu: ${e.snippet}`
  ).join('\n\n');

  const catLabel = c => ({ delete: 'toDelete', reply: 'toReply', task: 'toTask', archive: 'toArchive' })[c] || c;
  const correctionsBlock = corrections.length > 0
    ? `\nCORRECTIONS PASSÉES D'ALEXIS (exemples réels, à respecter absolument) :
${corrections.map(c =>
  `- "${c.from}" · "${c.subject}" → était en ${catLabel(c.fromCat)}, Alexis a corrigé en ${catLabel(c.toCat)}.`
).join('\n')}\n`
    : '';

  const prompt = `Tu es l'assistante IA d'Alexis Berthe. Analyse ces ${emails.length} emails. Réponds UNIQUEMENT en JSON valide, sans markdown.

EMAILS (utilise le numéro entre crochets comme "id" dans ta réponse) :
${emailsText}

JSON attendu (id = numéro entre crochets, ex: "1", "2", "3"…) :
{
  "toDelete":  [{ "id": "1", "reason": "raison courte" }],
  "toReply":   [{ "id": "2", "draftReply": "Corps du mail, 2-3 phrases, signé Alexis." }],
  "toTask":    [{ "id": "3", "taskTitle": "Action concrète à faire" }],
  "toArchive": [{ "id": "4", "summary": "Reçu Anthropic · 9,00€", "label": "Factures" }]
}

${correctionsBlock}RÈGLES — lis attentivement avant de classer :

toDelete (emails à supprimer) — SEULEMENT si c'est clairement :
- Newsletter / email marketing / promotion commerciale sans valeur informative
- Notification automatique sans intérêt (réseaux sociaux, alertes vides)
- Spam ou email non sollicité
NE PAS mettre en toDelete : un email d'une vraie personne, un reçu/facture, une confirmation utile.

toReply (emails qui nécessitent une réponse) — SEULEMENT si :
- Envoyé par une vraie personne (pas un service automatique)
- Adressé directement à Alexis
- Attend clairement une réponse de sa part
Le draftReply = corps du mail uniquement, naturel, 2-3 phrases max, signé "Alexis".

toTask (emails qui impliquent une action sans réponse) — SEULEMENT si :
- Document à signer ou à lire impérativement
- Rendez-vous à confirmer
- Deadline ou engagement concret à honorer dans les prochains jours

toArchive (catégorie par défaut) — tout email qui n'est pas clairement à supprimer, répondre ou tasker :
- Reçu de paiement / facture déjà réglée
- Confirmation de commande / réservation (pour référence)
- Rapport ou relevé périodique (banque, GitHub, analytics)
- Mise à jour de service utile à conserver
- FYI envoyé sans réponse attendue
- Tout email ambigu ou inclassable → toArchive par défaut
Pour chaque mail : "summary" ultra-court (ex: "Reçu Anthropic · 9,00€", "Rapport hebdo GitHub"),
"label" choisi parmi : Factures, GitHub, Services, Banque, Shopping, Pro, Newsletters, Abonnements, Légal, Autres

RÈGLE ABSOLUE : chaque email doit apparaître dans exactement UNE catégorie. Aucun email ne doit être omis.
Maximum : 10 toDelete, 3 toReply, 3 toTask. Pas de limite pour toArchive.
Réponds UNIQUEMENT avec le JSON.`;

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
        max_tokens: 3000,
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
      // Nettoyer le JSON si Haiku a quand même ajouté du markdown
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed  = JSON.parse(cleaned);

      // Remplacer les numéros séquentiels par les vrais IDs Gmail
      const remapId = item => {
        const realId = seqToReal[String(item.id)];
        if (!realId) {
          console.warn('[Haiku] id inconnu ignoré:', item.id);
          return null;
        }
        return { ...item, id: realId };
      };
      return {
        toDelete:  (parsed.toDelete  ?? []).map(remapId).filter(Boolean),
        toReply:   (parsed.toReply   ?? []).map(remapId).filter(Boolean),
        toTask:    (parsed.toTask    ?? []).map(remapId).filter(Boolean),
        toArchive: (parsed.toArchive ?? []).map(remapId).filter(Boolean),
      };
    } catch {
      console.warn('[Haiku] JSON invalide (', raw.length, 'chars):', raw.slice(0, 300));
      return { toDelete: [], toReply: [], toTask: [], toArchive: [] };
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

// ── Extraire le texte brut d'un payload Gmail (MIME) ─────
function extractMailBody(payload) {
  if (!payload) return '';
  // Partie text/plain directe
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  // Multipart : chercher text/plain en premier
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    // Fallback récursif (multipart/alternative, etc.)
    for (const part of payload.parts) {
      const text = extractMailBody(part);
      if (text) return text;
    }
  }
  return '';
}
