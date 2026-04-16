const MIN_CONTENT_LENGTH = 50;
const MAX_REQUEST_BYTES = 100000;
const REQUEST_TIMEOUT_MS = 15000;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8'
};

function createRequestId() {
  return crypto.randomUUID();
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function errorResponse(status, code, message, requestId) {
  return jsonResponse(
    {
      error: { code, message },
      requestId
    },
    status
  );
}

function logEvent(level, requestId, event, details = {}) {
  const payload = {
    level,
    event,
    requestId,
    ...details
  };

  console[level](JSON.stringify(payload));
}

function getContentTypeLabel(content) {
  return /<([a-z][\w-]*)(\s[^>]*)?>/i.test(content) ? 'html' : 'text';
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeWhitespace(text) {
  return decodeHtmlEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function buildFallbackChunks(content) {
  const normalized = normalizeWhitespace(content);

  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs.slice(0, 5).map((paragraph) => ({
      type: 'paragraph',
      content: truncate(paragraph, 300)
    }));
  }

  return [
    {
      type: 'paragraph',
      content: truncate(normalized, 300)
    }
  ];
}

function collectMatches(regex, input, mapper) {
  const results = [];
  for (const match of input.matchAll(regex)) {
    const value = mapper(match);
    if (value) {
      results.push(value);
    }
  }
  return results;
}

function extractFromHtml(content) {
  const chunks = [];
  const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : '';
  const h1 = h1Match ? stripTags(h1Match[1]) : '';

  if (title || h1) {
    chunks.push({
      type: 'primary_topic',
      content: normalizeWhitespace(`${title} ${h1}`)
    });
  }

  const headingMatches = Array.from(content.matchAll(/<(h[2-6])[^>]*>([\s\S]*?)<\/\1>/gi));
  headingMatches.forEach((match, index) => {
    const heading = stripTags(match[2]);
    const sectionStart = (match.index ?? 0) + match[0].length;
    const nextHeadingStart = headingMatches[index + 1]?.index ?? content.length;
    const sectionBody = stripTags(content.slice(sectionStart, nextHeadingStart));

    if (heading && sectionBody) {
      chunks.push({
        type: 'section',
        heading: truncate(heading, 120),
        content: truncate(sectionBody, 500)
      });
    }
  });

  collectMatches(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, content, (match) => {
    const items = collectMatches(/<li[^>]*>([\s\S]*?)<\/li>/gi, match[2], (liMatch) => {
      const text = stripTags(liMatch[1]);
      return text || null;
    }).slice(0, 8);

    if (items.length > 1 && chunks.filter((chunk) => chunk.type === 'list').length < 5) {
      chunks.push({
        type: 'list',
        content: truncate(items.join(' | '), 300)
      });
    }

    return null;
  });

  if (!chunks.some((chunk) => chunk.type === 'section')) {
    collectMatches(/<p[^>]*>([\s\S]*?)<\/p>/gi, content, (match) => {
      const paragraph = stripTags(match[1]);
      if (paragraph.length > 50 && chunks.filter((chunk) => chunk.type === 'paragraph').length < 5) {
        chunks.push({
          type: 'paragraph',
          content: truncate(paragraph, 300)
        });
      }
      return null;
    });
  }

  collectMatches(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, content, (match) => {
    try {
      const parsed = JSON.parse(match[1]);
      const schemaNodes = Array.isArray(parsed) ? parsed : [parsed];
      schemaNodes.forEach((node) => {
        if (node && typeof node === 'object' && node['@type']) {
          chunks.push({
            type: 'structured_data',
            content: truncate(`Type: ${node['@type']}, ${JSON.stringify(node)}`, 200)
          });
        }
      });
    } catch {
      return null;
    }

    return null;
  });

  return chunks;
}

function extractFromPlainText(content) {
  const chunks = [];
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingPatterns = [
    /^#{1,6}\s+(.+)$/,
    /^(.+):\s*$/,
    /^[A-Z][A-Z\s]+$/,
    /^\d+\.\s+(.+)$/
  ];

  let currentSection = null;
  let sectionContent = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let isHeading = false;
    let headingText = '';

    for (const pattern of headingPatterns) {
      const match = line.match(pattern);
      if (match) {
        isHeading = true;
        headingText = match[1] || match[0];
        break;
      }
    }

    if (index === 0 && line.length < 100 && !line.includes('.')) {
      chunks.push({
        type: 'primary_topic',
        content: line
      });
      continue;
    }

    if (isHeading) {
      if (currentSection && sectionContent.trim()) {
        chunks.push({
          type: 'section',
          heading: truncate(currentSection, 120),
          content: truncate(sectionContent.trim(), 500)
        });
      }
      currentSection = headingText;
      sectionContent = '';
    } else {
      sectionContent += `${line} `;
    }
  }

  if (currentSection && sectionContent.trim()) {
    chunks.push({
      type: 'section',
      heading: truncate(currentSection, 120),
      content: truncate(sectionContent.trim(), 500)
    });
  }

  if (chunks.length === 0) {
    const paragraphs = content.split(/\n\s*\n/).map((paragraph) => normalizeWhitespace(paragraph)).filter((paragraph) => paragraph.length > 50);
    paragraphs.slice(0, 5).forEach((paragraph) => {
      chunks.push({
        type: 'paragraph',
        content: truncate(paragraph, 300)
      });
    });
  }

  return chunks;
}

function extractSemanticChunksFromContent(content) {
  if (getContentTypeLabel(content) !== 'html') {
    const plainTextChunks = extractFromPlainText(content);
    return plainTextChunks.length > 0 ? plainTextChunks : buildFallbackChunks(content);
  }

  const htmlChunks = extractFromHtml(content);
  if (htmlChunks.length > 0) {
    return htmlChunks;
  }

  const strippedContent = stripTags(content);
  const strippedFallback = extractFromPlainText(strippedContent);

  if (strippedFallback.length > 0) {
    return strippedFallback;
  }

  const plainTextFallback = extractFromPlainText(content);
  if (plainTextFallback.length > 0) {
    return plainTextFallback;
  }

  return buildFallbackChunks(strippedContent || content);
}

function buildPrompt(content, chunks) {
  const contentExcerpt = content;
  const plainTextExcerpt = stripTags(content) || normalizeWhitespace(content);

  return `You are analyzing content for Google's AI Mode query fan-out potential. Google's AI Mode decomposes user queries into multiple sub-queries to synthesize comprehensive answers.

CONTENT ANALYSIS:
Content Length: ${content.length} characters
Content Type: ${getContentTypeLabel(content) === 'html' ? 'HTML/Markup' : 'Plain Text'}

ORIGINAL CONTENT EXCERPT:
${contentExcerpt}

NORMALIZED TEXT EXCERPT:
${plainTextExcerpt}

SEMANTIC CHUNKS EXTRACTED:
${JSON.stringify(chunks, null, 2)}

Based on this content, perform the following analysis:

1. IDENTIFY PRIMARY ENTITY: What is the main ontological entity or topic of this content?

2. PREDICT FAN-OUT QUERIES: Generate 8-10 likely sub-queries that Google's AI might create when a user asks about this topic. Consider:
   - Related queries (broader context)
   - Implicit queries (unstated user needs)
   - Comparative queries (alternatives, comparisons)
   - Procedural queries (how-to aspects)
   - Contextual refinements (budget, size, location specifics)

3. SEMANTIC COVERAGE SCORE: For each predicted query, assess if the content provides information to answer it (Yes/Partial/No).

4. FOLLOW-UP QUESTION POTENTIAL: What follow-up questions would users likely ask after reading this content?

OUTPUT FORMAT:
PRIMARY ENTITY: [entity name]

FAN-OUT QUERIES:
• [Query 1] - Coverage: [Yes/Partial/No]
• [Query 2] - Coverage: [Yes/Partial/No]
...

FOLLOW-UP POTENTIAL:
• [Follow-up question 1]
• [Follow-up question 2]
...

COVERAGE SCORE: [X/10 queries covered]
RECOMMENDATIONS: [Specific content gaps to fill]`;
}

function buildSummary(content, chunks) {
  const chunkCounts = chunks.reduce((counts, chunk) => {
    counts[chunk.type] = (counts[chunk.type] || 0) + 1;
    return counts;
  }, {});

  return {
    contentLength: content.length,
    contentType: getContentTypeLabel(content),
    chunkCounts,
    totalSemanticChunks: chunks.length
  };
}

async function parseRequestBody(request, requestId) {
  const contentLengthHeader = request.headers.get('content-length');
  const declaredLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : NaN;

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw { status: 413, code: 'INVALID_INPUT', message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes`, requestId };
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw { status: 400, code: 'INVALID_INPUT', message: 'Content-Type must be application/json', requestId };
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw { status: 400, code: 'INVALID_INPUT', message: 'Request body must be valid JSON', requestId };
  }

  const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
  if (!content) {
    throw { status: 400, code: 'INVALID_INPUT', message: 'Content is required', requestId };
  }

  if (content.length < MIN_CONTENT_LENGTH) {
    throw {
      status: 400,
      code: 'INVALID_INPUT',
      message: `Content must be at least ${MIN_CONTENT_LENGTH} characters`,
      requestId
    };
  }

  return content;
}

function validateOrigin(request, requestId) {
  const origin = request.headers.get('origin');
  if (!origin) {
    return null;
  }

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);

    if (originUrl.host !== requestUrl.host) {
      return errorResponse(403, 'FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed', requestId);
    }
  } catch {
    return errorResponse(403, 'FORBIDDEN_ORIGIN', 'Origin header is invalid', requestId);
  }

  return null;
}

async function callGemini(prompt, requestId) {
  if (!process.env.GEMINI_API_KEY) {
    logEvent('error', requestId, 'missing_gemini_key');
    return {
      ok: false,
      status: 500,
      message: 'Server is not configured with GEMINI_API_KEY'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          topK: 20,
          topP: 0.9,
          maxOutputTokens: 2048
        }
      }),
      signal: controller.signal
    });

    logEvent('info', requestId, 'gemini_response', { upstreamStatus: response.status });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: 'Gemini request failed'
      };
    }

    const data = await response.json();
    const analysis = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!analysis) {
      return {
        ok: false,
        status: 502,
        message: 'Gemini returned an unexpected response'
      };
    }

    return {
      ok: true,
      analysis
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        message: 'Gemini request timed out'
      };
    }

    logEvent('error', requestId, 'gemini_network_error', { error: error.message });
    return {
      ok: false,
      status: 502,
      message: 'Unable to reach Gemini'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAnalyze(request) {
  const requestId = createRequestId();
  logEvent('info', requestId, 'request_received', {
    method: request.method,
    path: new URL(request.url).pathname
  });

  const originError = validateOrigin(request, requestId);
  if (originError) {
    logEvent('warn', requestId, 'origin_rejected');
    return originError;
  }

  try {
    const content = await parseRequestBody(request, requestId);
    const chunks = extractSemanticChunksFromContent(content);
    const prompt = buildPrompt(content, chunks);
    const geminiResult = await callGemini(prompt, requestId);

    if (!geminiResult.ok) {
      return errorResponse(geminiResult.status || 502, 'UPSTREAM_ERROR', geminiResult.message, requestId);
    }

    return jsonResponse({
      analysis: geminiResult.analysis,
      summary: buildSummary(content, chunks),
      requestId
    });
  } catch (error) {
    if (error?.status && error?.code && error?.message) {
      return errorResponse(error.status, error.code, error.message, requestId);
    }

    logEvent('error', requestId, 'unexpected_error', { error: error?.message || 'Unknown error' });
    return errorResponse(500, 'UPSTREAM_ERROR', 'Unexpected server error', requestId);
  }
}

function methodNotAllowed() {
  const requestId = createRequestId();
  return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', requestId);
}

export async function POST(request) {
  return handleAnalyze(request);
}

export async function GET() {
  return methodNotAllowed();
}

export async function PUT() {
  return methodNotAllowed();
}

export async function PATCH() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}

export async function OPTIONS() {
  return methodNotAllowed();
}
