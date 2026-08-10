// Repondo — /api/calendar-callback
// Google renvoie le client ici apres autorisation. On echange le code contre
// un refresh token, on le chiffre, et on l'enregistre sur sa fiche Airtable.
//
// Le refresh token est un identifiant permanent : il est chiffre en AES-256-GCM
// avec TOKEN_SECRET avant d'etre stocke. Airtable ne contient jamais de jeton lisible.

import crypto from 'crypto';

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';

export function chiffrer(texte, secret) {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function dechiffrer(paquet, secret) {
  const [ivB, tagB, dataB] = String(paquet || '').split('.');
  if (!ivB || !tagB || !dataB) throw new Error('Jeton illisible');
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
  d.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(dataB, 'base64url')), d.final()]).toString('utf8');
}

function readState(state, secret) {
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
.card{background:#fff;border:1px solid #DFE4EA;border-radius:14px;padding:2rem;max-width:32rem}
h1{font-size:1.3rem;margin:0 0 .75rem}p{color:#5A6579;line-height:1.6;margin:0 0 .6rem}
.ok{color:#0F9F63;font-weight:600}</style>
</head><body><div class="card"><h1>${titre}</h1>${corps}</div></body></html>`;
}

export default async function handler(req, res) {
  const secret = process.env.TOKEN_SECRET;
  const appUrl = process.env.APP_URL || 'https://repondo.online';

  if (req.query.error) {
    return res.status(200).send(page('Connexion annulee',
      '<p>Vous avez refuse l\'acces, ou la fenetre a ete fermee. Aucune donnee n\'a ete enregistree.</p>' +
      '<p>Vous pouvez relancer la connexion depuis le lien qu\'on vous a envoye.</p>'));
  }

  const etat = readState(req.query.state, secret || '');
  if (!etat || !etat.c) {
    return res.status(400).send(page('Lien expire ou invalide',
      '<p>Cette demande de connexion n\'est pas valide. Demandez-nous un nouveau lien.</p>'));
  }

  try {
    // 1. Echanger le code contre un refresh token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: appUrl + '/api/calendar-callback',
        grant_type: 'authorization_code'
      }).toString()
    });
    const token = await tokenRes.json();

    if (!tokenRes.ok || !token.refresh_token) {
      console.error('Echange OAuth echoue :', JSON.stringify(token).slice(0, 400));
      return res.status(200).send(page('Connexion incomplete',
        '<p>Google n\'a pas renvoye d\'autorisation permanente. Cela arrive quand le compte etait deja connecte.</p>' +
        '<p>Retirez Repondo depuis <b>myaccount.google.com/permissions</b>, puis recommencez.</p>'));
    }

    // 2. Identifier l'agenda principal
    const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
      headers: { Authorization: 'Bearer ' + token.access_token }
    });
    const cal = await calRes.json();
    const calendarId = cal.id || 'primary';

    // 3. Enregistrer, chiffre, sur la fiche client
    const fields = {
      'Google Refresh Token': chiffrer(token.refresh_token, secret),
      'Google Calendar ID': calendarId,
      'Google Connecte': true
    };

    const patch = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${CLIENTS_TABLE}/${etat.c}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields, typecast: true })
      }
    );

    if (!patch.ok) {
      console.error('Airtable PATCH echoue :', (await patch.text()).slice(0, 400));
      return res.status(200).send(page('Presque',
        '<p>Google a bien autorise l\'acces, mais l\'enregistrement a echoue de notre cote. Prevenez-nous, on corrige en quelques minutes.</p>'));
    }

    return res.status(200).send(page('Votre agenda est connecte',
      `<p class="ok">C'est fait.</p>
       <p>Agenda relie : <b>${calendarId}</b></p>
       <p>A partir de maintenant, quand un client serieux demande un rendez-vous, le systeme regarde vos disponibilites reelles et propose deux creneaux libres. Le rendez-vous apparait directement dans cet agenda.</p>
       <p>Vous n'avez rien d'autre a faire. Vous pouvez fermer cette page.</p>
       <p>Pour retirer l'acces a tout moment : myaccount.google.com/permissions</p>`));
  } catch (e) {
    console.error('Callback calendrier :', e && e.message);
    return res.status(200).send(page('Erreur temporaire',
      '<p>Quelque chose s\'est mal passe pendant la connexion. Reessayez dans un instant.</p>'));
  }
}
