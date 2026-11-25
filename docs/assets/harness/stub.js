// A stand-in for the chrome.* APIs, so the real popup.html, options.html, and
// overlay.html render with their own scripts and styles outside the extension.
// render.js injects it into every frame before page scripts run, prefixed with
// `window.__shot = { state }`. Demo data is fictional (spec Design: Store assets).
(function () {
  const page = location.pathname.split('/').pop();
  if (!['popup.html', 'options.html', 'overlay.html'].includes(page)) return;
  const S = (window.__shot || {}).state || '';

  // Sync file:// reads need Chrome's --allow-file-access-from-files (render.js passes it).
  const read = rel => {
    const x = new XMLHttpRequest();
    x.open('GET', rel, false);
    x.send();
    return x.responseText;
  };

  const POSTING_URL = 'http://kestrel-grid.localhost:8080/jobs/data-engineering-intern';
  const FRIENDS = [
    { name: 'Priya Shah', contact: 'priya.shah@example.com', skills: ['Go', 'PostgreSQL', 'distributed systems'], interests: ['climate', 'infrastructure'], level: 'Mid level', notify: true },
    { name: 'Marcus Lee', contact: 'marcus.lee@example.com', skills: ['Python', 'SQL', 'data pipelines'], interests: ['analytics', 'sports'], level: 'New grad', notify: true },
    { name: 'Dana Okafor', contact: 'dana.okafor@example.com', skills: ['React', 'TypeScript', 'design systems'], interests: ['education', 'accessibility'], level: 'Senior', notify: true },
  ];
  const JOB = { title: 'Data Engineering Intern', company: 'Kestrel Grid', level: 'Internship', location: 'Remote, United States', remote: true, skills: ['Python', 'SQL', 'Airflow', 'Data pipelines'] };
  const MATCHES = [
    { name: 'Marcus Lee', contact: 'marcus.lee@example.com', score: 0.86, message: "Hi Marcus, I just applied for a Data Engineering Intern role at Kestrel Grid and thought of you. They want Python, SQL, and someone who has built data pipelines, which is exactly what you did on your capstone. It's remote and the team works on grid demand forecasting. Want me to send you the posting?" },
    { name: 'Priya Shah', contact: 'priya.shah@example.com', score: 0.68, message: "Hi Priya, Kestrel Grid is hiring a Data Engineering Intern for the team that runs their PostgreSQL pipelines and grid forecasting jobs. I know you care about climate infrastructure, so if you know a student who'd fit, they might like to hear about it." },
  ];

  const store = {
    settings: { apiKey: S === 'setup' || S === 'first-run' ? '' : 'sk-ant-demo-placeholder', model: 'claude-haiku-5-5', effort: 'low', threshold: 0.6 },
    friends: S === 'no-friends' || S === 'first-run' ? [] : FRIENDS.map(f => ({ ...f, notify: S !== 'no-friends-included' })),
    autoDetect: false,
  };

  const tabUrl = { 'page-chrome-blocks': 'chrome://newtab/', 'not-a-posting': 'http://kestrel-grid.localhost:8080/blog/heat-wave-forecasting' }[S] || POSTING_URL;
  const pageText = () => S === 'not-a-posting'
    ? 'Kestrel Grid blog. How we forecast demand on the hottest afternoon of the year. Our forecasting team walks through last summer\'s heat wave.'
    : JN.normalizeText(new DOMParser().parseFromString(read('docs/assets/harness/demo-posting.html'), 'text/html').querySelector('main').textContent).slice(0, JN.MAX_JOB_TEXT);

  const analyzeReply = () => ({
    results: { ok: true, result: { job: JOB, matches: MATCHES }, threshold: 0.6 },
    'no-matches': { ok: true, result: { job: JOB, matches: [] }, threshold: 0.6 },
    error: { ok: false, error: JN.describeApiError(429, { error: { type: 'rate_limit_error', message: 'Rate limited' } }) },
  })[S]; // loading: no reply, so the spinner stays

  const event = () => ({ addListener() {}, removeListener() {} });
  const pick = keys => Object.fromEntries([].concat(keys).filter(k => k in store).map(k => [k, structuredClone(store[k])]));

  const chrome = {
    storage: { local: { get: async keys => pick(keys), set: async items => { Object.assign(store, items); } }, onChanged: event() },
    permissions: { contains: async () => false, request: async () => false, onAdded: event(), onRemoved: event() },
    tabs: { query: async () => [{ id: 7, url: tabUrl }], create: async () => ({}) },
    scripting: {
      executeScript: async ({ func }) => {
        if (S === 'read-failed') throw new Error('Cannot access contents of the page.');
        return [{ result: func ? pageText() : undefined }];
      },
    },
    runtime: {
      id: 'demo',
      getURL: p => p,
      getManifest: () => JSON.parse(read('manifest.json')),
      openOptionsPage() {},
      sendMessage: async msg => {
        if (msg.type !== 'OVERLAY_STATE') return undefined;
        const posting = JN.postingLabel({ title: 'Data Engineering Intern | Kestrel Grid', url: POSTING_URL, seenAt: Date.now() - 2 * 60000 });
        return { state: 'prompt', posting, hasKey: S !== 'prompt-no-key' };
      },
      connect() {
        const listeners = [];
        return {
          onMessage: { addListener: f => listeners.push(f) },
          onDisconnect: event(),
          disconnect() {},
          postMessage() {
            const reply = analyzeReply();
            if (reply) setTimeout(() => listeners.forEach(f => f(reply)), 50);
          },
        };
      },
    },
  };
  Object.defineProperty(window, 'chrome', { value: chrome, configurable: true, writable: true });

  // Drive the page to the requested state with the same clicks a user would make,
  // then report ready (with the content height, for the popup frame).
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
  const until = find => new Promise(resolve => {
    const t = setInterval(() => { const el = find(); if (el) { clearInterval(t); resolve(el); } }, 20);
  });

  addEventListener('DOMContentLoaded', async () => {
    if (page !== 'options.html') await until(() => button(page === 'overlay.html' ? 'Not now' : 'Find friends') || document.querySelector('#panel h2'));
    const clicks = page === 'overlay.html' ? ['results'] : ['loading', 'results', 'no-matches', 'error'];
    if (clicks.includes(S)) {
      button('Find friends').click();
      await until(() => !button('Find friends') && (page !== 'overlay.html' || document.querySelector('#state-heading').textContent !== 'Find friends for this job?'));
    }
    if (S === 'auto-detect-panel') document.getElementById('auto-toggle').click();
    await new Promise(r => setTimeout(r, 300));
    if (document.activeElement) document.activeElement.blur(); // as after a mouse click: no focus ring in the shot

    const faces = await Promise.all(['600 16px Fraunces', '400 16px "IBM Plex Sans"', '600 16px "IBM Plex Sans"'].map(f => document.fonts.load(f)));
    const status = faces.every(f => f.length) ? 'ok' : 'bundled fonts did not load';
    document.documentElement.dataset.shotReady = status;
    if (window !== top) parent.postMessage({ shot: status, height: document.documentElement.scrollHeight }, '*');
  });
})();
