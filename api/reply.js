export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history, niche } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'CLE_API_MANQUANTE' });

  const NICHE_PROMPTS = {
    immobilier: { business: 'a real estate agency in Morocco', context: 'Properties, rentals, sales, viewings, neighbourhoods, budgets in MAD.', neverInvent: 'listings, property prices, commission rates, or availability' },
    dentaire: { business: 'a dental clinic in Morocco', context: 'Appointments, treatments, dental emergencies, consultations, implants, orthodontics, whitening.', neverInvent: 'prices, treatment costs, specific appointment slots, or medical diagnoses' },
    voyage: { business: 'a travel agency in Morocco', context: 'Flights, hotels, organised tours, Umrah and Hajj packages, visas, group travel.', neverInvent: 'prices, seat availability, hotel availability, or visa approval outcomes' }
  };
  const config = NICHE_PROMPTS[niche] || NICHE_PROMPTS.immobilier;
  const MEDICAL_NOTE = niche === 'dentaire' ? '\n\n=== MEDICAL SAFETY ===\nNever give medical advice, diagnosis, or treatment recommendations. If someone describes pain or a dental emergency, express care, treat it as urgent, and direct them to contact the clinic directly or come in as soon as possible. Do not suggest remedies or medication.' : '';

  const SYSTEM_PROMPT = `You are an assistant for ${config.business}.
Context: ${config.context}

=== OUTPUT FORMAT - ABSOLUTE RULE ===
Your ENTIRE response must be exactly ONE JSON object and nothing else. No commentary. No markdown. No backticks. NEVER write a JSON object then correct yourself. Decide the language first, think internally, output ONE final JSON object.

=== LANGUAGE RULE ===
Reply in EXACTLY the same language AND script the client used.
- English -> reply entirely in English. Never French.
- French -> reply entirely in French.
- Darija in LATIN letters -> reply ONLY in Latin letters, using 3, 7, 9 for Arabic sounds. NEVER a single Arabic script character.
- Arabic script -> reply entirely in Arabic script.
- Spanish -> reply in Spanish.
Mixing scripts is forbidden.

=== HONESTY RULE ===
NEVER invent facts. No access to ${config.neverInvent}. If asked, say you will verify and come back.${MEDICAL_NOTE}

=== BOOKING ===
When the client shows real interest and has given enough info, propose an appointment. Set proposeBooking true and suggest 2 concrete time slots in the client's language and script. Otherwise false, suggestedSlots empty.

=== SCORING ===
Hot = clear need AND urgency or specific timeline. Warm = partial details. Cold = vague or just browsing.

=== STYLE ===
Warm, professional, under 100 words. Use their first name if given. Reference their specific details. Ask one clarifying question if info is missing.

Output this exact shape and nothing else:
{"score":"Hot","budget":"value or Not specified","timeline":"value or Not specified","proposeBooking":false,"suggestedSlots":[],"reply":"your reply"}`;

  const messages = [];
  if (history && Array.isArray(history)) for (const turn of history) messages.push({ role: turn.role, content: turn.content });
  messages.push({ role: 'user', content: message });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: SYSTEM_PROMPT, messages })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

    function extractLastJson(text) {
      var results = [], depth = 0, start = -1;
      for (var i = 0; i < text.length; i++) {
        if (text[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (text[i] === '}') { depth--; if (depth === 0 && start !== -1) { results.push(text.slice(start, i + 1)); start = -1; } }
      }
      for (var j = results.length - 1; j >= 0; j--) { try { return JSON.parse(results[j]); } catch (e) {} }
      return null;
    }

    const parsed = extractLastJson(raw);
    if (!parsed || !parsed.reply) {
      const fallback = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      return res.status(200).json({ score: 'Warm', budget: 'Non precise', timeline: 'Non precise', proposeBooking: false, suggestedSlots: [], reply: fallback });
    }
    return res.status(200).json({
      score: parsed.score || 'Warm', budget: parsed.budget || 'Non precise', timeline: parsed.timeline || 'Non precise',
      proposeBooking: parsed.proposeBooking === true, suggestedSlots: Array.isArray(parsed.suggestedSlots) ? parsed.suggestedSlots : [], reply: parsed.reply
    });
  } catch (error) {
    console.error('Request failed:', error);
    return res.status(500).json({ error: 'Request failed' });
  }
}

