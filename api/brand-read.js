try {
  require('dotenv').config({ path: `${process.cwd()}/.env.local` });
} catch (_) {
  // dotenv is only needed for local development
}

const cheerio = require('cheerio');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function normalizeWhitespace(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  try {
    return new URL(trimmed).toString();
  } catch (_) {
    try {
      return new URL(`https://${trimmed}`).toString();
    } catch {
      return null;
    }
  }
}

function truncate(value, maxLength) {
  if (!value) return '';
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function inferVisualWorldHints(websiteContext = {}) {
  const combined = normalizeWhitespace([
    websiteContext.title,
    websiteContext.ogTitle,
    websiteContext.description,
    ...(websiteContext.headings || []),
    websiteContext.visibleText
  ].filter(Boolean).join(' ')).toLowerCase();

  const archetypeKeywords = {
    ruler: ['luxury', 'executive', 'leadership', 'exclusive', 'elite', 'premier', 'authority', 'command'],
    sage: ['insight', 'research', 'knowledge', 'intelligence', 'expertise', 'strategy', 'clarity', 'analysis'],
    magician: ['transform', 'transformation', 'alchemy', 'ritual', 'mystic', 'magic', 'healing', 'awakening'],
    creator: ['design', 'creative', 'studio', 'craft', 'innovation', 'build', 'create', 'original'],
    lover: ['beauty', 'sensual', 'romance', 'desire', 'fragrance', 'aesthetic', 'elegance', 'intimacy'],
    caregiver: ['care', 'support', 'wellness', 'healing', 'safe', 'comfort', 'nurture', 'help'],
    hero: ['performance', 'strength', 'power', 'challenge', 'train', 'win', 'endurance', 'bold', 'active', 'athlete'],
    rebel: ['disrupt', 'break', 'rebel', 'radical', 'defy', 'unconventional', 'rule-breaking', 'provocative'],
    explorer: ['discover', 'journey', 'adventure', 'explore', 'beyond', 'freedom', 'movement', 'travel', 'outdoor', 'horizon', 'cliff', 'mountain', 'trail', 'wild', 'escape', 'roam'],
    everyman: ['everyday', 'daily', 'simple', 'easy', 'for everyone', 'affordable', 'delivered', 'convenience', 'home', 'family', 'community', 'shop', 'grocery', 'retail'],
    innocent: ['pure', 'clean', 'natural', 'gentle', 'light', 'fresh', 'simple joy', 'goodness'],
    jester: ['play', 'fun', 'joy', 'humor', 'cheeky', 'witty', 'lighthearted', 'surprise']
  };

  const scores = Object.fromEntries(Object.keys(archetypeKeywords).map((key) => [key, 0]));

  for (const [world, keywords] of Object.entries(archetypeKeywords)) {
    for (const keyword of keywords) {
      if (combined.includes(keyword)) scores[world] += 1;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [topWorld, topScore] = ranked[0] || ['sage', 0];

  const explorerOutdoorBias = ['cliff', 'mountain', 'trail', 'horizon', 'outdoor', 'travel', 'journey', 'explore', 'adventure', 'escape', 'roam']
    .reduce((acc, keyword) => acc + (combined.includes(keyword) ? 1 : 0), 0);

  if (explorerOutdoorBias >= 2 && scores.explorer >= scores.hero) {
    topWorld = 'explorer';
    topScore = scores.explorer || explorerOutdoorBias;
  }

  return {
    suggestedWorld: topScore > 0 ? topWorld : 'sage',
    confidence: topScore,
    topSignals: ranked.filter(([, score]) => score > 0).slice(0, 3)
  };
}

async function fetchWebsiteContext(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Website fetch failed with status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    $('script, style, noscript, svg').remove();

    const title = normalizeWhitespace($('title').first().text());
    const description = normalizeWhitespace(
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      ''
    );
    const ogTitle = normalizeWhitespace($('meta[property="og:title"]').attr('content') || '');
    const headings = $('h1, h2, h3')
      .map((_, element) => normalizeWhitespace($(element).text()))
      .get()
      .filter(Boolean)
      .slice(0, 10);
    const bodyBlocks = $('p, li')
      .map((_, element) => normalizeWhitespace($(element).text()))
      .get()
      .filter((text) => text && text.length > 18)
      .slice(0, 24);

    const visibleText = truncate(bodyBlocks.join('\n'), 3500);

    return {
      title: truncate(title, 180),
      ogTitle: truncate(ogTitle, 180),
      description: truncate(description, 320),
      headings,
      visibleText
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractJson(text = '') {
  const cleaned = text.trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return valid JSON');
    return JSON.parse(match[0]);
  }
}

function normalizeResult(data, hints = null) {
  const visualWorlds = ['ruler', 'sage', 'magician', 'creator', 'lover', 'caregiver', 'hero', 'rebel', 'explorer', 'everyman', 'innocent', 'jester'];
  const rawWorld = String(data.visualWorld || '').toLowerCase();
  const modelWorld = visualWorlds.includes(rawWorld) ? rawWorld : 'sage';
  const forcedWorld = hints && hints.confidence >= 2 ? hints.suggestedWorld : null;
  const resolvedWorld = forcedWorld || modelWorld;

  return {
    brandName: truncate(normalizeWhitespace(data.brandName || ''), 64) || 'Your Brand',
    visualWorld: resolvedWorld,
    symbol: ['strategy', 'story', 'spectacle'].includes(data.symbol) ? data.symbol : 'strategy',
    title: truncate(normalizeWhitespace(data.title || ''), 64) || 'Untitled',
    genre: truncate(normalizeWhitespace(data.genre || ''), 34) || 'Brand Drama',
    tagline: truncate(normalizeWhitespace(data.tagline || ''), 92) || 'A brand in search of a sharper signal.',
    summary: truncate(normalizeWhitespace(data.summary || ''), 320) || 'The brand has a clear mood. Now the message needs to land with the same clarity.',
    current: truncate(normalizeWhitespace(data.current || ''), 900) || 'Right now, the brand looks considered and ambitious, but the offer is still not fully obvious on first glance.',
    strength: truncate(normalizeWhitespace(data.strength || ''), 760) || 'The strongest part is the mood. The brand already feels considered and visually self-aware.',
    gap: truncate(normalizeWhitespace(data.gap || ''), 900) || 'The look is doing one job and the message is doing another. They need to align more quickly.',
    mismatch: truncate(normalizeWhitespace(data.mismatch || ''), 760) || 'Some parts feel polished and confident, while others still feel softer or less sure of themselves.',
    voice: truncate(normalizeWhitespace(data.voice || ''), 900) || 'The tone should sound more confident, more direct, and more assured.',
    direction: truncate(normalizeWhitespace(data.direction || ''), 900) || 'Say the main promise faster, trim the fluff, and let one strong idea lead the whole brand.',
    amplify: truncate(normalizeWhitespace(data.amplify || ''), 760) || 'Amplify the parts that already feel distinct, clear, and memorable. That is where the brand feels strongest.',
    drop: truncate(normalizeWhitespace(data.drop || ''), 760) || 'Drop anything vague, padded, or over-explained. If it weakens the main impression, it should probably go.'
  };
}

async function generateBrandRead(url, websiteContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY');
  }

  const hints = inferVisualWorldHints(websiteContext);

  const prompt = `
You are SAHAR, a premium brand strategy and creative studio.

Your task is to read a website homepage and produce two layers:
1. A public-facing cinematic poster interpretation that feels aspirational, elegant, and shareable.
2. A deeper private strategic read that identifies the gap between image, message, and voice.

Important rules:
- Be specific, not generic.
- Sound premium, editorial, and intelligent.
- The audience is often founders, owners, or small business leaders, not brand strategists.
- Use plain English. Avoid brand theory jargon, consultant language, and abstract waffle.
- Never mention archetypes, brand frameworks, or specialist naming systems in the output.
- Sound lightly witty and observant, but still composed. Think elegant, not chatty.
- Short sentences are better than grand speeches.
- If you can say it simply, do that.
- Keep the poster layer concise and elegant.
- The public result should never embarrass the brand.
- The deeper report should feel substantial, specific, and readable, not like notes or bullet fragments.
- Do not mention AI, scraping, or missing data.
- Infer one dominant visual world from this set only:
  ruler, sage, magician, creator, lover, caregiver, hero, rebel, explorer, everyman, innocent, jester
- Treat convenience, mass retail, accessible daily-use, family-oriented, and service brands as more likely everyman or caregiver than magician.
- Only choose magician when the brand genuinely signals transformation, ritual, mystery, or symbolic change as a core story.
- Match symbol choice to the same logic:
  strategy = controlled, foundational, clear
  story = unfolding, exploratory, layered
  spectacle = reveal, threshold, dramatic impact
- Return ONLY valid JSON.

Website URL:
${url}

Extracted context:
- Title: ${websiteContext.title || 'n/a'}
- OG title: ${websiteContext.ogTitle || 'n/a'}
- Description: ${websiteContext.description || 'n/a'}
- Headings:
${websiteContext.headings.map((item) => `  - ${item}`).join('\n') || '  - n/a'}
- Visible text:
${websiteContext.visibleText || 'n/a'}

Likely dominant visual world based on lexical brand signals:
- Suggested world: ${hints.suggestedWorld}
- Confidence score: ${hints.confidence}
- Top signal worlds: ${hints.topSignals.map(([world, score]) => `${world}(${score})`).join(', ') || 'none'}

Choose one symbol only from: strategy, story, spectacle.

Return JSON with exactly these keys:
{
  "brandName": "brand name as it should appear on the poster",
  "visualWorld": "one of the allowed visual worlds",
  "symbol": "strategy | story | spectacle",
  "title": "poster title",
  "genre": "poster genre, ideally 2-4 words",
  "tagline": "short elegant tagline, ideally 6-12 words",
  "summary": "1-2 concise sentences in plain English",
  "current": "what the brand currently signals, 4-6 sentences",
  "strength": "what already feels strong or convincing, 3-5 sentences",
  "gap": "what is missing or unclear, 4-6 sentences",
  "mismatch": "where the brand feels slightly out of sync with itself, 3-5 sentences",
  "voice": "how the tone compares to the visual world, 4-6 sentences",
  "direction": "what to do next, 4-6 sentences",
  "amplify": "what to lean into more, 3-5 sentences",
  "drop": "what to reduce, simplify, or remove, 3-5 sentences"
}
`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json'
        }
      })
    }
  ).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';

  if (!text) {
    throw new Error('Gemini returned an empty response');
  }

  return normalizeResult(extractJson(text), hints);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const normalizedUrl = normalizeUrl(body.url);

    if (!normalizedUrl) {
      sendJson(res, 400, { error: 'Please enter a valid website URL.' });
      return;
    }

    const websiteContext = await fetchWebsiteContext(normalizedUrl);
    const result = await generateBrandRead(normalizedUrl, websiteContext);

    sendJson(res, 200, {
      ok: true,
      url: normalizedUrl,
      source: 'website',
      result
    });
  } catch (error) {
    sendJson(res, 500, {
      error: 'Unable to generate the brand read right now.',
      detail: error.message
    });
  }
};
