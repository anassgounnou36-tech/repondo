// Repondo — /api/calendar-connect
// Point d'entree OAuth : le client clique sur ce lien, autorise son Google
// Calendar, et repart. Nous ne voyons jamais son mot de passe.
//
// Usage : https://repondo.online/api/calendar-connect?client=recXXXXXXXXXXXXXX
//
// Le parametre "state" est signe (HMAC) pour qu'on ne puisse pas rattacher
// un calendrier a la fiche d'un autre client en bidouillant l'URL.

import crypto from 'crypto';

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
].join(' ');

export function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

export function readState(state, secret) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function page(titre, corps) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titre} · Repondo</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F6F8;color:#111826;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}
.card{background:#fff;border:1px solid #DFE4EA;border-radius:14px;padding:2rem;max-width:30rem}
h1{font-size:1.25rem;margin:0 0 .75rem}p{color:#5A6579;line-height:1.6;margin:0 0 .5rem}</style>
</head><body><div class="card"><h1>${titre}</h1>${corps}</div></body></html>`;
}

export default async function handler(req, res) {
  const secret = process.env.TOKEN_SECRET;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl = process.env.APP_URL || 'https://repondo.online';

  if (!clientId || !secret) {
    return res.status(500).send(page('Configuration incomplete',
      '<p>Les variables GOOGLE_CLIENT_ID et TOKEN_SECRET ne sont pas encore definies sur Vercel.</p>'));
  }

  const recordId = req.query.client;
  if (!recordId || !/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
    return res.status(400).send(page('Lien invalide',
      '<p>Ce lien de connexion est incomplet. Demandez-nous un nouveau lien.</p>'));
  }

  // On verifie que la fiche client existe avant d'envoyer qui que ce soit chez Google.
  try {
    const check = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CLIENTS_TABLE}/${recordId}`,
      { headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN } }
    );
    if (!check.ok) {
      return res.status(404).send(page('Lien invalide',
        '<p>Ce lien ne correspond a aucun compte. Demandez-nous un nouveau lien.</p>'));
    }
  } catch (e) {
    return res.status(500).send(page('Erreur temporaire',
      '<p>Impossible de verifier le compte pour le moment. Reessayez dans un instant.</p>'));
  }

  const state = signState({ c: recordId, t: Date.now() }, secret);

  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: appUrl + '/api/calendar-callback',
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  }).toString();

  res.writeHead(302, { Location: url });
  res.end();
}
