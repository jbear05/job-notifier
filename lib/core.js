// Shared, side-effect-free logic used by the content script, the background
// service worker, the popup, and the Node tests. Loaded as a classic script in
// the extension (defines a global `JN`) and via require() in tests.

(function (root) {
  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'low',
    threshold: 0.6,
    autoDetect: true,
  };

  // How long a job posting you viewed stays eligible for a confirmation page.
  const JOB_TTL_MS = 30 * 60 * 1000;
  const MAX_JOB_TEXT = 8000;

  // Confirmation phrases. These are only checked against text that is actually
  // visible on screen, and only fire if a job posting was seen recently.
  const CONFIRMATION_PATTERNS = [
    /\bapplication\s+(has\s+been\s+)?(submitted|received|sent)\b/i,
    /\bthanks?\s+(you\s+)?for\s+(your\s+)?appl(ying|ication)\b/i,
    /\bsuccessfully\s+(applied|submitted)\b/i,
    /\byour\s+application\s+(is|was)\s+(complete|submitted|sent|received)\b/i,
    /\bwe(\s+have|'ve)?\s+received\s+your\s+application\b/i,
    /\byou'?ve\s+(now\s+|successfully\s+)?applied\b/i,
  ];

  const JOB_SIGNALS = [
    /\b(responsibilities|qualifications|requirements|about the role|what you'?ll do)\b/i,
    /\b(salary|compensation|benefits|equity|pay range)\b/i,
    /\b(full.?time|part.?time|contract|internship|remote|hybrid|on.?site)\b/i,
    /\b(\d+\+?\s+years|experience with|proficien(t|cy)|familiarity with)\b/i,
    /\b(apply now|easy apply|submit application|apply for this (job|position|role))\b/i,
  ];

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // A job posting needs a decent amount of text and at least 3 distinct signals.
  function isJobPage(text) {
    if (!text || text.length < 400) return false;
    return JOB_SIGNALS.filter(re => re.test(text)).length >= 3;
  }

  function isConfirmationText(text) {
    if (!text) return false;
    return CONFIRMATION_PATTERNS.some(re => re.test(text));
  }

  // Cheap stable hash (FNV-1a) so we never analyze the same posting twice.
  function hashText(text) {
    let h = 0x811c9dc5;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function isFresh(entry, now = Date.now()) {
    return !!(entry && entry.text && now - entry.seenAt <= JOB_TTL_MS);
  }

  // Validates a friends list pasted into the options page.
  function validateFriends(list) {
    if (!Array.isArray(list)) return 'Friends must be a JSON array.';
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f || typeof f !== 'object') return `Entry ${i + 1} is not an object.`;
      if (!f.name || typeof f.name !== 'string') return `Entry ${i + 1} needs a "name".`;
      if (f.skills && !Array.isArray(f.skills)) return `${f.name}: "skills" must be a list.`;
      if (f.interests && !Array.isArray(f.interests)) return `${f.name}: "interests" must be a list.`;
    }
    return null;
  }

  function activeFriends(friends) {
    return (friends || []).filter(f => f && f.notify !== false);
  }

  // What Claude sees about each friend. Contact details never leave the browser.
  function friendsForPrompt(friends) {
    return activeFriends(friends).map((f, id) => ({
      id,
      name: f.name,
      skills: f.skills || [],
      interests: f.interests || [],
      level: f.level || '',
    }));
  }

  const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['job', 'matches'],
    properties: {
      job: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'company', 'skills', 'level', 'location', 'remote'],
        properties: {
          title: { type: 'string' },
          company: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
          level: { type: 'string' },
          location: { type: 'string' },
          remote: { type: 'boolean' },
        },
      },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'score', 'message'],
          properties: {
            id: { type: 'integer' },
            score: { type: 'number' },
            message: { type: 'string' },
          },
        },
      },
    },
  };

  function buildPrompt(jobText, friends, threshold) {
    return `You help someone tell their friends about jobs they might want.

Given the job posting below and a list of friends:
1. Extract the job details (title, company, key skills, level, location, whether it's remote).
2. Score how well the job fits each friend from 0.0 to 1.0, based on their skills, interests, and level.
3. For every friend scoring ${threshold} or higher, write a short, casual message (2–3 sentences) from the user to that friend. Mention specifically why it fits them. Do not sign the message.

Only include friends scoring ${threshold} or higher in "matches". Use each friend's "id" exactly as given.

<friends>
${JSON.stringify(friends, null, 2)}
</friends>

<job_posting>
${jobText}
</job_posting>`;
  }

  // Models that accept server-side refusal fallbacks.
  function supportsFallbacks(model) {
    return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model || '');
  }

  function buildRequest(jobText, friends, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const body = {
      model: s.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: buildPrompt(jobText, friendsForPrompt(friends), s.threshold) }],
      output_config: {
        format: { type: 'json_schema', schema: RESULT_SCHEMA },
        ...(s.effort ? { effort: s.effort } : {}),
      },
    };
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (supportsFallbacks(s.model)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }
    return { url: 'https://api.anthropic.com/v1/messages', headers, body };
  }

  // Turns an API response into { job, matches[] } with friend contacts attached.
  function parseResponse(data, friends, threshold = DEFAULT_SETTINGS.threshold) {
    if (data?.stop_reason === 'refusal') throw new Error('Claude declined to analyze this page.');
    if (data?.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again.');
    const textBlock = (data?.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('Empty response from Claude.');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (e) {
      throw new Error('Claude returned malformed JSON.');
    }

    const active = activeFriends(friends);
    const seen = new Set();
    const matches = [];
    for (const m of parsed.matches || []) {
      if (!Number.isInteger(m.id) || !active[m.id] || seen.has(m.id) || !(m.score >= threshold)) continue;
      seen.add(m.id);
      const f = active[m.id];
      matches.push({ name: f.name, contact: f.contact || '', score: m.score, message: m.message || '' });
    }
    matches.sort((a, b) => b.score - a.score);

    return { job: parsed.job || {}, matches };
  }

  function emailSubject(job) {
    return job?.title && job?.company
      ? `Job opportunity: ${job.title} at ${job.company}`
      : 'Job opportunity';
  }

  function mailtoUrl(match, job) {
    return `mailto:${encodeURIComponent(match.contact || '')}` +
      `?subject=${encodeURIComponent(emailSubject(job))}` +
      `&body=${encodeURIComponent(match.message || '')}`;
  }

  // One block of text with every selected message, for pasting anywhere.
  function combinedMessages(matches, job) {
    const header = emailSubject(job);
    return [header, ...matches.map(m => `To ${m.name}${m.contact ? ` <${m.contact}>` : ''}:\n${m.message}`)]
      .join('\n\n');
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const JN = {
    DEFAULT_SETTINGS, JOB_TTL_MS, MAX_JOB_TEXT, CONFIRMATION_PATTERNS, JOB_SIGNALS, RESULT_SCHEMA,
    normalizeText, isJobPage, isConfirmationText, hashText, isFresh, validateFriends,
    activeFriends, friendsForPrompt, buildPrompt, supportsFallbacks, buildRequest, parseResponse,
    emailSubject, mailtoUrl, combinedMessages, escHtml,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JN;
  else root.JN = JN;
})(typeof globalThis !== 'undefined' ? globalThis : this);
