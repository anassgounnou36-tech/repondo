// Repondo — /api/book
//
// GET  /api/book?client=recXXXX
//      -> { connected:true, slots:[{start,label}, ...] }  creneaux REELS, libres
//
// POST /api/book
//      { client, start, lead:{name,phone,message}, leadId? }
//      -> cree un vrai evenement dans l'agenda Google du client
//
// Aucun creneau n'est invente : ils viennent tous de l'API freeBusy de Google.
// Si l'agenda n'est pas connecte, on renvoie connected:false et l'appelant
// retombe sur le comportement actuel (proposer de rappeler).

import crypto from 'crypto';

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';
const LEADS_TABLE = 'tbl59sHf4hsoE7FIp';

const TZ = 'Africa/Casablanca';
const HEURES = [10, 11, 15, 16];   // heures locales proposees
const DUREE_MIN = 60;
const HORIZON_JOURS = 10;

function dechiffrer(paquet, secret) {
  const [ivB, tagB, dataB] = String(paquet || '').split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Jeton illisible');
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64url')), d.final()]).toString('utf8');
}

function airtable(path, options) {
  return fetch('https://api.airtable.com/v0/' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN,
      'Content-Type': 'application/json',
      ...(options && options.headers)
    }
  });
}

// Heure locale marocaine d'un instant UTC, sans dependance externe.
function partsLocales(date) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return p;
}

function libelle(date) {
  const p = partsLocales(date);
  return `${p.weekday} ${p.day} ${p.month} a ${p.hour}h${p.minute}`;
}

async function accessToken(client, secret) {
  const chiffre = client.fields['Google Refresh Token'];
  if (!chiffre) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: dechiffrer(chiffre, secret),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }).toString()
  });
  const data = await res.json();

  if (!res.ok) {
    // invalid_grant = le client a revoque l'acces, ou le jeton a expire
    // (7 jours tant que l'application Google n'est pas verifiee).
    console.error('Refresh Google echoue :', JSON.stringify(data).slice(0, 300));
    return null;
  }
  return data.access_token;
}

async function creneauxLibres(token, calendarId) {
  const debut = new Date(Date.now() + 12 * 3600 * 1000);
  const fin = new Date(Date.now() + HORIZON_JOURS * 24 * 3600 * 1000);

  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timeMin: debut.toISOString(),
      timeMax: fin.toISOString(),
      timeZone: TZ,
      items: [{ id: calendarId }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('freeBusy : ' + JSON.stringify(data).slice(0, 200));

  const cal = data.calendars && data.calendars[calendarId];
  const occupes = ((cal && cal.busy) || []).map(b => ({
    debut: new Date(b.start).getTime(),
    fin: new Date(b.end).getTime()
  }));

  const candidats = [];
  const curseur = new Date(debut);
  curseur.setUTCMinutes(0, 0, 0);

  while (curseur < fin && candidats.length < 40) {
    const p = partsLocales(curseur);
    const heure = parseInt(p.hour, 10);
    const dimanche = p.weekday.toLowerCase().startsWith('dim');

    if (!dimanche && HEURES.includes(heure) && parseInt(p.minute, 10) === 0) {
      const t = curseur.getTime();
      const tFin = t + DUREE_MIN * 60 * 1000;
      const collision = occupes.some(o => t < o.fin && tFin > o.debut);
      if (!collision) candidats.push(new Date(t));
    }
    curseur.setUTCHours(curseur.getUTCHours() + 1);
  }

  return candidats.slice(0, 2).map(d => ({ start: d.toISOString(), label: libelle(d) }));
}

async function chargerClient(recordId) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId || '')) return null;
  const res = await airtable(`${AIRTABLE_BASE}/${CLIENTS_TABLE}/${recordId}`);
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.TOKEN_SECRET;
  if (!secret || !process.env.GOOGLE_CLIENT_ID) {
    return res.status(200).json({ connected: false, raison: 'Google non configure' });
  }

  try {
    if (req.method === 'GET') {
      const client = await chargerClient(req.query.client);
      if (!client) return res.status(404).json({ connected: false, raison: 'client introuvable' });
      if (!client.fields['Google Connecte']) return res.status(200).json({ connected: false, slots: [] });

      const token = await accessToken(client, secret);
      if (!token) return res.status(200).json({ connected: false, raison: 'autorisation expiree', slots: [] });

      const slots = await creneauxLibres(token, client.fields['Google Calendar ID'] || 'primary');
      return res.status(200).json({ connected: true, slots });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { start, lead = {}, leadId } = body;

      const client = await chargerClient(body.client);
      if (!client) return res.status(404).json({ ok: false, raison: 'client introuvable' });

      const debut = new Date(start);
      if (isNaN(debut.getTime())) return res.status(400).json({ ok: false, raison: 'creneau invalide' });

      const token = await accessToken(client, secret);
      if (!token) return res.status(200).json({ ok: false, raison: 'autorisation expiree' });

      const nom = String(lead.name || 'Client').slice(0, 80);
      const tel = String(lead.phone || '').slice(0, 40);
      const demande = String(lead.message || '').slice(0, 1500);
      const fin = new Date(debut.getTime() + DUREE_MIN * 60 * 1000);

      const evenement = {
        summary: `Rendez-vous — ${nom}`,
        description:
          `Rendez-vous pris automatiquement par Repondo.\n\n` +
          `Contact : ${nom}\n` +
          (tel ? `Telephone : ${tel}\n` : '') +
          `\nDemande :\n${demande}`,
        start: { dateTime: debut.toISOString(), timeZone: TZ },
        end: { dateTime: fin.toISOString(), timeZone: TZ },
        reminders: { useDefault: true }
      };

      const calendarId = encodeURIComponent(client.fields['Google Calendar ID'] || 'primary');
      const evRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(evenement)
        }
      );
      const ev = await evRes.json();

      if (!evRes.ok) {
        console.error('Creation evenement echouee :', JSON.stringify(ev).slice(0, 300));
        return res.status(200).json({ ok: false, raison: 'creation refusee par Google' });
      }

      // Tracer le rendez-vous sur le lead, si on en a un.
      if (leadId && /^rec[A-Za-z0-9]{14}$/.test(leadId)) {
        await airtable(`${AIRTABLE_BASE}/${LEADS_TABLE}/${leadId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            fields: { 'RDV': debut.toISOString(), 'Google Event ID': ev.id, 'Status': 'Booked' },
            typecast: true
          })
        }).catch(e => console.error('Maj lead :', e && e.message));
      }

      return res.status(200).json({ ok: true, eventId: ev.id, label: libelle(debut) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('/api/book :', e && e.message);
    return res.status(200).json({ ok: false, connected: false, raison: 'erreur temporaire' });
  }
}
