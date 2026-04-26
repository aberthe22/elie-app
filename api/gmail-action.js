// ═══════════════════════════════════════════════════════════
//  api/gmail-action.js  —  Vercel Serverless Function
//
//  Actions disponibles (POST JSON) :
//    delete  : { action:"delete",  ids:["id1","id2"] }
//    archive : { action:"archive", ids:["id1"] }
//    read    : { action:"read",    ids:["id1"] }
//    send    : { action:"send",    replyTo, subject, body, threadId, inReplyTo }
//
//  Variables d'env requises :
//    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Variables Google manquantes' });
  }

  const { action } = req.body ?? {};
  if (!action || !['delete', 'archive', 'read', 'send'].includes(action)) {
    return res.status(400).json({ error: 'action invalide' });
  }

  try {
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // ── ACTION : SEND ────────────────────────────────────────
    if (action === 'send') {
      const { replyTo, subject, body, threadId, inReplyTo } = req.body;
      if (!replyTo || !body) {
        return res.status(400).json({ error: 'replyTo et body sont requis pour send' });
      }

      // Construction du message RFC 2822
      const subjectEncoded = subject || '(sans objet)';
      const lines = [
        `To: ${replyTo}`,
        `Subject: ${subjectEncoded}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
      ];
      if (inReplyTo) {
        lines.push(`In-Reply-To: ${inReplyTo}`);
        lines.push(`References: ${inReplyTo}`);
      }
      lines.push('', body); // ligne vide = séparation headers/corps

      const rawMessage = lines.join('\r\n');

      // Base64url (standard Gmail API)
      const raw = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
      });

      if (!sendRes.ok) {
        const err = await sendRes.text();
        throw new Error(`Gmail send ${sendRes.status}: ${err}`);
      }

      const sent = await sendRes.json();
      return res.status(200).json({ success: true, messageId: sent.id });
    }

    // ── ACTIONS SUR IDs MULTIPLES ────────────────────────────
    const { ids, label } = req.body; // label optionnel pour archive avec sous-dossier
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids doit être un tableau non vide' });
    }

    // Pré-résoudre le label Gmail une seule fois si besoin (évite N appels list)
    let resolvedLabelId = null;
    if (action === 'archive' && label) {
      resolvedLabelId = await getOrCreateLabel(label, accessToken);
    }

    const results = await Promise.allSettled(
      ids.map(id => applyAction(id, action, accessToken, resolvedLabelId))
    );

    const succeeded = results
      .map((r, i) => r.status === 'fulfilled' ? ids[i] : null)
      .filter(Boolean);
    const failed = results
      .map((r, i) => r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null)
      .filter(Boolean);

    return res.status(200).json({ succeeded, failed });

  } catch (error) {
    console.error('[api/gmail-action]', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// ── Action sur un seul message ────────────────────────────

async function applyAction(messageId, action, accessToken, labelId = null) {
  const base    = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  if (action === 'delete') {
    const res = await fetch(`${base}/trash`, { method: 'POST', headers });
    if (!res.ok) throw new Error(`trash ${messageId}: ${res.status}`);
    return;
  }
  if (action === 'archive') {
    const body = { removeLabelIds: ['INBOX', 'UNREAD'] };
    if (labelId) body.addLabelIds = [labelId];
    const res = await fetch(`${base}/modify`, {
      method: 'POST', headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`archive ${messageId}: ${res.status}`);
    return;
  }
  if (action === 'read') {
    const res = await fetch(`${base}/modify`, {
      method: 'POST', headers,
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
    if (!res.ok) throw new Error(`read ${messageId}: ${res.status}`);
    return;
  }
}

// ── Créer ou retrouver un label Gmail ────────────────────
async function getOrCreateLabel(name, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  try {
    // Liste les labels existants
    const listRes  = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers });
    if (!listRes.ok) return null;
    const listData = await listRes.json();
    const existing = (listData.labels ?? []).find(
      l => l.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) return existing.id;

    // Crée le label s'il n'existe pas
    const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      method: 'POST', headers,
      body: JSON.stringify({
        name,
        labelListVisibility:   'labelShow',
        messageListVisibility: 'show',
      }),
    });
    if (!createRes.ok) return null;
    const created = await createRes.json();
    return created.id;
  } catch { return null; }
}

// ── Refresh token → access token ─────────────────────────

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
