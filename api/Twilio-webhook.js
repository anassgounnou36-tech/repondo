// Webhook Twilio pour WhatsApp — chaque client possede son PROPRE compte Twilio
// (option A : le client cree son compte, fait le Self Sign-up, et nous transmet
// son Account SID + Auth Token). Ce fichier gere donc PLUSIEURS comptes Twilio,
// un par client, identifies par le numero WhatsApp destinataire du message.
//
// Difference cle avec 360dialog : Twilio envoie le webhook en
// application/x-www-form-urlencoded (pas du JSON), et Twilio attend une reponse
// synchrone — soit du TwiML, soit un 200 vide suffit si on repond via l'API REST.
// On repond ici via l'API REST (plus simple a raisonner, memes outils que le
// webhook 360dialog) et on renvoie un TwiML vide pour satisfaire Twilio.

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const LEADS_TABLE = 'tbl59sHf4hsoE7FIp';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';

const LF = {
  name: 'fldZ3Xokiao4CX8r1', email: 'fld3SglGSET6wOOFa', phone: 'fldJ7XXQouRocnJMW',
  message: 'fldRqW73Vv00ceWYV', score: 'fldjE9v3qH1UKFitN', reply: 'flde6zKt8Wjiys8YF',
  status: 'fldaKympBbspmKbMT', source: 'fldEipiRxFKTMkVx7', date: 'fldlWYq2vORwUSWyC',
  client: 'flduLQneOSHEAxOzV'
};

// Champs Twilio a creer sur la table Clients (noms exacts, un par client) :
//   "Twilio Account SID"   — commence par AC...
//   "Twilio Auth Token"    — le jeton secret du compte
//   "Twilio Phone"         — le numero WhatsApp du client, ex: +212661234567

const REPONSE_NON_TEXTE =
  "Merci pour votre message ! Je ne peux pas encore lire les vocaux et les images — " +
  "pouvez-vous m'ecrire votre demande en quelques mots ? Quelqu'un de l'equipe regarde aussi de son cote.\n\n" +
  "Chokran 3la message dyalk ! Ma9dertch nsma3 lvocal, mumkin tkteb li chno bghiti f chi klma?";

function extractLastJson(text) {
  let results = [], depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) { results.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (let j = results.length - 1; j >= 0; j--) { try { return JSON.parse(results[j]); } catch (e) {} }
  return null;
}

