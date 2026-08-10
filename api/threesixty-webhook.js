// Webhook unique 360dialog : gere 2 types d'evenements
// 1. Notification "channel ready" -> on enregistre la cle API du client
// 2. Message WhatsApp entrant -> on genere et envoie la reponse
//
// Corrections apportees :
//  [1] Le client est identifie par le numero destinataire du message
//      (metadata.display_phone_number). 360dialog ne renvoie pas votre cle
//      de canal dans le webhook. L'ancien ?key= reste accepte en secours.
//  [2] Memoire de conversation : les echanges precedents avec ce numero
//      sont relus depuis Airtable et transmis au modele.
//  [3] Messages non textuels (vocal, photo, document) : le client recoit
//      toujours une reponse, et le lead est marque "New" pour traitement humain.
//  [4] Anti-doublon : Meta/360dialog rejouent les webhooks non acquittes.
//      On ignore un message deja traite (champ "WA Message ID").

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const LEADS_TABLE = 'tbl59sHf4hsoE7FIp';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';

const CF = {
  channelKey: 'fldkCBDYJF4Qnll6H',
  phone: 'fldOXzvEjYtSbqohP',
  entreprise: 'fldGwdcbt1I33jZG3',
  secteur: 'fld0YFbfSlLqWkumX',
  ville: 'fldNrMKDs6GZuLz2B',
  services: 'fldwKCuQRy0FNCkFq',
  ton: 'fldyjcEUkyhpVnOwY',
  interdits: 'fldL2SWg5pcZZOEct'
};

const LF = {
  name: 'fldZ3Xokiao4CX8r1', email: 'fld3SglGSET6wOOFa', phone: 'fldJ7XXQouRocnJMW',
  message: 'fldRqW73Vv00ceWYV', score: 'fldjE9v3qH1UKFitN', reply: 'flde6zKt8Wjiys8YF',
  status: 'fldaKympBbspmKbMT', source: 'fldEipiRxFKTMkVx7', date: 'fldlWYq2vORwUSWyC',
  client: 'flduLQneOSHEAxOzV'
};

// Message envoye quand on recoit un vocal / une photo / un document.
// Volontairement bilingue : la plupart des clients marocains lisent les deux.
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

// --- [1] Identification du client -----------------------------------------
async function trouverClient(numeroDestinataire, cleSecours) {
  const num = digits(numeroDestinataire);

  if (num) {
    const formule = `FIND("${num}", SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({360dialog Phone}, " ", ""), "+", ""), "-", "")) > 0`;
    const q = await airtable(
      AIRTABLE_BASE + '/' + CLIENTS_TABLE +
      '?filterByFormula=' + encodeURIComponent(formule) + '&maxRecords=1'
    );
    if (q.records && q.records[0]) return q.records[0];
    console.error('Aucun client Airtable pour le numero destinataire ' + num);
  }

  if (cleSecours) {
    const q = await airtable(
      AIRTABLE_BASE + '/' + CLIENTS_TABLE +
      '?filterByFormula=' + encodeURIComponent(`{360dialog Channel Key}='${echapper(cleSecours)}'`) + '&maxRecords=1'
    );
    if (q.records && q.records[0]) return q.records[0];
  }

  return null;
}

// --- [4] Anti-doublon ------------------------------------------------------
// Si le champ "WA Message ID" n'existe pas encore dans Airtable, on continue
// sans dedoublonnage plutot que de bloquer la reponse au client.
async function dejaTraite(messageId) {
  if (!messageId) return false;
  try {
    const q = await airtable(
      AIRTABLE_BASE + '/' + LEADS_TABLE +
      '?filterByFormula=' + encodeURIComponent(`{WA Message ID}='${echapper(messageId)}'`) + '&maxRecords=1'
    );
    if (q.error) return false;
    return !!(q.records && q.records[0]);
  } catch (e) {
    return false;
  }
}

// --- [2] Memoire de conversation -------------------------------------------
// Toute erreur ici est sans consequence : on repond simplement sans historique.
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

async function envoyerWhatsApp(cle, destinataire, texte) {
  const r = await fetch('https://waba-v2.360dialog.io/messages', {
    method: 'POST',
    headers: { 'D360-API-KEY': cle, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destinataire,
      type: 'text',
      text: { body: texte }
    })
  });
  return r.ok;
}

// Si le champ "WA Message ID" n'existe pas, Airtable refuse tout
// l'enregistrement. On reessaie sans lui pour ne jamais perdre un lead.
async function creerLead(champs) {
  const res = await airtable(AIRTABLE_BASE + '/' + LEADS_TABLE, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: champs }], typecast: true })
  });
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

