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

const FRIENDS = [
  { name: 'Alex', contact: 'alex@example.com', skills: ['Python'], interests: ['fintech'], level: 'internship' },
  { name: 'Sam', contact: 'sam@example.com', skills: ['Go'], notify: false },
  { name: 'Riley', contact: 'riley@example.com', skills: ['React'] },
];

test('prompt friends exclude contacts and opted-out friends', () => {
  const pf = JN.friendsForPrompt(FRIENDS);
  assert.deepEqual(pf.map(f => f.name), ['Alex', 'Riley']);
  assert.deepEqual(pf.map(f => f.id), [0, 1]);
  assert.ok(pf.every(f => !('contact' in f)));
  const req = JN.buildRequest('job text', FRIENDS, { apiKey: 'sk-ant-test' });
  assert.ok(!JSON.stringify(req.body).includes('@example.com'));
});

test('buildRequest uses structured output and fallbacks on supported models', () => {
  const req = JN.buildRequest('job', FRIENDS, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');

  const haiku = JN.buildRequest('job', FRIENDS, { apiKey: 'k', model: 'claude-haiku-5-5' });
  assert.equal(haiku.body.fallbacks, undefined);
  assert.equal(haiku.headers['anthropic-beta'], undefined);
});

function apiResponse(obj, extra = {}) {
  return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }], ...extra };
}

test('parseResponse maps ids back to friends with contacts, sorted by score', () => {
  const out = JN.parseResponse(apiResponse({
    job: { title: 'Intern', company: 'Acme', skills: [], level: '', location: '', remote: false },
    matches: [
      { id: 1, score: 0.7, message: 'Hey Riley' },
      { id: 0, score: 0.9, message: 'Hey Alex' },
      { id: 0, score: 0.95, message: 'duplicate' },
      { id: 7, score: 0.9, message: 'unknown id' },
      { id: 1, score: 0.2, message: 'below threshold' },
    ],
  }), FRIENDS, 0.6);
  assert.deepEqual(out.matches.map(m => [m.name, m.contact]), [['Alex', 'alex@example.com'], ['Riley', 'riley@example.com']]);
  assert.equal(out.job.company, 'Acme');
});

test('parseResponse surfaces refusals, truncation and bad JSON', () => {
  assert.throws(() => JN.parseResponse({ stop_reason: 'refusal', content: [] }, FRIENDS), /declined/);
  assert.throws(() => JN.parseResponse({ stop_reason: 'max_tokens', content: [] }, FRIENDS), /cut off/);
  assert.throws(() => JN.parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{oops' }] }, FRIENDS), /malformed/);
});

test('validateFriends catches common mistakes', () => {
  assert.equal(JN.validateFriends(FRIENDS), null);
  assert.match(JN.validateFriends({}), /array/);
  assert.match(JN.validateFriends([{ skills: [] }]), /name/);
  assert.match(JN.validateFriends([{ name: 'A', skills: 'Python' }]), /skills/);
});

test('mailto and combined messages encode correctly', () => {
  const job = { title: 'Intern', company: 'Acme & Co' };
  const url = JN.mailtoUrl({ contact: 'a@b.com', message: 'Hi there' }, job);
  assert.equal(url, 'mailto:a%40b.com?subject=Job%20opportunity%3A%20Intern%20at%20Acme%20%26%20Co&body=Hi%20there');
  const combined = JN.combinedMessages([{ name: 'Alex', contact: 'a@b.com', message: 'Hi' }], job);
  assert.match(combined, /To Alex <a@b.com>:\nHi/);
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

test('recruiter link is added to emails and copied text only when given', () => {
  const job = { title: 'Intern', company: 'Acme' };
  const match = { name: 'Alex', contact: 'a@b.com', message: 'Hi' };
  const rec = 'https://www.linkedin.com/in/jane/';

  assert.equal(JN.mailtoUrl(match, job, ''), JN.mailtoUrl(match, job));
  assert.equal(JN.combinedMessages([match], job, ''), JN.combinedMessages([match], job));
  assert.equal(JN.withRecruiter('Hi', ''), 'Hi');

  const body = decodeURIComponent(JN.mailtoUrl(match, job, rec).split('&body=')[1]);
  assert.equal(body, `Hi\n\nRecruiter contact for this role: ${rec}`);

  const combined = JN.combinedMessages([match, { name: 'Riley', message: 'Yo' }], job, rec);
  assert.equal(combined.split(rec).length - 1, 1, 'link appears once');
  assert.match(combined, /^Job opportunity: Intern at Acme\nRecruiter contact for this role: /);
});
