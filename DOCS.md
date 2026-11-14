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
│ - Auto-detect toggle     │ │ - Match threshold        │
│                          │ │ - Friends list editor    │
└──────────────────────────┘ └─────────────────────────┘
```

`lib/core.js` holds all the pure logic (detection patterns, prompt and request building, response parsing, mailto helpers). It defines a global `JN` in the extension and is `require()`d by the Node tests.

The API call runs in the **background service worker** because some job sites set a Content Security Policy that blocks outbound `fetch` from content scripts. The popup also goes through the background so there is one code path. A **port connection** (`chrome.runtime.connect`) keeps the service worker alive for the whole request.

---

## Storage

| Where | Key | Contents |
|-------|-----|----------|
| `chrome.storage.local` | `settings` | `{ apiKey, model, effort, threshold }` |
| `chrome.storage.local` | `autoDetect` | boolean, default `true` |
| `chrome.storage.local` | `friends` | the friends list; until saved, `friends.json` (an example) is used |
| `chrome.storage.session` | `jobs`, `lastJob` | recently viewed postings, per tab id; memory only, cleared when the browser closes |
| `chrome.storage.session` | `analyzed` | hashes of the last 100 postings already analyzed |

Web pages cannot read any of these. Nothing is written to the site's own `localStorage`/`sessionStorage`.

### Friends schema

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required. Display name |
| `contact` | string | Email used for `mailto:` links. Never sent to Claude |
| `skills` | string[] | Technical skills to match against job requirements |
| `interests` | string[] | Industry/domain interests |
| `level` | string | e.g. `"internship"`, `"new grad"`, `"mid"`, `"senior"` |
| `notify` | boolean | Set to `false` to exclude without deleting |

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

4. content.js shows the overlay only after { started }, then renders matches
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
- Friends are sent as `{ id, name, skills, interests, level }`. Claude returns matches by `id`, which are mapped back to the local list to attach contact emails.

`JN.parseResponse()` handles `refusal` and `max_tokens` stop reasons, drops unknown or duplicate ids and below-threshold scores, and sorts by score.

---

## Sending

`mailto:` links open your email client; you still press Send there. Browsers only allow one new window per click, so **Open next email** opens one checked email per click and counts down. **Copy all** copies every checked message as one block.

---

## Known limitations

- **Heuristic detection.** Confirmations shown inside cross-origin iframes, or only as images/animations, aren't detected. Use the popup.
- **API key in the browser.** Calls go straight from the extension to Anthropic with your own key, which is fine for personal use. Publishing to the Chrome Web Store for other people would need a small backend so users don't need their own key.
- **No true auto-send.** That would need OAuth with an email provider (Gmail API, Microsoft Graph).
