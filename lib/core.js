// Shared, side-effect-free logic used by the content script, the background
// service worker, the popup, and the Node tests. Loaded as a classic script in
// the extension (defines a global `JN`) and via require() in tests.

(function (root) {
  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'low',
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

  // ── Groups & friends ──
  // Stored as { groups: [{ id, name }], friends: [{ id, name, contact, groups: [groupId] }] }.
  // A friend can be in any number of groups; a friend in no group is never emailed.

  const MIGRATED_GROUP = { id: 'everyone', name: 'Everyone' };

  // Starting point on first install so the settings page isn't blank.
  const EXAMPLE_STORE = {
    groups: [{ id: 'software', name: 'Software' }, { id: 'cyber', name: 'Cyber' }],
    friends: [{ id: 'alex', name: 'Alex', contact: 'alex@example.com', groups: ['software'] }],
  };

  function newId(prefix = 'g') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim();
  }

  // Turns whatever is in storage into the current shape. Lists saved before
  // groups existed (friends with skills/interests and no `groups` key) move
  // into one "Everyone" group so nobody loses their list. Friends who had
  // "notify": false are kept but left out of every group. The migrated ids are
  // fixed, so every page that runs this gets the same result.
  function normalizeStore(data) {
    const rawFriends = Array.isArray(data?.friends) ? data.friends : null;
    const rawGroups = Array.isArray(data?.groups) ? data.groups : null;
    if (!rawFriends && !rawGroups) return JSON.parse(JSON.stringify(EXAMPLE_STORE));

    const legacy = !rawGroups;
    const groups = legacy
      ? (rawFriends.length ? [{ ...MIGRATED_GROUP }] : [])
      : rawGroups
          .filter(g => g && cleanName(g.name))
          .map((g, i) => ({ id: String(g.id || `group_${i}`), name: cleanName(g.name) }));
    const groupIds = new Set(groups.map(g => g.id));

    const friends = (rawFriends || [])
      .filter(f => f && cleanName(f.name))
      .map((f, i) => {
        const inGroups = legacy
          ? (f.notify === false ? [] : [MIGRATED_GROUP.id])
          : (Array.isArray(f.groups) ? f.groups.map(String) : []);
        return {
          id: String(f.id || `friend_${i}`),
          name: cleanName(f.name),
          contact: String(f.contact || '').trim(),
          groups: [...new Set(inGroups)].filter(id => groupIds.has(id)),
        };
      });

    return { groups, friends };
  }

  // Checks a store before saving. Returns an error message or null.
  function validateStore(store) {
    const seen = new Set();
    for (const g of store.groups) {
      if (!cleanName(g.name)) return 'Every group needs a name.';
      const key = cleanName(g.name).toLowerCase();
      if (seen.has(key)) return `There are two groups called "${cleanName(g.name)}".`;
      seen.add(key);
    }
    for (const f of store.friends) {
      if (!cleanName(f.name)) return 'Every friend needs a name.';
      if (f.contact && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(f.contact.trim())) {
        return `${cleanName(f.name)}: "${f.contact}" doesn't look like an email address.`;
      }
    }
    return null;
  }

  function groupMembers(store, groupId) {
    return store.friends.filter(f => f.groups.includes(groupId));
  }

  // Groups worth suggesting: the ones with at least one friend in them.
  function shareableGroups(store) {
    return store.groups.filter(g => groupMembers(store, g.id).length);
  }

  // All Claude sees: group names with a short numeric id. No friend data.
  function groupsForPrompt(store) {
    return shareableGroups(store).map((g, id) => ({ id, name: g.name }));
  }

  const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['job', 'group', 'message'],
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
      group: { type: 'integer' },
      message: { type: 'string' },
    },
  };

  function buildPrompt(jobText, groups) {
    return `You help someone share a job posting with a group of their friends.

1. Extract the job details: title, company, up to 6 key skills, level, location, and whether it's remote.
2. Set "group" to the id of the one group below that best fits this job, or -1 if none fits.
3. Write a short, casual message (2-3 sentences) from the user to friends who might want this job, saying who it would suit. Don't greet anyone by name and don't sign it.

<groups>${JSON.stringify(groups)}</groups>

<job_posting>
${jobText}
</job_posting>`;
  }

  // Models that accept server-side refusal fallbacks.
  function supportsFallbacks(model) {
    return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model || '');
  }

  function buildRequest(jobText, store, settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const body = {
      model: s.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildPrompt(jobText, groupsForPrompt(store)) }],
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

  // Turns an API response into what the share step needs: the job, one draft
  // message, the suggested group (or null), and every shareable group with its
  // members and their emails attached locally so the user can switch groups.
  function parseResponse(data, store) {
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

    const shareable = shareableGroups(store);
    const picked = Number.isInteger(parsed.group) ? shareable[parsed.group] : undefined;
    return {
      job: parsed.job || {},
      message: String(parsed.message || ''),
      suggestedGroupId: picked ? picked.id : null,
      groups: shareable.map(g => ({
        id: g.id,
        name: g.name,
        members: groupMembers(store, g.id).map(f => ({ name: f.name, contact: f.contact })),
      })),
    };
  }

  function emailSubject(job) {
    return job?.title && job?.company
      ? `Job opportunity: ${job.title} at ${job.company}`
      : 'Job opportunity';
  }

  // Optional recruiter contact the user pastes in the share step. Loose check:
  // any http(s) link on linkedin.com or a subdomain. Returns '' when blank,
  // null when it isn't a LinkedIn link, otherwise a cleaned https:// URL.
  // This stays in the browser: it is only added to the emails and copied text.
  function normalizeRecruiterUrl(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    u.protocol = 'https:';
    return u.href;
  }

  function recruiterLine(recruiterUrl) {
    return `Recruiter contact for this role: ${recruiterUrl}`;
  }

  function withRecruiter(message, recruiterUrl) {
    const text = message || '';
    return recruiterUrl ? `${text}\n\n${recruiterLine(recruiterUrl)}` : text;
  }

  // One email to everyone picked from the group. A single friend goes in To;
  // several go in Bcc so friends don't see each other's addresses.
  function groupMailtoUrl(members, job, message, recruiterUrl = '') {
    const emails = (members || []).map(m => m.contact).filter(Boolean).map(encodeURIComponent);
    const to = emails.length === 1 ? emails[0] : '';
    const bcc = emails.length > 1 ? `bcc=${emails.join(',')}&` : '';
    return `mailto:${to}?${bcc}subject=${encodeURIComponent(emailSubject(job))}` +
      `&body=${encodeURIComponent(withRecruiter(message, recruiterUrl))}`;
  }

  // Subject, recruiter link (if any) and message, for pasting anywhere.
  function shareText(job, message, recruiterUrl = '') {
    return `${emailSubject(job)}\n\n${withRecruiter(message, recruiterUrl)}`;
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const JN = {
    DEFAULT_SETTINGS, JOB_TTL_MS, MAX_JOB_TEXT, CONFIRMATION_PATTERNS, JOB_SIGNALS, RESULT_SCHEMA,
    MIGRATED_GROUP, EXAMPLE_STORE,
    normalizeText, isJobPage, isConfirmationText, hashText, isFresh,
    newId, cleanName, normalizeStore, validateStore, groupMembers, shareableGroups, groupsForPrompt,
    buildPrompt, supportsFallbacks, buildRequest, parseResponse,
    emailSubject, normalizeRecruiterUrl, withRecruiter, groupMailtoUrl, shareText, escHtml,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = JN;
  else root.JN = JN;
})(typeof globalThis !== 'undefined' ? globalThis : this);
