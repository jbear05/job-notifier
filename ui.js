// Shared by the popup, the settings page, and the overlay: a small DOM builder,
// clipboard copy that reports failure, and the results view (spec Design: Results).
// Untrusted text (pages, Claude, friends, API errors) only ever becomes text
// nodes or `.value`, never HTML (criterion 28).

// h('p', { class: 'small', onclick: fn, 'aria-label': 'x' }, 'text', node, [nodes])
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false && c !== ''));
  return el;
}

function btn(label, onclick, kind = 'secondary', props = {}) {
  return h('button', { type: 'button', class: kind === 'text' ? 'btn-text' : `btn btn-${kind}`, onclick, ...props }, label);
}

const row = (...items) => h('div', { class: 'actions' }, ...items);

function openSettings(section) {
  if (section) chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${section}`) });
  else chrome.runtime.openOptionsPage();
}

// One request on the worker's `analyze` port (engineer A's contract). Resolves
// to the worker's reply, or to an error reply if the port closes first or the
// optional timer runs out.
function analyzeRequest(msg, timeoutMs) {
  return new Promise(resolve => {
    const port = chrome.runtime.connect({ name: 'analyze' });
    let timer;
    let settled = false;
    const done = reply => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.disconnect();
      resolve(reply);
    };
    port.onMessage.addListener(done);
    port.onDisconnect.addListener(() => done({ ok: false, error: JN.ERRORS.restarted }));
    if (timeoutMs) timer = setTimeout(() => done({ ok: false, error: JN.ERRORS.timeout }), timeoutMs);
    port.postMessage(msg);
  });
}

// Resolves false only when both the Clipboard API and the fallback fail (criterion 10).
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const back = document.activeElement;
    const ta = h('textarea', { class: 'vh', 'aria-hidden': 'true', tabindex: '-1', readonly: true, value: text });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e2) {
      ok = false;
    }
    ta.remove();
    if (back && back.focus) back.focus();
    return ok;
  }
}

const isBusy = b => b.getAttribute('aria-disabled') === 'true';

// A 2-second label that keeps the button focusable: disabling a focused button
// drops focus to the page body (Design: rules for every surface).
function flash(button, label) {
  const original = button.textContent;
  button.textContent = label;
  button.setAttribute('aria-disabled', 'true');
  setTimeout(() => {
    button.textContent = original;
    button.removeAttribute('aria-disabled');
  }, 2000);
}

// Copy shared by the popup and the overlay: [heading, body].
const COPY = {
  loading: ['Finding friends…', 'Claude is reading the posting and scoring your friends.'],
  empty: ['Add a friend first', "Your friends list is empty, so there's no one to match a posting to."],
  'none-included': ['No friends included', 'Every friend on your list is excluded from matching. Include at least one in settings.'],
};

function loadingView() {
  return h('div', { class: 'loading', role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', null, COPY.loading[1]));
}

const resultsHeading = n => (n === 1 ? '1 friend might want this job' : `${n} friends might want this job`);

function jobSummary(job) {
  const j = job || {};
  return h('div', { class: 'job-summary' },
    h('p', { class: 'job-title' }, j.title || 'Unknown title'),
    h('p', null, j.company || 'Unknown company'),
    (j.level || j.remote) && h('p', { class: 'chips' },
      j.level && h('span', { class: 'chip' }, j.level),
      j.remote && h('span', { class: 'chip' }, 'Remote')),
    j.location && h('p', { class: 'small muted' }, j.location),
    j.skills && j.skills.length > 0 && h('p', { class: 'chips' }, j.skills.map(s => h('span', { class: 'chip' }, s))));
}

function noMatchesView(job, threshold) {
  return [
    jobSummary(job),
    h('p', null, `None of your included friends scored ${Math.round(threshold * 100)}% or higher for this posting. You can lower the match threshold in settings.`),
    row(btn('Open settings', () => openSettings(), 'text')),
  ];
}

// The Console root: Anthropic's docs link only the root for billing questions.
const BILLING_URL = 'https://platform.claude.com/';

// Buttons for an error from JN.describeApiError or JN.ERRORS (Design: Error copy).
function errorActions(action, retry) {
  const again = kind => btn('Try again', retry, kind);
  if (action === 'settings') return [btn('Open settings', () => openSettings(), 'primary')];
  if (action === 'billing') {
    return [h('a', { class: 'btn btn-primary', href: BILLING_URL, target: '_blank', rel: 'noopener' }, 'Open Anthropic billing'), again('secondary')];
  }
  if (action === 'retry') return [again('primary')];
  return [];
}

// Job summary, recruiter field, match cards, and the bulk row, for 1+ matches.
function resultsView({ job, matches }) {
  const list = matches.map(m => ({ ...m }));
  const many = list.length > 1;
  const sent = new Set();
  let recruiterUrl = '';
  const live = h('p', { class: 'vh', role: 'status' });
  const alerts = [];

  const copied = (button, message) => {
    alerts.forEach(a => { a.textContent = ''; });
    live.textContent = message;
    flash(button, 'Copied');
  };

  const recStatus = h('p', { id: 'recruiter-status', class: 'small', 'aria-live': 'polite' });
  const recInput = h('input', {
    id: 'recruiter-input', type: 'url', inputmode: 'url', autocomplete: 'off',
    placeholder: 'https://www.linkedin.com/in/…', 'aria-describedby': 'recruiter-help recruiter-status',
    oninput: () => {
      const url = JN.normalizeRecruiterUrl(recInput.value);
      recruiterUrl = url || '';
      if (url === null) recInput.setAttribute('aria-invalid', 'true');
      else recInput.removeAttribute('aria-invalid');
      recStatus.classList.toggle('error-text', url === null);
      recStatus.textContent = url === null
        ? "That doesn't look like a LinkedIn link, so it won't be included."
        : url ? 'Added to your emails.' : '';
    },
  });

  const checked = () => cards.map((c, i) => (c.pick.checked ? i : -1)).filter(i => i >= 0);

  const next = btn('', () => {
    if (isBusy(next)) return;
    const i = checked().find(j => !sent.has(j));
    if (i !== undefined) openEmail(i);
  }, 'primary');
  const bulkAlert = h('p', { class: 'small error-text', role: 'alert' });
  alerts.push(bulkAlert);
  const copyAll = btn('Copy all', async () => {
    if (isBusy(copyAll)) return;
    const picked = checked().map(i => list[i]);
    if (await copyText(JN.combinedMessages(picked, job, recruiterUrl))) {
      return copied(copyAll, picked.length === 1 ? 'Copied 1 message.' : `Copied ${picked.length} messages.`);
    }
    bulkAlert.textContent = "Couldn't copy. Copy each message from its box instead.";
  });

  function updateBulk() {
    if (!many) return;
    const left = checked().filter(i => !sent.has(i)).length;
    next.textContent = left ? `Open next email (${left} left)` : 'All checked emails opened';
    if (left) next.removeAttribute('aria-disabled');
    else next.setAttribute('aria-disabled', 'true');
  }

  function openEmail(i) {
    window.open(JN.mailtoUrl(list[i], job, recruiterUrl));
    sent.add(i);
    updateBulk();
  }

  const cards = list.map((m, i) => {
    const pick = h('input', { type: 'checkbox', checked: true, 'aria-label': `Select ${m.name}`, onchange: updateBulk });
    const note = h('p', { class: 'link-note', hidden: !JN.draftHasLinkOrEmail(m.message) },
      'This draft has a link or email address in it. Check it before you send.');
    const box = h('textarea', {
      rows: 4, 'aria-label': `Message to ${m.name}`, value: m.message,
      oninput: () => {
        m.message = box.value;
        note.hidden = !JN.draftHasLinkOrEmail(m.message);
      },
    });
    const alert = h('p', { class: 'small error-text', role: 'alert' });
    alerts.push(alert);
    const open = btn('Open email', () => {
      if (isBusy(open)) return;
      openEmail(i);
      flash(open, 'Opened');
    }, many ? 'secondary' : 'primary', { 'aria-label': `Open email to ${m.name}` });
    const copy = btn('Copy', async () => {
      if (isBusy(copy)) return;
      if (await copyText(JN.withRecruiter(m.message, recruiterUrl))) return copied(copy, `Copied the message to ${m.name}.`);
      alert.textContent = "Couldn't copy. The message is selected, so press Ctrl+C (Cmd+C on a Mac).";
      box.focus();
      box.select();
    }, 'secondary', { 'aria-label': `Copy message to ${m.name}` });

    const card = h('li', { class: 'card match stack' },
      h('div', { class: 'match-top' },
        h('label', { class: 'match-select' }, pick, h('span', { class: 'label' }, m.name)),
        h('span', { class: 'match-score' }, `${Math.round(m.score * 100)}% match`)),
      h('p', { class: 'small muted match-email' }, m.contact || 'No email saved'),
      box, note, row(open, copy), alert);
    card.pick = pick;
    return card;
  });
  updateBulk();

  return [
    jobSummary(job),
    h('div', { class: 'field' },
      h('label', { class: 'label', for: 'recruiter-input' }, 'Do you have a recruiter contact for this position?'),
      h('p', { id: 'recruiter-help', class: 'small muted' }, "Optional. Paste their LinkedIn and it's added to each email and to Copy all."),
      recInput, recStatus),
    h('ul', { class: 'matches' }, cards),
    many && h('div', { class: 'stack' },
      row(next, copyAll),
      bulkAlert,
      h('p', { class: 'small muted' }, 'Browsers only allow one email window per click, so this opens the checked emails one at a time.')),
    live,
  ];
}