async function airtable(path, options) {
  const res = await fetch('https://api.airtable.com/v0/' + path, {
    ...options,
    headers: { 'Authorization': 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json', ...(options && options.headers) }
  });
  return res.json();
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function echapper(v) {
  return String(v || '').replace(/["'\\]/g, '');
}

// Claude ecrit en markdown standard (**gras**) ; WhatsApp utilise sa propre
// syntaxe (*gras*). Sans conversion, le client voit des asterisques doubles
// affiches tels quels — ca ressemble immediatement a un bot mal fini.
function versWhatsApp(t) {
  return String(t || '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '• ');
}

// --- Identification du client : par le numero Twilio qui a recu le message ---
async function trouverClient(numeroDestinataire) {
  const num = digits(numeroDestinataire);
  if (!num) return null;

  const formule = `FIND("${num}", SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({Twilio Phone}, " ", ""), "+", ""), "-", "")) > 0`;
  const q = await airtable(
    AIRTABLE_BASE + '/' + CLIENTS_TABLE +
    '?filterByFormula=' + encodeURIComponent(formule) + '&maxRecords=1'
  );
  if (q.records && q.records[0]) return q.records[0];

  console.error('Aucun client Airtable pour le numero Twilio ' + num);
  return null;
}

// --- Anti-doublon : Twilio peut renvoyer le meme webhook en cas de timeout ---
async function dejaTraite(messageSid) {
  if (!messageSid) return false;
  try {
    const q = await airtable(
      AIRTABLE_BASE + '/' + LEADS_TABLE +
      '?filterByFormula=' + encodeURIComponent(`{WA Message ID}='${echapper(messageSid)}'`) + '&maxRecords=1'
    );
    if (q.error) return false;
    return !!(q.records && q.records[0]);
  } catch (e) {
    return false;
  }
}

// --- Memoire de conversation : erreur ici = on repond simplement sans historique
async function historique(telephone, clientId) {
  try {
    const q = await airtable(
      AIRTABLE_BASE + '/' + LEADS_TABLE +
      '?filterByFormula=' + encodeURIComponent(`{Phone}='${echapper(telephone)}'`) +
      '&maxRecords=6' +
      '&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc'
    );
    if (!q.records) return [];

    const pertinents = q.records
      .filter(r => (r.fields['Client'] || []).indexOf(clientId) !== -1)
      .reverse();

    const messages = [];
    for (const r of pertinents) {
      if (r.fields['Message']) messages.push({ role: 'user', content: String(r.fields['Message']).slice(0, 1500) });
      if (r.fields['AI Reply']) messages.push({ role: 'assistant', content: String(r.fields['AI Reply']).slice(0, 1500) });
    }
    return messages.slice(-8);
  } catch (e) {
    console.error('Historique indisponible :', e && e.message);
    return [];
  }
}

// Envoi via l'API REST Twilio (Basic Auth avec le SID + jeton DU CLIENT, pas les notres)
async function envoyerWhatsApp(accountSid, authToken, depuis, vers, texte) {
  const auth = Buffer.from(accountSid + ':' + authToken).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: 'whatsapp:' + depuis,
      To: 'whatsapp:' + vers,
      Body: texte
    }).toString()
  });
  if (!r.ok) console.error('Envoi Twilio echoue :', (await r.text()).slice(0, 300));
  return r.ok;
}

async function creerLead(champs) {
  const res = await airtable(AIRTABLE_BASE + '/' + LEADS_TABLE, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: champs }], typecast: true })
  });
  // Si "WA Message ID" n'existe pas encore comme champ, on reessaie sans lui
  // plutot que de perdre le lead.
  if (res.error && champs['WA Message ID']) {
    console.error('Champ WA Message ID absent — creation sans dedoublonnage.');
    const copie = { ...champs };
    delete copie['WA Message ID'];
    return airtable(AIRTABLE_BASE + '/' + LEADS_TABLE, {
      method: 'POST',
      body: JSON.stringify({ records: [{ fields: copie }], typecast: true })
    });
  }
  return res;
}

