// Webhook unique 360dialog : gere 2 types d'evenements
// 1. Notification "channel ready" -> on enregistre la cle API du client
// 2. Message WhatsApp entrant -> on genere et envoie la reponse

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

// --- EVENT 1 : un client vient de terminer l'inscription (nouveau canal cree) ---
async function handleChannelReady(payload) {
  // Format Partner Webhook 360dialog: { waba_account: {...}, channels: [{ id, phone_number, api_key }] }
  const channel = payload.channels && payload.channels[0];
  if (!channel) return { skipped: 'no channel in payload' };

  // On cherche le client dont le numero correspond (a saisir manuellement dans Airtable au moment de l'envoi du lien)
  const phoneClean = (channel.phone_number || '').replace(/\D/g, '');
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

// --- EVENT 2 : message WhatsApp entrant d'un client final ---
async function handleIncomingMessage(payload, channelApiKey) {
  const entry = payload.entry && payload.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const msg = value && value.messages && value.messages[0];
  if (!msg) return { skipped: 'no message in payload' };

  const fromPhone = msg.from;
  const text = (msg.text && msg.text.body) || '';
  const contactName = (value.contacts && value.contacts[0] && value.contacts[0].profile && value.contacts[0].profile.name) || 'Client WhatsApp';

  if (!text.trim()) return { skipped: 'no text' };

  // Retrouver le client via la cle API du canal qui a recu ce message
  const clientQuery = await airtable(
    AIRTABLE_BASE + '/' + CLIENTS_TABLE +
    '?filterByFormula=' + encodeURIComponent(`{360dialog Channel Key}='${channelApiKey}'`) +
    '&maxRecords=1'
  );
  const clientRec = clientQuery.records && clientQuery.records[0];
  if (!clientRec) return { error: 'unknown channel key' };

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

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: 800, system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Message recu de ' + contactName + ' :\n\n' + text }]
    })
  });
  const claudeData = await claudeRes.json();
  if (claudeData.error) return { error: 'claude: ' + claudeData.error.message };

  const raw = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = extractLastJson(raw) || { score: 'Warm', budget: 'Non precise', timeline: 'Non precise', reply: raw.replace(/```json/g, '').replace(/```/g, '').trim() };

  // Envoi via l'API Cloud 360dialog (format Meta standard)
  await fetch('https://waba-v2.360dialog.io/messages', {
    method: 'POST',
    headers: { 'D360-API-KEY': channelApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: fromPhone,
      type: 'text',
      text: { body: parsed.reply }
    })
  });

  const fields = {};
  fields[LF.name] = contactName;
  fields[LF.phone] = fromPhone;
  fields[LF.message] = text;
  fields[LF.score] = parsed.score;
  fields[LF.reply] = parsed.reply;
  fields[LF.status] = 'Replied';
  fields[LF.source] = 'WhatsApp';
  fields[LF.date] = new Date().toISOString().slice(0, 10);
  fields[LF.client] = [clientRec.id];

  await airtable(AIRTABLE_BASE + '/' + LEADS_TABLE, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });

  return { ok: true, score: parsed.score, client: clientRec.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'Repondo 360dialog webhook' });

  const body = req.body || {};

  try {
    // Notification "nouveau canal" (Partner Webhook)
    if (body.channels) {
      const result = await handleChannelReady(body);
      return res.status(200).json(result);
    }

    // Message entrant (format Cloud API standard, avec la cle du canal en query param)
    const channelApiKey = req.headers['d360-api-key'] || req.query.key;
    if (body.entry && channelApiKey) {
      const result = await handleIncomingMessage(body, channelApiKey);
      return res.status(200).json(result);
    }

    return res.status(200).json({ skipped: 'unrecognized payload shape' });
  } catch (error) {
    console.error('360dialog webhook failed:', error);
    return res.status(200).json({ error: String(error) });
  }
}