// --- EVENT 1 : un client vient de terminer l'inscription -------------------
async function handleChannelReady(payload) {
  const channel = payload.channels && payload.channels[0];
  if (!channel) return { skipped: 'no channel in payload' };

  const phoneClean = digits(channel.phone_number);
  const clientQuery = await airtable(
    AIRTABLE_BASE + '/' + CLIENTS_TABLE +
    '?filterByFormula=' + encodeURIComponent(`FIND("${phoneClean}", SUBSTITUTE({WhatsApp}, " ", "")) > 0`) +
    '&maxRecords=1'
  );
  const clientRec = clientQuery.records && clientQuery.records[0];
  if (!clientRec) {
    console.error('Aucun client Airtable ne correspond au numero ' + phoneClean);
    return { error: 'client not found for ' + phoneClean };
  }

  const fields = {};
  fields[CF.channelKey] = channel.api_key;
  fields[CF.phone] = channel.phone_number;

  await airtable(AIRTABLE_BASE + '/' + CLIENTS_TABLE + '/' + clientRec.id, {
    method: 'PATCH',
    body: JSON.stringify({ fields })
  });

  return { ok: true, client: clientRec.id, channel: channel.id };
}

// --- EVENT 2 : message WhatsApp entrant ------------------------------------
async function handleIncomingMessage(payload, cleSecours) {
  const entry = payload.entry && payload.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const msg = value && value.messages && value.messages[0];
  if (!msg) return { skipped: 'no message in payload' };

  if (await dejaTraite(msg.id)) return { skipped: 'doublon', id: msg.id };

  const fromPhone = msg.from;
  const telephone = String(fromPhone).startsWith('+') ? fromPhone : '+' + fromPhone;
  const text = (msg.text && msg.text.body) || '';
  const contactName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || 'Client WhatsApp';

  const numeroRecu = value.metadata && value.metadata.display_phone_number;
  const clientRec = await trouverClient(numeroRecu, cleSecours);
  if (!clientRec) return { error: 'client introuvable pour ' + (numeroRecu || 'numero inconnu') };

  const channelApiKey = clientRec.fields['360dialog Channel Key'];
  if (!channelApiKey) {
    console.error('Client ' + clientRec.id + ' sans cle 360dialog');
    return { error: 'cle 360dialog absente sur la fiche client' };
  }

  // --- [3] Message non textuel : on repond quand meme, et on alerte l'humain
  if (!text.trim()) {
    const type = msg.type || 'inconnu';
    const envoye = await envoyerWhatsApp(channelApiKey, fromPhone, REPONSE_NON_TEXTE);

    const champs = {};
    champs[LF.name] = contactName;
    champs[LF.phone] = telephone;
    champs[LF.message] = `[Message ${type} recu — non lisible par le systeme. A traiter manuellement.]`;
    champs[LF.score] = 'Warm';
    champs[LF.reply] = REPONSE_NON_TEXTE;
    champs[LF.status] = 'New';
    champs[LF.source] = 'WhatsApp';
    champs[LF.date] = new Date().toISOString().slice(0, 10);
    champs[LF.client] = [clientRec.id];
    champs['WA Message ID'] = msg.id;
    await creerLead(champs);

    return { ok: true, type, envoye, note: 'message non textuel, humain alerte' };
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

=== STYLE ===
WhatsApp, not email. Under 60 words. Natural, warm, human. No formal openings, no signature. Use their first name if known. Reference what they wrote. End with one clear question or a suggestion to arrange a time.

=== SCORING ===
Hot = clear need AND a specific budget or timeline. Warm = some details, key info missing. Cold = vague or just browsing.

Respond ONLY with raw JSON, no markdown, no backticks:
{"score":"Hot","budget":"value or Non precise","timeline":"value or Non precise","reply":"your reply"}`;

  // [2] Historique + message courant
  const messages = (await historique(telephone, clientRec.id)).concat([
    { role: 'user', content: 'Message recu de ' + contactName + ' :\n\n' + text }
  ]);

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, system: SYSTEM_PROMPT, messages })
  });
  const claudeData = await claudeRes.json();
  if (claudeData.error) return { error: 'claude: ' + claudeData.error.message };

  const raw = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = extractLastJson(raw) || { score: 'Warm', budget: 'Non precise', timeline: 'Non precise', reply: raw.replace(/```json/g, '').replace(/```/g, '').trim() };

  const envoye = await envoyerWhatsApp(channelApiKey, fromPhone, parsed.reply);

  const fields = {};
  fields[LF.name] = contactName;
  fields[LF.phone] = telephone;
  fields[LF.message] = text;
  fields[LF.score] = parsed.score;
  fields[LF.reply] = parsed.reply;
  fields[LF.status] = envoye ? 'Replied' : 'New';
  fields[LF.source] = 'WhatsApp';
  fields[LF.date] = new Date().toISOString().slice(0, 10);
  fields[LF.client] = [clientRec.id];
  fields['WA Message ID'] = msg.id;

  await creerLead(fields);

  return { ok: true, score: parsed.score, client: clientRec.id, envoye };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'Repondo 360dialog webhook' });

  const body = req.body || {};

  try {
    if (body.channels) {
      const result = await handleChannelReady(body);
      return res.status(200).json(result);
    }

    if (body.entry) {
      const cleSecours = req.headers['d360-api-key'] || (req.query && req.query.key) || null;
      const result = await handleIncomingMessage(body, cleSecours);
      return res.status(200).json(result);
    }

    return res.status(200).json({ skipped: 'unrecognized payload shape' });
  } catch (error) {
    console.error('360dialog webhook failed:', error);
    return res.status(200).json({ error: String(error) });
  }
}
