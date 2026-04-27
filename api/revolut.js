// ═══════════════════════════════════════════════════════════
//  api/revolut.js  —  Vercel Serverless Function
//  Intégration Tink (open banking Visa) → Revolut + tout autre compte
//
//  GET                              → solde + transactions du mois
//  GET ?action=connect-start        → crée utilisateur Tink, retourne authUrl (Tink Link)
//  GET ?action=connect-finalize     → vérifie la connexion, retourne les comptes
//
//  Variables d'env requises :
//    TINK_CLIENT_ID, TINK_CLIENT_SECRET
//    TINK_EXTERNAL_USER_ID  (après connexion initiale, UUID choisi lors du connect-start)
//  Optionnel :
//    TINK_ACCOUNT_ID   (si plusieurs comptes, préciser lequel utiliser)
//    APP_URL           (URL de redirection après auth)
// ═══════════════════════════════════════════════════════════

const BASE      = 'https://api.tink.com/api/v1';
const DATA_BASE = 'https://api.tink.com/data/v2';

// Cache in-memory (instance Vercel, ~25min)
let _clientToken = null, _clientExpiry = 0;
let _userToken   = null, _userExpiry   = 0;

// ── Token client (client_credentials) ────────────────────
async function getClientToken(clientId, clientSecret) {
  if (_clientToken && Date.now() < _clientExpiry) return _clientToken;
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'client_credentials',
      scope:         'user:create,authorization:grant',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Client token Tink KO: ${JSON.stringify(data)}`);
  _clientToken  = data.access_token;
  _clientExpiry = Date.now() + 25 * 60 * 1000;
  return _clientToken;
}

// ── Token utilisateur (authorization_code flow) ───────────
async function getUserToken(clientId, clientSecret, externalUserId) {
  if (_userToken && Date.now() < _userExpiry) return _userToken;
  const clientToken = await getClientToken(clientId, clientSecret);

  // Générer un code d'autorisation pour l'utilisateur existant
  const grantRes = await fetch(`${BASE}/authorization/grant`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${clientToken}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({
      external_user_id: externalUserId,
      scope: 'accounts:read,balances:read,transactions:read,credentials:read,identity:read',
    }),
  });
  const grantData = await grantRes.json();
  if (!grantData.code) throw new Error(`Grant Tink KO: ${JSON.stringify(grantData)}`);

  // Échanger le code contre un user access token
  const tokenRes = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code:          grantData.code,
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`User token Tink KO: ${JSON.stringify(tokenData)}`);
  _userToken  = tokenData.access_token;
  _userExpiry = Date.now() + 25 * 60 * 1000;
  return _userToken;
}

// ── Convertir le montant Tink en float ────────────────────
function tinkAmount(value) {
  if (!value) return 0;
  const unscaled = parseFloat(value.unscaledValue ?? '0');
  const scale    = parseInt(value.scale ?? '0', 10);
  return unscaled / Math.pow(10, scale);
}

// ── Mapper la catégorie Tink PFM en français ─────────────
const CATEGORY_MAP = {
  'food-and-drinks':       'Restaurants',
  'groceries':             'Courses',
  'transport':             'Transport',
  'travel':                'Voyages',
  'shopping':              'Shopping',
  'entertainment':         'Sorties',
  'home':                  'Logement',
  'housing':               'Logement',
  'healthcare':            'Santé',
  'health-and-beauty':     'Santé',
  'subscriptions':         'Abonnements',
  'bills-and-utilities':   'Charges',
  'savings-and-transfers': 'Virements',
  'income':                'Revenus',
  'salary':                'Revenus',
  'transfers':             'Virements',
  'atm':                   'Espèces',
};
function mapCategory(tinkCat) {
  if (!tinkCat) return 'Autres';
  const key = (tinkCat.primaryName || tinkCat.name || tinkCat.id || '')
    .toLowerCase().replace(/[\s_]+/g, '-');
  return CATEGORY_MAP[key]
    ?? Object.entries(CATEGORY_MAP).find(([k]) => key.includes(k))?.[1]
    ?? 'Autres';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { TINK_CLIENT_ID, TINK_CLIENT_SECRET, TINK_EXTERNAL_USER_ID } = process.env;
  const action = req.query?.action ?? null;

  // ── WIZARD DE CONNEXION ──────────────────────────────────
  if (action === 'connect-start' || action === 'connect-finalize') {
    if (!TINK_CLIENT_ID || !TINK_CLIENT_SECRET) {
      return res.status(500).json({ error: 'TINK_CLIENT_ID / TINK_CLIENT_SECRET manquants' });
    }
    try {
      const clientToken = await getClientToken(TINK_CLIENT_ID, TINK_CLIENT_SECRET);
      const headers = {
        Authorization:  `Bearer ${clientToken}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      };

      // ── ÉTAPE 1 : Créer utilisateur + URL Tink Link ─────────
      if (action === 'connect-start') {
        const appUrl         = process.env.APP_URL ?? `https://${req.headers.host}`;
        const externalUserId = TINK_EXTERNAL_USER_ID ?? `elie-${Date.now()}`;

        // Créer l'utilisateur (idempotent si déjà existant)
        const createRes = await fetch(`${BASE}/user/create`, {
          method: 'POST', headers,
          body: JSON.stringify({ external_user_id: externalUserId, market: 'FR', locale: 'fr_FR' }),
        });
        const createBody = await createRes.text();
        console.log('[tink user/create]', createRes.status, createBody.slice(0, 200));
        // 409 = utilisateur déjà existant → OK
        if (!createRes.ok && createRes.status !== 409) {
          throw new Error(`user/create ${createRes.status}: ${createBody}`);
        }

        // Générer le code de délégation pour Tink Link
        const TINK_LINK_SCOPE = 'authorization:read,authorization:grant,credentials:refresh,credentials:read,credentials:write,providers:read,user:read,accounts:read,balances:read,transactions:read,identity:read';
        const delegateBody = new URLSearchParams({
          external_user_id: externalUserId,
          actor_client_id:  TINK_CLIENT_ID,
          scope:            TINK_LINK_SCOPE,
        });
        const delegateRes = await fetch(`${BASE}/oauth/authorization-grant/delegate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: delegateBody,
        });
        const delegateText = await delegateRes.text();
        console.log('[tink delegate]', delegateRes.status, delegateText.slice(0, 300));
        if (!delegateRes.ok) throw new Error(`Delegate grant ${delegateRes.status}: ${delegateText}`);
        const delegateData = JSON.parse(delegateText);
        const code = delegateData.code ?? delegateData.authorization_code;
        if (!code) throw new Error(`Pas de code dans la réponse: ${delegateText}`);

        const authUrl = `https://link.tink.com/1.0/transactions/connect-accounts`
          + `?client_id=${encodeURIComponent(TINK_CLIENT_ID)}`
          + `&redirect_uri=${encodeURIComponent(appUrl + '/#tink-setup')}`
          + `&authorization_code=${encodeURIComponent(code)}`
          + `&market=FR&locale=fr_FR`;

        return res.status(200).json({ externalUserId, authUrl });
      }

      // ── ÉTAPE 2 : Vérifier la connexion + lister les comptes ─
      if (action === 'connect-finalize') {
        const extId = TINK_EXTERNAL_USER_ID ?? req.query?.userId;
        if (!extId) return res.status(400).json({ error: 'TINK_EXTERNAL_USER_ID manquant' });

        const userToken = await getUserToken(TINK_CLIENT_ID, TINK_CLIENT_SECRET, extId);
        const accRes = await fetch(`${DATA_BASE}/accounts`, {
          headers: { Authorization: `Bearer ${userToken}`, Accept: 'application/json' },
        });
        if (!accRes.ok) throw new Error(`Accounts: ${await accRes.text()}`);
        const accData = await accRes.json();

        const accounts = (accData.accounts ?? []).map(a => ({
          id:       a.id,
          name:     a.name ?? a.type ?? 'Compte',
          iban:     a.identifiers?.iban?.iban ?? null,
          balance:  a.balances?.available?.amount
            ? Math.round(tinkAmount(a.balances.available.amount.value) * 100) / 100
            : a.balances?.booked?.amount
              ? Math.round(tinkAmount(a.balances.booked.amount.value) * 100) / 100
              : null,
          currency: a.balances?.available?.amount?.currencyCode
            ?? a.balances?.booked?.amount?.currencyCode
            ?? 'EUR',
        }));

        return res.status(200).json({ accounts });
      }
    } catch (err) {
      console.error('[tink connect]', err.message);
      return res.status(500).json({ error: err.message, detail: err.stack?.split('\n')[1] ?? '' });
    }
  }

  // ── DONNÉES (solde + transactions du mois) ────────────────
  if (!TINK_CLIENT_ID || !TINK_CLIENT_SECRET) {
    return res.status(200).json({ status: 'not_configured' });
  }
  if (!TINK_EXTERNAL_USER_ID) {
    return res.status(200).json({ status: 'not_connected' });
  }

  try {
    const userToken  = await getUserToken(TINK_CLIENT_ID, TINK_CLIENT_SECRET, TINK_EXTERNAL_USER_ID);
    const authHeader = { Authorization: `Bearer ${userToken}`, Accept: 'application/json' };

    const now       = new Date();
    const dateFrom  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const accountId = process.env.TINK_ACCOUNT_ID ?? null;

    const txParams = new URLSearchParams({ pageSize: '100', bookedDateGte: dateFrom });
    if (accountId) txParams.set('accountIdIn', accountId);

    const [accRes, txRes] = await Promise.all([
      fetch(`${DATA_BASE}/accounts`, { headers: authHeader }),
      fetch(`${DATA_BASE}/transactions?${txParams}`, { headers: authHeader }),
    ]);

    if (!accRes.ok) throw new Error(`Accounts Tink: ${accRes.status}`);
    if (!txRes.ok)  throw new Error(`Transactions Tink: ${txRes.status}`);

    const accData = await accRes.json();
    const txData  = await txRes.json();

    // Compte principal : TINK_ACCOUNT_ID en priorité, sinon premier CHECKING, sinon premier
    const accounts = accData.accounts ?? [];
    const account  = accountId
      ? accounts.find(a => a.id === accountId) ?? accounts[0]
      : accounts.find(a => a.type === 'CHECKING') ?? accounts[0];

    const balAmt   = account?.balances?.available?.amount?.value
      ?? account?.balances?.booked?.amount?.value;
    const balance  = balAmt ? Math.round(tinkAmount(balAmt) * 100) / 100 : null;
    const currency = account?.balances?.available?.amount?.currencyCode
      ?? account?.balances?.booked?.amount?.currencyCode
      ?? 'EUR';

    const transactions = (txData.transactions ?? [])
      .filter(tx => tx.status === 'BOOKED')
      .map(tx => {
        const amount   = Math.round(tinkAmount(tx.amount?.value) * 100) / 100;
        const label    = tx.descriptions?.display || tx.descriptions?.original || '(sans description)';
        const category = amount < 0 ? mapCategory(tx.categories?.pfm) : 'Revenus';
        return {
          id:       tx.id,
          date:     tx.dates?.booked ?? tx.dates?.value ?? '',
          amount,
          currency: tx.amount?.currencyCode ?? currency,
          label:    label.slice(0, 80),
          category,
        };
      })
      .sort((a, b) => (b.date > a.date ? 1 : -1));

    const byCategory = {};
    transactions.filter(t => t.amount < 0).forEach(t => {
      byCategory[t.category] = (byCategory[t.category] ?? 0) + Math.abs(t.amount);
    });
    const monthTotal = Object.values(byCategory).reduce((s, v) => s + v, 0);
    const categories = Object.entries(byCategory)
      .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    return res.status(200).json({
      status:       'connected',
      balance:      balance,
      currency,
      monthTotal:   Math.round(monthTotal * 100) / 100,
      categories,
      transactions: transactions.slice(0, 60),
      month:        now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
    });

  } catch (err) {
    console.error('[api/revolut/tink]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