// Vercel decode automatiquement application/x-www-form-urlencoded dans req.body
// pour les fonctions Node — pas besoin de parser manuellement.
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const body = req.body || {};

  try {
    // Statuts de livraison (delivered/read/failed) : rien a faire, on acquitte.
    if (body.SmsStatus && body.SmsStatus !== 'received') {
      return res.status(200).send('<Response></Response>');
    }

    const messageSid = body.MessageSid || body.SmsSid;
    if (await dejaTraite(messageSid)) {
      return res.status(200).send('<Response></Response>');
    }

    // Twilio envoie "whatsapp:+212..." — on extrait le numero pur.
    const versNumero = String(body.To || '').replace('whatsapp:', '');
    const depuisNumero = String(body.From || '').replace('whatsapp:', '');
    const text = body.Body || '';
    const contactName = body.ProfileName || 'Client WhatsApp';
    const nbMedia = parseInt(body.NumMedia || '0', 10);

    const clientRec = await trouverClient(versNumero);
    if (!clientRec) {
      console.error('Client introuvable pour le numero Twilio ' + versNumero);
      return res.status(200).send('<Response></Response>');
    }

    const accountSid = clientRec.fields['Twilio Account SID'];
    const authToken = clientRec.fields['Twilio Auth Token'];
    if (!accountSid || !authToken) {
      console.error('Client ' + clientRec.id + ' sans identifiants Twilio');
      return res.status(200).send('<Response></Response>');
    }

    // --- Message non textuel (vocal, image, document) : on repond quand meme
    if (!text.trim() || nbMedia > 0) {
      const envoye = await envoyerWhatsApp(accountSid, authToken, versNumero, depuisNumero, REPONSE_NON_TEXTE);

      const champs = {};
      champs[LF.name] = contactName;
      champs[LF.phone] = depuisNumero;
      champs[LF.message] = `[Message ${nbMedia > 0 ? 'media' : 'vide'} recu — non lisible par le systeme. A traiter manuellement.]`;
      champs[LF.score] = 'Warm';
      champs[LF.reply] = REPONSE_NON_TEXTE;
      champs[LF.status] = 'New';
      champs[LF.source] = 'WhatsApp';
      champs[LF.date] = new Date().toISOString().slice(0, 10);
      champs[LF.client] = [clientRec.id];
      champs['WA Message ID'] = messageSid;
      await creerLead(champs);

      return res.status(200).send('<Response></Response>');
    }

    const cf = clientRec.fields;
    const configBlock = [
      'Business: ' + (cf['Entreprise'] || 'Non precise'),
      'Sector: ' + (cf['Secteur'] || 'Non precise'),
      'City: ' + (cf['Ville'] || 'Non precise'),
      'What they offer: ' + (cf['Services'] || 'Non precise'),
      'Tone: ' + (cf['Ton'] || 'Chaleureux'),
      'Never say: ' + (cf['Ne jamais dire'] || 'Aucun prix, aucune disponibilite, aucun taux de commission')
    ].join('\n');

    const SYSTEM_PROMPT = `You are answering WhatsApp messages on behalf of a business in Morocco.

=== THE BUSINESS YOU REPRESENT ===
${configBlock}

=== OUTPUT RULE ===
Produce exactly ONE answer. Decide the language first, think silently, write once.

=== CONVERSATION ===
Earlier messages in this thread are provided. Treat this as one continuous conversation: never re-introduce yourself, never ask again for something the person already told you, and read short replies ("oui", "mardi", "3 chambres") in the light of what came before.

=== LANGUAGE RULE ===
Reply in EXACTLY the same language AND script the person used. English->English only. French->French only. Darija in LATIN letters (salam, bghit, chhal, wach, dyali) -> Latin letters only, 3/7/9 for Arabic sounds, never Arabic script. Arabic script -> Arabic script. Spanish -> Spanish. Never mix scripts.

=== HONESTY RULE ===
Never invent facts. No access to prices, availability, commission rates, or slots. If asked, say you will check and come back. Respect the client restrictions above absolutely.

=== FORMATTING RULE ===
This is WhatsApp, not email. NEVER use markdown formatting (no **, no __, no #, no markdown bullet lists). WhatsApp uses single asterisks for bold (*like this*) if emphasis is truly needed — use it sparingly, plain text is usually better.

=== STYLE ===
Under 60 words. Natural, warm, human. No formal openings, no signature. Use their first name if known. Reference what they wrote. End with one clear question or a suggestion to arrange a time.

=== SCORING ===
Hot = clear need AND a specific budget or timeline. Warm = some details, key info missing. Cold = vague or just browsing.

Respond ONLY with raw JSON, no markdown, no backticks:
{"score":"Hot","budget":"value or Non precise","timeline":"value or Non precise","reply":"your reply"}`;

    const messages = (await historique(depuisNumero, clientRec.id)).concat([
      { role: 'user', content: 'Message recu de ' + contactName + ' :\n\n' + text }
    ]);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, system: SYSTEM_PROMPT, messages })
    });
    const claudeData = await claudeRes.json();
    if (claudeData.error) {
      console.error('Claude :', claudeData.error.message);
      return res.status(200).send('<Response></Response>');
    }

    const raw = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = extractLastJson(raw) || { score: 'Warm', budget: 'Non precise', timeline: 'Non precise', reply: raw.replace(/```json/g, '').replace(/```/g, '').trim() };

    const replyPropre = versWhatsApp(parsed.reply);
    const envoye = await envoyerWhatsApp(accountSid, authToken, versNumero, depuisNumero, replyPropre);

    const fields = {};
    fields[LF.name] = contactName;
    fields[LF.phone] = depuisNumero;
    fields[LF.message] = text;
    fields[LF.score] = parsed.score;
    fields[LF.reply] = replyPropre;
    fields[LF.status] = envoye ? 'Replied' : 'New';
    fields[LF.source] = 'WhatsApp';
    fields[LF.date] = new Date().toISOString().slice(0, 10);
    fields[LF.client] = [clientRec.id];
    fields['WA Message ID'] = messageSid;

    await creerLead(fields);

    return res.status(200).send('<Response></Response>');
  } catch (error) {
    console.error('Twilio webhook failed:', error);
    return res.status(200).send('<Response></Response>');
  }
}
