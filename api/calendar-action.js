// ═══════════════════════════════════════════════════════════
//  api/calendar-action.js  —  Vercel Serverless Function
//
//  Crée un événement dans Google Calendar (POST).
//
//  Body JSON attendu :
//  {
//    summary:     "Titre de l'événement",  (requis)
//    date:        "2026-04-29",             (requis, YYYY-MM-DD)
//    startTime:   "10:00",                  (optionnel — si absent = journée entière)
//    endTime:     "11:00",                  (optionnel — si absent = startTime + 1h)
//    description: "Notes…",                 (optionnel)
//  }
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

  const { summary, date, startTime, endTime, description, reminderMinutes } = req.body ?? {};

  if (!summary?.trim()) return res.status(400).json({ error: 'summary requis' });
  if (!date?.match(/^\d{4}-\d{2}-\d{2}$/)) return res.status(400).json({ error: 'date invalide (YYYY-MM-DD)' });

  // reminderMinutes : null = défaut Google, -1 = aucun rappel, sinon nombre de minutes avant
  const remindersBlock = reminderMinutes == null
    ? { useDefault: true }
    : reminderMinutes === -1
      ? { useDefault: false, overrides: [] }
      : { useDefault: false, overrides: [{ method: 'popup', minutes: Number(reminderMinutes) }] };

  try {
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    let eventBody;

    if (!startTime) {
      // ── Événement sur toute la journée
      eventBody = {
        summary: summary.trim(),
        description: description ?? undefined,
        start: { date },
        end:   { date: nextDay(date) },
        reminders: remindersBlock,
      };
    } else {
      // ── Événement avec heure précise
      const startDateTime = `${date}T${startTime}:00`;
      const endDateTime   = endTime
        ? `${date}T${endTime}:00`
        : addOneHour(startDateTime);

      eventBody = {
        summary:     summary.trim(),
        description: description ?? undefined,
        start: { dateTime: startDateTime, timeZone: 'Europe/Paris' },
        end:   { dateTime: endDateTime,   timeZone: 'Europe/Paris' },
        reminders: remindersBlock,
      };
    }

    const createRes = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Calendar create ${createRes.status}: ${err}`);
    }

    const event = await createRes.json();
    return res.status(201).json({
      success:  true,
      id:       event.id,
      summary:  event.summary,
      htmlLink: event.htmlLink,
    });

  } catch (error) {
    console.error('[api/calendar-action]', error.message);
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

function nextDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addOneHour(dateTimeStr) {
  const d = new Date(dateTimeStr);
  d.setHours(d.getHours() + 1);
  return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
}
