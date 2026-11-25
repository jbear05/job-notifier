const test = require('node:test');
const assert = require('node:assert/strict');
const JN = require('../lib/core.js');

const JOB_POSTING = `
  Software Engineering Intern, Payments. About the role: you'll build REST APIs in Python.
  Responsibilities include designing backend services and working with the product team.
  Qualifications: experience with Python or Go, familiarity with React. This is a full-time
  summer internship, hybrid in New York. Compensation: $45/hour plus benefits. Apply now to join us.
`.repeat(2);

test('recognizes a real job posting', () => {
  assert.equal(JN.isJobPage(JN.normalizeText(JOB_POSTING)), true);
});

test('does not treat ordinary pages as job postings', () => {
  const article = 'Our company had a great year. We released new features and our team grew. '.repeat(10);
  assert.equal(JN.isJobPage(article), false);
  assert.equal(JN.isJobPage('Short page'), false);
});

test('detects common confirmation messages', () => {
  for (const text of [
    'Application submitted',
    'Thank you for applying to Acme!',
    'Thanks for your application',
    'Your application has been received.',
    "We've received your application",
    "You've successfully applied",
    'Application sent',
  ]) {
    assert.equal(JN.isConfirmationText(text), true, text);
  }
});

test('ignores text that only mentions applications', () => {
  for (const text of [
    'Submit application',
    'How to write a great application',
    'Applications close Friday',
    'Easy Apply',
    'Applied 3 days ago',
  ]) {
    assert.equal(JN.isConfirmationText(text), false, text);
  }
});

test('hashText is stable and distinguishes inputs', () => {
  assert.equal(JN.hashText('abc'), JN.hashText('abc'));
  assert.notEqual(JN.hashText('abc'), JN.hashText('abd'));
});

test('isFresh respects the TTL', () => {
  const now = Date.now();
  assert.equal(JN.isFresh({ text: 'x', seenAt: now - 1000 }, now), true);
  assert.equal(JN.isFresh({ text: 'x', seenAt: now - JN.JOB_TTL_MS - 1 }, now), false);
  assert.equal(JN.isFresh(null, now), false);
});

const STORE = {
  groups: [{ id: 'sw', name: 'Software' }, { id: 'empty', name: 'Law' }, { id: 'cy', name: 'Cyber' }],
  friends: [
    { id: 'a', name: 'Alex', contact: 'alex@example.com', groups: ['sw'] },
    { id: 'r', name: 'Riley', contact: 'riley@example.com', groups: ['sw', 'cy'] },
    { id: 'n', name: 'Noemail', contact: '', groups: ['cy'] },
  ],
};

test('legacy friends lists migrate into an Everyone group', () => {
  const legacy = {
    friends: [
      { name: 'Alex', contact: 'alex@example.com', skills: ['Python'], interests: ['fintech'], level: 'internship' },
      { name: 'Sam', contact: 'sam@example.com', notify: false },
      { name: '  ' },
    ],
  };
  const out = JN.normalizeStore(legacy);
  assert.deepEqual(out.groups, [{ id: 'everyone', name: 'Everyone' }]);
  assert.deepEqual(out.friends.map(f => [f.name, f.contact, f.groups]), [
    ['Alex', 'alex@example.com', ['everyone']],
    ['Sam', 'sam@example.com', []],
  ]);
  assert.ok(!('skills' in out.friends[0]));
  // Deterministic, so the options page and background agree.
  assert.deepEqual(JN.normalizeStore(legacy), out);
  // Already migrated data is left alone.
  assert.deepEqual(JN.normalizeStore(out), out);
});

test('normalizeStore handles first run, empty lists and stale group ids', () => {
  assert.deepEqual(JN.normalizeStore({}), JN.EXAMPLE_STORE);
  assert.deepEqual(JN.normalizeStore({ friends: [] }), { groups: [], friends: [] });
  const out = JN.normalizeStore({
    groups: [{ id: 'sw', name: ' Software ' }, { id: 'x', name: '' }],
    friends: [{ id: 'a', name: 'Alex', groups: ['sw', 'gone', 'sw'] }],
  });
  assert.deepEqual(out.groups, [{ id: 'sw', name: 'Software' }]);
  assert.deepEqual(out.friends[0].groups, ['sw']);
});

test('validateStore catches common mistakes', () => {
  assert.equal(JN.validateStore(STORE), null);
  assert.match(JN.validateStore({ groups: [{ id: 'a', name: 'X' }, { id: 'b', name: 'x' }], friends: [] }), /two groups/);
  assert.match(JN.validateStore({ groups: [{ id: 'a', name: ' ' }], friends: [] }), /name/);
  assert.match(JN.validateStore({ groups: [], friends: [{ name: '' }] }), /name/);
  assert.match(JN.validateStore({ groups: [], friends: [{ name: 'A', contact: 'not-an-email' }] }), /email/);
});

test('Claude only sees non-empty group names, never friend data', () => {
  assert.deepEqual(JN.groupsForPrompt(STORE), [{ id: 0, name: 'Software' }, { id: 1, name: 'Cyber' }]);
  const req = JN.buildRequest('job text', STORE, { apiKey: 'sk-ant-test' });
  const sent = JSON.stringify(req.body);
  for (const secret of ['@example.com', 'Alex', 'Riley', 'Law']) assert.ok(!sent.includes(secret), secret);
  assert.ok(sent.includes('Software') && sent.includes('Cyber'));
});

