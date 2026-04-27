// ═══════════════════════════════════════════════════════════
//  api/revolut.js  —  Vercel Serverless Function
//
//  GET                              → balance + transactions du mois
//  GET ?action=connect-start        → crée requisition Nordigen, retourne authUrl
//  GET ?action=connect-finalize&reqId=xxx → retourne les account IDs
//
//  Variables d'env requises :
//    NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY
//    NORDIGEN_ACCOUNT_ID  (après connexion initiale)
//  Optionnel :
//    NORDIGEN_INSTITUTION_ID  (défaut : REVOLUT_CZGB)
//    APP_URL                  (URL de redirection après auth)
// ═══════════════════════════════════════════════════════════

const BASE = 'https://bankaccountdata.gocardless.com/api/v2';

// Cache in-memory du token Nordigen (dure 23h par instance)
let _tokenCache = null;
let _tokenExpiry = 0;

async function getToken(secretId, secretKey) {
  if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;
  const res = await fetch(`${BASE}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
  });
  const data = await res.json();
  if (!data.access) throw new Error(`Token Nordigen KO: ${JSON.stringify(data)}`);
  _tokenCache  = data.access;
  _tokenExpiry = Date.now() + 23 * 3600 * 1000;
  return _tokenCache;
}

function guessCategory(tx) {
  const text = [
    tx.remittanceInformationUnstructured,
    tx.remittanceInformationStructured,
    tx.creditorName,
    tx.debtorName,
    tx.additionalInformation,
  ].filter(Boolean).join(' ');

  const t = text.toLowerCase();
  if (/restaurant|café|coffee|pizza|burger|sushi|brasserie|bistro|traiteur|deliveroo|uber.eat|just.eat|doordash/.test(t)) return 'Restaurants';
  if (/carrefour|leclerc|lidl|aldi|auchan|monoprix|franprix|intermarché|casino|super|marché|épicerie/.test(t)) return 'Courses';
  if (/ratp|sncf|navigo|train|tgv|blablacar|taxi|uber|bolt|lime|vélib|parking|peage|autoroute/.test(t)) return 'Transport';
  if (/amazon|fnac|cdiscount|zalando|asos|shein|shop|zara|hm|uniqlo|ikea/.test(t)) return 'Shopping';
  if (/netflix|spotify|apple|google|microsoft|amazon.prime|disney|canal|free|sfr|orange|bouygues|deezer/.test(t)) return 'Abonnements';
  if (/loyer|rent|immobilier|agence|bail/.test(t)) return 'Logement';
  if (/pharmacie|médecin|docteur|clinique|hopital|mutuelle|santé|doctor|health/.test(t)) return 'Santé';
  if (/bar|pub|club|disco|soirée|concert|billet|théâtre|cinéma/.test(t)) return 'Sorties';
  if (/airbnb|booking|hotel|hôtel|hostel|voyage|air.france|easyjet|ryanair|sncf.voyage/.test(t)) return 'Voyages';
  if (/electric|gaz|edf|engie|eau/.test(t)) return 'Charges';
  return 'Autres';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY, NORDIGEN_ACCOUNT_ID } = process.env;
  const action = req.query?.action ?? null;

  // ── WIZARD DE CONNEXION ────────────────────────────────────
  if (action === 'connect-start' || action === 'connect-finalize') {
    if (!NORDIGEN_SECRET_ID || !NORDIGEN_SECRET_KEY) {
      return res.status(500).json({ error: 'NORDIGEN_SECRET_ID / NORDIGEN_SECRET_KEY manquants' });
    }
    try {
      const token = await getToken(NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };

      if (action === 'connect-start') {
        const institutionId = process.env.NORDIGEN_INSTITUTION_ID ?? 'REVOLUT_CZGB';
        const appUrl        = process.env.APP_URL ?? `https://${req.headers.host}`;
        const r = await fetch(`${BASE}/requisitions/`, {
          method: 'POST', headers,
          body: JSON.stringify({
            redirect:       `${appUrl}/#revolut-setup`,
            institution_id: institutionId,
            reference:      `elie-revolut-${Date.now()}`,
            user_language:  'FR',
          }),
        });
        if (!r.ok) throw new Error(`Nordigen requisition: ${await r.text()}`);
        const data = await r.json();
        return res.status(200).json({ requisitionId: data.id, authUrl: data.link });
      }

      if (action === 'connect-finalize') {
        const reqId = req.query?.reqId;
        if (!reqId) return res.status(400).json({ error: 'reqId manquant' });
        const r = await fetch(`${BASE}/requisitions/${reqId}/`, { headers });
        if (!r.ok) throw new Error(`Nordigen requisition GET: ${await r.text()}`);
        const data = await r.json();
        if (!data.accounts?.length) {
          return res.status(200).json({ status: data.status, message: 'Autorisation en attente ou expirée', accounts: [] });
        }
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
        });
      }
    } catch (err) {
      console.error('[revolut connect]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DONNÉES (balance + transactions) ─────────────────────
  if (!NORDIGEN_SECRET_ID || !NORDIGEN_SECRET_KEY) {
    return res.status(200).json({ status: 'not_configured' });
  }
  if (!NORDIGEN_ACCOUNT_ID) {
    return res.status(200).json({ status: 'not_connected' });
  }

  try {
    const token   = await getToken(NORDIGEN_SECRET_ID, NORDIGEN_SECRET_KEY);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    const [balRes, txRes] = await Promise.all([
      fetch(`${BASE}/accounts/${NORDIGEN_ACCOUNT_ID}/balances/`, { headers }),
      (() => {
        const now = new Date();
        const dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        return fetch(`${BASE}/accounts/${NORDIGEN_ACCOUNT_ID}/transactions/?date_from=${dateFrom}`, { headers });
      })(),
    ]);

    if (!balRes.ok) throw new Error(`Balances: ${balRes.status}`);
    if (!txRes.ok)  throw new Error(`Transactions: ${txRes.status}`);

    const balData  = await balRes.json();
    const txData   = await txRes.json();

    const balances  = balData.balances ?? [];
    const available = balances.find(b => b.balanceType === 'interimAvailable')
      ?? balances.find(b => b.balanceType === 'closingAvailable')
      ?? balances[0];
    const balance  = available ? parseFloat(available.balanceAmount.amount) : null;
    const currency = available?.balanceAmount?.currency ?? 'EUR';

    const booked = txData.transactions?.booked ?? [];
    const transactions = booked.map(tx => {
      const amount = parseFloat(tx.transactionAmount.amount);
      const label  = tx.remittanceInformationUnstructured || tx.remittanceInformationStructured
        || tx.creditorName || tx.debtorName || '(sans description)';
      return {
        id:       tx.transactionId || tx.internalTransactionId || Math.random().toString(36).slice(2),
        date:     tx.bookingDate || tx.valueDate || '',
        amount,
        currency: tx.transactionAmount.currency,
        label:    label.slice(0, 80),
        category: amount < 0 ? guessCategory(tx) : 'Revenus',
      };
    }).sort((a, b) => (b.date > a.date ? 1 : -1));

    const byCategory = {};
    transactions.filter(t => t.amount < 0).forEach(t => {
      byCategory[t.category] = (byCategory[t.category] ?? 0) + Math.abs(t.amount);
    });
    const monthTotal  = Object.values(byCategory).reduce((s, v) => s + v, 0);
    const categories  = Object.entries(byCategory)
      .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    const now = new Date();
    return res.status(200).json({
      status:       'connected',
      balance:      balance !== null ? Math.round(balance * 100) / 100 : null,
      currency,
      monthTotal:   Math.round(monthTotal * 100) / 100,
      categories,
      transactions: transactions.slice(0, 60),
      month:        now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
    });

  } catch (err) {
    console.error('[api/revolut]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
