// ═══════════════════════════════════════════════════════════
//  api/budget-vision.js  —  Vercel Serverless Function
//  Analyse une capture d'écran Revolut via Claude Haiku Vision
//
//  POST { image: "base64...", mimeType: "image/jpeg" }
//       → { month, totalSpent, totalBudget, categories, advice }
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST uniquement' });

  const { image, mimeType = 'image/jpeg' } = req.body ?? {};
  if (!image) return res.status(400).json({ error: 'image (base64) requis' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquant' });

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type:   'image',
              source: { type: 'base64', media_type: mimeType, data: image },
            },
            {
              type: 'text',
              text: `Tu analyses une capture d'écran de l'application Revolut (budgets ou dépenses) d'un entrepreneur français.

Extrais toutes les informations visibles. Réponds UNIQUEMENT avec un JSON valide sans texte autour :
{
  "month": "mois/période visible ou null",
  "totalSpent": montant_total_dépensé_nombre_ou_null,
  "totalBudget": budget_total_nombre_ou_null,
  "categories": [
    { "name": "nom", "spent": montant_nombre, "budget": budget_nombre_ou_null, "percentage": pourcentage_utilisé_ou_null }
  ],
  "advice": "2-3 lignes de conseils concrets et personnalisés sur la gestion du budget visible, en français"
}

Si les chiffres ne sont pas lisibles, retourne categories:[] et explique dans advice.`,
            },
          ],
        }],
      }),
    });

    if (!aiRes.ok) throw new Error(`Claude ${aiRes.status}`);
    const aiData = await aiRes.json();
    const text   = aiData.content?.[0]?.text ?? '';
    const match  = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Parsing échoué', raw: text.slice(0, 300) });

    return res.status(200).json(JSON.parse(match[0]));
  } catch (e) {
    console.error('[budget-vision]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
