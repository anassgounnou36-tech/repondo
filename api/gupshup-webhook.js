// Webhook Gupshup pour WhatsApp — architecture "un App Gupshup par client".
// Gupshup n'envoie PAS le numero destinataire dans le payload entrant, seulement
// le nom de l'App ("app"). Chaque client a donc sa PROPRE App Gupshup, creee par
// vous, avec sa propre cle API et son propre numero WhatsApp. Le portefeuille
// (wallet) reste partage sur un seul compte, mais chaque WABA appartient a son
// propre Meta Business Portfolio cote client, comme pour les autres versions.
//
// Confirme depuis la documentation officielle Gupshup (docs.gupshup.io) :
//  - Payload entrant : { app, type:"message", payload:{ id, source, type, payload, sender:{phone,name} } }
//  - Envoi : POST https://api.gupshup.io/wa/api/v1/msg (form-urlencoded),
//    header apikey, champs source/destination/message/channel=whatsapp.
//  - Numero de test (proxy/sandbox) : +91 78348 11114 — utilisable sans WABA reelle.

const AIRTABLE_BASE = 'appJeJpHTfTIJakQ7';
const LEADS_TABLE = 'tbl59sHf4hsoE7FIp';
const CLIENTS_TABLE = 'tblYJSEz2VSRhNMHG';

const LF = {
  name: 'fldZ3Xokiao4CX8r1', email: 'fld3SglGSET6wOOFa', phone: 'fldJ7XXQouRocnJMW',
  message: 'fldRqW73Vv00ceWYV', score: 'fldjE9v3qH1UKFitN', reply: 'flde6zKt8Wjiys8YF',
  status: 'fldaKympBbspmKbMT', source: 'fldEipiRxFKTMkVx7', date: 'fldlWYq2vORwUSWyC',
  client: 'flduLQneOSHEAxOzV'
};

// Champs Clients pour ce modele (a creer a la main sur Airtable) :
//   "Gupshup App Name" — doit correspondre EXACTEMENT (casse comprise) au nom
//                         de l'App Gupshup du client
//   "Gupshup API Key"  — la cle API de cette App, visible dans son dashboard
//   "Gupshup Phone"    — le numero WhatsApp de ce client, sans le "+", ex: 212661234567

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

function versWhatsApp(t) {
  return String(t || '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '\u2022 ');
}

// --- Identification du client : par le nom de l'App Gupshup, pas un numero ---
async function trouverClient(nomApp) {
  if (!nomApp) return null;
  const formule = `{Gupshup App Name}='${echapper(nomApp)}'`;
  const q = await airtable(
    AIRTABLE_BASE + '/' + CLIENTS_TABLE +
    '?filterByFormula=' + encodeURIComponent(formule) + '&maxRecords=1'
  );
  if (q.records && q.records[0]) return q.records[0];
  console.error('Aucun client Airtable pour l\'App Gupshup "' + nomApp + '"');
  return null;
}

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

// Envoi via l'API Gupshup — la cle et le numero source sont ceux DU CLIENT.
async function envoyerWhatsApp(apiKey, appName, depuis, vers, texte) {
  const r = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
    method: 'POST',
    headers: {
      'apikey': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      channel: 'whatsapp',
      source: digits(depuis),
      destination: digits(vers),
      'src.name': appName,
      message: JSON.stringify({ type: 'text', text: texte })
    }).toString()
  });
  if (!r.ok) console.error('Envoi Gupshup echoue :', (await r.text()).slice(0, 300));
  return r.ok;
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'Repondo Gupshup webhook' });

  const body = req.body || {};

  try {
    // Gupshup envoie aussi des evenements de statut (delivered/read/failed) —
    // on ne traite que les vrais messages entrants.
    if (body.type !== 'message') {
      return res.status(200).json({ ok: true, skipped: body.type || 'unknown event' });
    }

    const p = body.payload || {};
    if (await dejaTraite(p.id)) return res.status(200).json({ skipped: 'doublon', id: p.id });

    const nomApp = body.app;
    const fromPhone = (p.sender && p.sender.phone) || p.source;
    const contactName = (p.sender && p.sender.name) || 'Client WhatsApp';
    const typeMsg = p.type;
    const text = typeMsg === 'text' ? ((p.payload && p.payload.text) || '') : '';

    const clientRec = await trouverClient(nomApp);
    if (!clientRec) return res.status(200).json({ error: 'client introuvable pour l\'App ' + nomApp });

    const apiKey = clientRec.fields['Gupshup API Key'];
    const sourcePhone = clientRec.fields['Gupshup Phone'];
    if (!apiKey || !sourcePhone) {
      console.error('Client ' + clientRec.id + ' sans identifiants Gupshup');
      return res.status(200).json({ error: 'identifiants Gupshup absents sur la fiche client' });
    }

    // --- Message non textuel (vocal, image, document, localisation) ---
    if (!text.trim()) {
      const envoye = await envoyerWhatsApp(apiKey, nomApp, sourcePhone, fromPhone, REPONSE_NON_TEXTE);

      const champs = {};
      champs[LF.name] = contactName;
      champs[LF.phone] = '+' + digits(fromPhone);
      champs[LF.message] = `[Message ${typeMsg || 'inconnu'} recu — non lisible par le systeme. A traiter manuellement.]`;
      champs[LF.score] = 'Warm';
      champs[LF.reply] = REPONSE_NON_TEXTE;
      champs[LF.status] = 'New';
      champs[LF.source] = 'WhatsApp';
      champs[LF.date] = new Date().toISOString().slice(0, 10);
      champs[LF.client] = [clientRec.id];
      champs['WA Message ID'] = p.id;
      await creerLead(champs);

      return res.status(200).json({ ok: true, type: typeMsg, envoye, note: 'message non textuel, humain alerte' });
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

    const messages = (await historique('+' + digits(fromPhone), clientRec.id)).concat([
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
      return res.status(200).json({ error: 'claude: ' + claudeData.error.message });
    }

    const raw = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = extractLastJson(raw) || { score: 'Warm', budget: 'Non precise', timeline: 'Non precise', reply: raw.replace(/```json/g, '').replace(/```/g, '').trim() };

    const replyPropre = versWhatsApp(parsed.reply);
    const envoye = await envoyerWhatsApp(apiKey, nomApp, sourcePhone, fromPhone, replyPropre);

    const fields = {};
    fields[LF.name] = contactName;
    fields[LF.phone] = '+' + digits(fromPhone);
    fields[LF.message] = text;
    fields[LF.score] = parsed.score;
    fields[LF.reply] = replyPropre;
    fields[LF.status] = envoye ? 'Replied' : 'New';
    fields[LF.source] = 'WhatsApp';
    fields[LF.date] = new Date().toISOString().slice(0, 10);
    fields[LF.client] = [clientRec.id];
    fields['WA Message ID'] = p.id;

    await creerLead(fields);

    return res.status(200).json({ ok: true, score: parsed.score, client: clientRec.id, envoye });
  } catch (error) {
    console.error('Gupshup webhook failed:', error);
    return res.status(200).json({ error: String(error) });
  }
}