test('buildRequest uses structured output and fallbacks on supported models', () => {
  const req = JN.buildRequest('job', STORE, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.deepEqual(req.body.output_config.format.schema.required, ['job', 'group', 'message']);
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');

  const haiku = JN.buildRequest('job', STORE, { apiKey: 'k', model: 'claude-haiku-5-5' });
  assert.equal(haiku.body.fallbacks, undefined);
  assert.equal(haiku.headers['anthropic-beta'], undefined);
});

function apiResponse(obj, extra = {}) {
  return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }], ...extra };
}

const JOB = { title: 'Intern', company: 'Acme', skills: [], level: '', location: '', remote: false };

test('parseResponse maps the group back and attaches members locally', () => {
  const out = JN.parseResponse(apiResponse({ job: JOB, group: 1, message: 'Hey all' }), STORE);
  assert.equal(out.suggestedGroupId, 'cy');
  assert.equal(out.message, 'Hey all');
  assert.equal(out.job.company, 'Acme');
  assert.deepEqual(out.groups.map(g => g.id), ['sw', 'cy']);
  assert.deepEqual(out.groups[0].members, [
    { name: 'Alex', contact: 'alex@example.com' },
    { name: 'Riley', contact: 'riley@example.com' },
  ]);
});

test('parseResponse treats -1 or unknown ids as no suggestion', () => {
  for (const group of [-1, 2, 99]) {
    const out = JN.parseResponse(apiResponse({ job: JOB, group, message: 'x' }), STORE);
    assert.equal(out.suggestedGroupId, null, String(group));
    assert.equal(out.groups.length, 2);
  }
});

test('parseResponse surfaces refusals, truncation and bad JSON', () => {
  assert.throws(() => JN.parseResponse({ stop_reason: 'refusal', content: [] }, STORE), /declined/);
  assert.throws(() => JN.parseResponse({ stop_reason: 'max_tokens', content: [] }, STORE), /cut off/);
  assert.throws(() => JN.parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{oops' }] }, STORE), /malformed/);
});

test('group mailto uses To for one friend and Bcc for several', () => {
  const job = { title: 'Intern', company: 'Acme & Co' };
  const one = JN.groupMailtoUrl([{ contact: 'a@b.com' }], job, 'Hi there');
  assert.equal(one, 'mailto:a%40b.com?subject=Job%20opportunity%3A%20Intern%20at%20Acme%20%26%20Co&body=Hi%20there');
  const many = JN.groupMailtoUrl([{ contact: 'a@b.com' }, { contact: '' }, { contact: 'c@d.com' }], job, 'Hi');
  assert.ok(many.startsWith('mailto:?bcc=a%40b.com,c%40d.com&subject='));
  assert.equal(JN.shareText(job, 'Hi'), 'Job opportunity: Intern at Acme & Co\n\nHi');
});

test('escHtml escapes markup', () => {
  assert.equal(JN.escHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('normalizeRecruiterUrl accepts LinkedIn links loosely and rejects others', () => {
  assert.equal(JN.normalizeRecruiterUrl(''), '');
  assert.equal(JN.normalizeRecruiterUrl('   '), '');
  assert.equal(JN.normalizeRecruiterUrl('https://www.linkedin.com/in/jane-doe/'), 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(JN.normalizeRecruiterUrl('  linkedin.com/in/jane '), 'https://linkedin.com/in/jane');
  assert.equal(JN.normalizeRecruiterUrl('http://uk.linkedin.com/in/jane'), 'https://uk.linkedin.com/in/jane');
  assert.equal(JN.normalizeRecruiterUrl('https://www.LinkedIn.com/in/jane'), 'https://www.linkedin.com/in/jane');
  for (const bad of [
    'jane@example.com',
    'https://example.com/in/jane',
    'https://linkedin.com.evil.com/in/jane',
    'https://notlinkedin.com/in/jane',
    'javascript:alert(1)',
    'https://user:pw@linkedin.com/in/jane',
    'not a url at all',
  ]) {
    assert.equal(JN.normalizeRecruiterUrl(bad), null, bad);
  }
});

test('recruiter link is added to the email and copied text only when given', () => {
  const job = { title: 'Intern', company: 'Acme' };
  const members = [{ name: 'Alex', contact: 'a@b.com' }];
  const rec = 'https://www.linkedin.com/in/jane/';

  assert.equal(JN.groupMailtoUrl(members, job, 'Hi', ''), JN.groupMailtoUrl(members, job, 'Hi'));
  assert.equal(JN.shareText(job, 'Hi', ''), JN.shareText(job, 'Hi'));
  assert.equal(JN.withRecruiter('Hi', ''), 'Hi');

  const body = decodeURIComponent(JN.groupMailtoUrl(members, job, 'Hi', rec).split('&body=')[1]);
  assert.equal(body, `Hi\n\nRecruiter contact for this role: ${rec}`);
  assert.equal(JN.shareText(job, 'Hi', rec), `Job opportunity: Intern at Acme\n\nHi\n\nRecruiter contact for this role: ${rec}`);
});
