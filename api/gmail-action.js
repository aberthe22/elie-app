// ═══════════════════════════════════════════════════════════
//  api/gmail-action.js  —  Vercel Serverless Function
//
//  Effectue une action sur un ou plusieurs emails Gmail :
//    - "delete"  : déplace vers la corbeille (TRASH)
//    - "archive" : retire INBOX (archive sans supprimer)
//    - "read"    : retire le label UNREAD
//
//  Body JSON attendu :
//    { action: "delete" | "archive" | "read", ids: ["id1", "id2", ...] }
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

  const { action, ids } = req.body ?? {};

  if (!action || !['delete', 'archive', 'read'].includes(action)) {
    return res.status(400).json({ error: 'action doit être "delete", "archive" ou "read"' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids doit être un tableau non vide' });
  }

  try {
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // ── Exécuter l'action sur chaque message en parallèle ──
    const results = await Promise.allSettled(
      ids.map(id => applyAction(id, action, accessToken))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled').map((_, i) => ids[i]);
    const failed    = results
      .map((r, i) => r.status === 'rejected' ? { id: ids[i], error: r.reason?.message } : null)
      .filter(Boolean);

    return res.status(200).json({ succeeded, failed });

  } catch (error) {
    console.error('[api/gmail-action]', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// ── Applique l'action sur un seul message ─────────────────

async function applyAction(messageId, action, accessToken) {
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;
  const headers = {
    Authorization:  `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  if (action === 'delete') {
    // Déplace vers TRASH (récupérable 30 jours)
    const res = await fetch(`${base}/trash`, {
      method: 'POST',
      headers,
    });
    if (!res.ok) throw new Error(`trash ${messageId}: ${res.status}`);
    return;
  }

  if (action === 'archive') {
    // Retire le label INBOX → archive sans supprimer
    const res = await fetch(`${base}/modify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    });
    if (!res.ok) throw new Error(`archive ${messageId}: ${res.status}`);
    return;
  }

  if (action === 'read') {
    // Retire le label UNREAD → marque comme lu
    const res = await fetch(`${base}/modify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
    if (!res.ok) throw new Error(`read ${messageId}: ${res.status}`);
    return;
  }
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
