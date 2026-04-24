// ═══════════════════════════════════════════════════════════
//  api/get-gmail-token.js  —  Helper OAuth one-shot
//
//  USAGE (une seule fois) :
//  1. Visite : https://ton-app.vercel.app/api/get-gmail-token
//     → Tu vois un lien "Autoriser Gmail"
//  2. Clique, connecte-toi avec ton compte Google, accepte
//  3. Google te redirige vers cette page avec ?code=xxx
//     → Tu vois ton GOOGLE_REFRESH_TOKEN affiché
//  4. Copie-le dans Vercel → Settings → Environment Variables
//  5. Supprime ou désactive cette route une fois le token obtenu
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).send(`
      <h2>Variables manquantes</h2>
      <p>Ajoute d'abord <code>GOOGLE_CLIENT_ID</code> et <code>GOOGLE_CLIENT_SECRET</code>
      dans Vercel → Settings → Environment Variables.</p>
    `);
  }

  // Redirect URI = cette même page
  const redirectUri = `https://${req.headers.host}/api/get-gmail-token`;

  // ── ÉTAPE 2 : Google renvoie ?code=xxx ──────────────────
  const { code } = req.query;
  if (code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();

      if (tokens.refresh_token) {
        return res.status(200).send(`
          <!DOCTYPE html><html lang="fr">
          <head><meta charset="UTF-8"><title>Token Gmail</title>
          <style>
            body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
            .box { background: #f0fdf4; border: 2px solid #22c55e; border-radius: 12px; padding: 24px; }
            code { background: #f1f5f9; padding: 12px 16px; border-radius: 8px; display: block;
                   word-break: break-all; font-size: 13px; margin: 12px 0; }
            .steps { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 16px; }
            li { margin: 8px 0; font-size: 14px; }
          </style></head>
          <body>
          <div class="box">
            <h2>✅ Refresh Token obtenu !</h2>
            <p><strong>GOOGLE_REFRESH_TOKEN</strong> à copier dans Vercel :</p>
            <code>${tokens.refresh_token}</code>
          </div>
          <div class="steps">
            <strong>Prochaines étapes :</strong>
            <ol>
              <li>Va sur <strong>vercel.com → ton projet → Settings → Environment Variables</strong></li>
              <li>Ajoute une variable : <code>GOOGLE_REFRESH_TOKEN</code> = la valeur ci-dessus</li>
              <li>Redéploie (ou fais un nouveau push GitHub)</li>
              <li>Ce helper n'est plus nécessaire — tu peux laisser comme tel, il ne fera rien sans ?code=</li>
            </ol>
          </div>
          </body></html>
        `);
      } else {
        return res.status(400).send(`
          <h2>Erreur</h2><pre>${JSON.stringify(tokens, null, 2)}</pre>
        `);
      }
    } catch (err) {
      return res.status(500).send(`<h2>Erreur</h2><p>${err.message}</p>`);
    }
  }

  // ── ÉTAPE 1 : Générer l'URL d'autorisation ──────────────
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         scopes,
    access_type:   'offline',
    prompt:        'consent',  // force le refresh_token même si déjà autorisé
  })}`;

  return res.status(200).send(`
    <!DOCTYPE html><html lang="fr">
    <head><meta charset="UTF-8"><title>Autoriser Gmail</title>
    <style>
      body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; }
      a.btn { display: inline-block; background: #1E3D6E; color: white; padding: 14px 28px;
              border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
      .warn { background: #fefce8; border: 1px solid #fde047; border-radius: 8px;
              padding: 12px 16px; margin-top: 20px; font-size: 13px; }
    </style></head>
    <body>
    <h2>🔐 Autorisation Gmail pour Elie</h2>
    <p>Clique sur le bouton, connecte-toi avec <strong>aberthe22@gmail.com</strong> et accepte les permissions.</p>
    <a class="btn" href="${authUrl}">Autoriser Gmail →</a>
    <div class="warn">
      ⚠️ Cette page est temporaire. Une fois ton refresh token obtenu, tu n'en as plus besoin.
    </div>
    </body></html>
  `);
}
