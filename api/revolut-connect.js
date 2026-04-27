// ═══════════════════════════════════════════════════════════
//  api/revolut-connect.js  —  Vercel Serverless Function
//
//  Wizard de connexion Nordigen → Revolut (à utiliser une fois
//  toutes les 90 jours pour renouveler l'autorisation bancaire)
//
//  GET ?action=start                 → crée une requisition et retourne le lien d'auth
//  GET ?action=finalize&reqId=xxx    → récupère les account IDs après autorisation
//
//  Variables d'env requises :
//    NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY
//  Optionnel :
//    NORDIGEN_INSTITUTION_ID  (défaut : REVOLUT_CZGB pour Revolut EU)
//    APP_URL                  (URL de redirection après auth, ex: https://elie.vercel.app)
// ═══════════════════════════════════════════════════════════

const BASE = 'https://bankaccountdata.gocardless.com/api/v2';

async function getToken(secretId, secretKey) {
  const res = await fetch(`${BASE}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
  });
  const data = await res.json();
  if (!data.access) throw new Error(`Token Nordigen KO: ${JSON.stringify(data)}`);
  return data.access;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY } = process.env;
  if (!NORDIGEN_SECRET_ID || !NORDIGEN_SECRET_KEY) {
    return res.status(500).json({ error: 'NORDIGEN_SECRET_ID / NORDIGEN_SECRET_KEY manquants' });
  }

  const action     = req.query?.action ?? 'start';
  const institutionId = process.env.NORDIGEN_INSTITUTION_ID ?? 'REVOLUT_CZGB';
  const appUrl     = process.env.APP_URL ?? `https://${req.headers.host}`;

  try {
    const token = await getToken(NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };

    // ── ÉTAPE 1 : Créer la requisition et retourner le lien d'auth ──
    if (action === 'start') {
      const r = await fetch(`${BASE}/requisitions/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          redirect:       `${appUrl}/#revolut-setup`,
          institution_id: institutionId,
          reference:      `elie-revolut-${Date.now()}`,
          user_language:  'FR',
        }),
      });
      if (!r.ok) throw new Error(`Nordigen requisition: ${await r.text()}`);
      const data = await r.json();
      return res.status(200).json({
        requisitionId: data.id,
        authUrl:       data.link,
      });
    }

    // ── ÉTAPE 2 : Récupérer les account IDs après autorisation ────
    if (action === 'finalize') {
      const reqId = req.query?.reqId;
      if (!reqId) return res.status(400).json({ error: 'reqId manquant' });

      const r = await fetch(`${BASE}/requisitions/${reqId}/`, { headers });
      if (!r.ok) throw new Error(`Nordigen requisition GET: ${await r.text()}`);
      const data = await r.json();

      if (!data.accounts?.length) {
        return res.status(200).json({
          status:  data.status,
          message: 'Autorisation en attente ou expirée',
          accounts: [],
        });
      }

      // Pour chaque compte, récupérer les métadonnées (nom, IBAN)
      const accountDetails = await Promise.allSettled(
        data.accounts.map(async id => {
          const r2 = await fetch(`${BASE}/accounts/${id}/details/`, { headers });
          const d2 = r2.ok ? await r2.json() : {};
          return { id, iban: d2.account?.iban, name: d2.account?.name || d2.account?.product };
        })
      );

      return res.status(200).json({
        status:   data.status,
        accounts: accountDetails.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean),
        message:  'Copie le NORDIGEN_ACCOUNT_ID de ton compte principal dans les variables Vercel',
      });
    }

    return res.status(400).json({ error: 'action invalide (start | finalize)' });

  } catch (err) {
    console.error('[revolut-connect]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
