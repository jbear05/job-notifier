# Job Notifier — Technical Documentation

## Architecture

The extension is built on Chrome Manifest V3 and has four contexts:

```
┌─────────────────────────────────────────────────────┐
│  Any web page                                        │
│  ┌──────────────────────────────────────────────┐   │
│  │ lib/core.js + content.js (content scripts)   │   │
│  │  - Reads visible text locally                │   │
│  │  - Reports job postings to the background    │   │
│  │  - Spots confirmation messages               │   │
│  │  - Renders the overlay UI                    │   │
│  └──────────────┬───────────────────────────────┘   │
└─────────────────┼────────────────────────────────────┘
                  │ JOB_SEEN message / "analyze" port
┌─────────────────▼────────────────────────────────────┐
│  background.js (service worker)                      │
│  - Remembers recent postings per tab (storage.session)│
│  - Dedupes: each posting analyzed at most once       │
│  - Only place that calls the Anthropic API           │
└──────────────────────────────────────────────────────┘
┌──────────────────────────┐ ┌─────────────────────────┐
│ popup.html / popup.js    │ │ options.html / options.js│
│ - Manual analysis        │ │ - API key, model, effort │
│ - Auto-detect toggle     │ │ - Groups editor          │
│                          │ │ - Friends editor         │
└──────────────────────────┘ └─────────────────────────┘
```

`lib/core.js` holds all the pure logic (detection patterns, prompt and request building, response parsing, mailto helpers). It defines a global `JN` in the extension and is `require()`d by the Node tests.

The API call runs in the **background service worker** because some job sites set a Content Security Policy that blocks outbound `fetch` from content scripts. The popup also goes through the background so there is one code path. A **port connection** (`chrome.runtime.connect`) keeps the service worker alive for the whole request.

---

## Storage

| Where | Key | Contents |
|-------|-----|----------|
| `chrome.storage.local` | `settings` | `{ apiKey, model, effort }` |
| `chrome.storage.local` | `autoDetect` | boolean, default `true` |
| `chrome.storage.local` | `groups` | `[{ id, name }]`; until saved, `JN.EXAMPLE_STORE` is shown |
| `chrome.storage.local` | `friends` | `[{ id, name, contact, groups: [groupId] }]` |
| `chrome.storage.session` | `jobs`, `lastJob` | recently viewed postings, per tab id; memory only, cleared when the browser closes |
| `chrome.storage.session` | `analyzed` | hashes of the last 100 postings already analyzed |

Web pages cannot read any of these. Nothing is written to the site's own `localStorage`/`sessionStorage`.

### Groups and friends

| Field | Type | Description |
|-------|------|-------------|
| group `id` | string | Stable id, so renaming a group keeps its members |
| group `name` | string | Required, unique (case-insensitive). The only thing about your friends Claude sees |
| friend `name` | string | Required. Shown in the share step |
| friend `contact` | string | Email used for the `mailto:` link. Never sent to Claude |
| friend `groups` | string[] | Group ids. Any number; a friend in no group is never emailed |

`JN.normalizeStore()` turns whatever is in storage into this shape. A friends list saved before groups existed (no `groups` key) is moved into one `Everyone` group (fixed id `everyone`), and the background writes the result back on first read or on extension update. Friends with `"notify": false` are kept but put in no group. The old `skills`, `interests` and `level` fields are dropped.

---

## Auto-detection flow

```
1. You view a job posting
   └─ content.js reads the visible text of <main>/<article> (or <body>)
   └─ If ≥3 job signals match, sends JOB_SEEN to the background
   └─ background stores it under this tab's id (and as lastJob)

2. You submit the application; a confirmation appears
   └─ content.js checks *rendered* headings, dialogs, alerts, live regions,
      and <main> (≤3000 chars each) for a confirmation phrase
   └─ Opens the "analyze" port and sends AUTO_ANALYZE

3. background.js
   └─ Skips silently if auto-detect is off, no posting was seen in the last
      30 minutes (this tab first, then any tab), or the posting was already analyzed
   └─ Otherwise replies { started }, calls Claude, replies with the result

4. content.js shows the overlay only after { started }, then renders the share step
```

Because the posting is stored by tab id in the extension (not in the site's storage), it survives cross-site hops such as LinkedIn → Workday. Hidden elements are ignored, so pre-rendered "Thank you for applying" templates don't fire.

### Detection patterns

See `JOB_SIGNALS` and `CONFIRMATION_PATTERNS` in `lib/core.js`. Add a phrase there (and a case in `test/core.test.js`) to support a new site.

---

## Claude request

`JN.buildRequest()` sends one request to `POST /v1/messages`:

- **Model** from settings (default `claude-opus-5-5`) with `output_config.effort` (default `low`, to keep cost down).
- **Structured output**: `output_config.format` with a JSON schema, so the response is always valid JSON.
- **Refusal fallback**: on models that support it, `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header.
- Only groups that have at least one friend are sent, as compact `[{"id":0,"name":"Software"},…]`. No friend data is sent at all. Claude returns the job details, one `group` id (or `-1` if none fits) and one short `message` for the whole group, which keeps the output small no matter how many friends you have.

`JN.parseResponse()` handles `refusal` and `max_tokens` stop reasons, maps the group id back to the local group (an unknown id means no suggestion), and attaches every shareable group with its members' names and emails so the share step can switch groups without another call.

---

## Sending

The share step shows a chip for each group, with Claude's pick selected and starred. Tapping another chip switches groups instantly. The group's friends are listed with checkboxes so you can skip someone; friends without an email are shown but can't be ticked.

**Email N friends** opens one `mailto:` with one friend in To, or several in Bcc so they don't see each other's addresses. You still press Send in your email client. **Copy** copies the subject and message.

### Recruiter contact (optional)

The share step asks "Do you have a recruiter contact for this position?" You can paste a LinkedIn URL there; leave it blank and nothing changes.

- `JN.normalizeRecruiterUrl()` checks it loosely: any `http(s)` link on `linkedin.com` or a subdomain (`www.`, `uk.`, …). A missing scheme is fine (`linkedin.com/in/jane` becomes `https://linkedin.com/in/jane`). Anything else shows a warning and is left out.
- A valid link is added as a last line, `Recruiter contact for this role: <url>`, to the email body and to **Copy**. The editable message box is not changed.
- The link is only held in memory for the open overlay or popup. It is never saved and never sent to Claude: the analysis request has already finished by the time you see the field.

---

## Known limitations

- **Heuristic detection.** Confirmations shown inside cross-origin iframes, or only as images/animations, aren't detected. Use the popup.
- **API key in the browser.** Calls go straight from the extension to Anthropic with your own key, which is fine for personal use. Publishing to the Chrome Web Store for other people would need a small backend so users don't need their own key.
- **No true auto-send.** That would need OAuth with an email provider (Gmail API, Microsoft Graph).
