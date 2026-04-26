// ═══════════════════════════════════════════════════════════
//  api/calendar.js  —  Vercel Serverless Function
//
//  Récupère les événements Google Calendar :
//    - Aujourd'hui (groupé séparément)
//    - Les 6 jours suivants (groupés par jour)
//
//  Variables d'env requises :
//    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return res.status(500).json({ error: 'Variables Google manquantes' });
  }

  try {
    const accessToken = await getAccessToken(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN);

    // Fenêtre : aujourd'hui 00:00 → dans 7 jours 23:59
    const now       = new Date();
    const timeMin   = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const timeMax   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 23, 59).toISOString();

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents:  'true',
        orderBy:       'startTime',
        maxResults:    '30',
      }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calRes.ok) throw new Error(`Calendar API: ${calRes.status}`);
    const calData = await calRes.json();

    // ── Transformation ────────────────────────────────────
    const events = (calData.items ?? []).map(ev => {
      const isAllDay  = !!ev.start?.date; // all-day events ont start.date, pas start.dateTime
      const startRaw  = isAllDay ? ev.start.date : ev.start.dateTime;
      const endRaw    = isAllDay ? ev.end?.date   : ev.end?.dateTime;
      const startDate = new Date(startRaw);

      return {
        id:       ev.id,
        summary:  ev.summary || '(sans titre)',
        location: ev.location ?? null,
        start:    startRaw,
        end:      endRaw ?? null,
        allDay:   isAllDay,
        startTime: isAllDay ? null : formatTime(startDate),
        dayKey:   startRaw.slice(0, 10), // YYYY-MM-DD
      };
    });

    // ── Groupement par jour ───────────────────────────────
    const todayKey = now.toISOString().slice(0, 10);

    const today    = events.filter(e => e.dayKey === todayKey);
    const upcoming = {};

    events
      .filter(e => e.dayKey > todayKey)
      .forEach(e => {
        if (!upcoming[e.dayKey]) upcoming[e.dayKey] = [];
        upcoming[e.dayKey].push(e);
      });

    // Convertit en tableau trié avec labels lisibles
    const upcomingArr = Object.entries(upcoming)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, evs]) => ({
        dayKey: key,
        label:  formatDayLabel(key, now),
        events: evs,
      }));

    return res.status(200).json({ today, upcoming: upcomingArr });

  } catch (error) {
    console.error('[api/calendar]', error.message);
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

function formatTime(date) {
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(dayKey, now) {
  const d       = new Date(dayKey + 'T12:00:00'); // midi pour éviter les décalages DST
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffMs  = d - today;
  const diffDays = Math.round(diffMs / 86400000);
  if (diffDays === 1) return 'Demain';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
