# Job Notifier — Technical Documentation

## Architecture

The extension is built on Chrome Manifest V3 and has three main contexts:

```
┌─────────────────────────────────────────────────────┐
│  Job site page                                      │
│  ┌─────────────────────────────────────────────┐   │
│  │ content.js + config.js (content scripts)    │   │
│  │  - Detects job postings & confirmations     │   │
│  │  - Captures job text                        │   │
│  │  - Injects and manages the overlay UI       │   │
│  └──────────────┬──────────────────────────────┘   │
└─────────────────┼───────────────────────────────────┘
                  │ chrome.runtime.connect (port)
┌─────────────────▼───────────────────────────────────┐
│  background.js (service worker)                     │
│  - Loads friends.json                               │
│  - Calls Anthropic API                              │
│  - Returns scored matches with contact info         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  popup.html / popup.js / popup.css (extension popup)│
│  - Manual job analysis                              │
│  - Auto-detect toggle (saved to chrome.storage)     │
│  - Results UI with send/copy per friend             │
└─────────────────────────────────────────────────────┘
```

The API call is intentionally routed through the **background service worker** rather than the content script. This is necessary because some job sites set a Content Security Policy that blocks outbound `fetch` requests from content scripts, even to extension-permitted hosts. The service worker runs in the extension's own context and is not subject to page CSP.

A **persistent port connection** (`chrome.runtime.connect`) is used instead of one-shot `sendMessage` to prevent Chrome from terminating the service worker mid-request during the API call.

---

## File reference

### `manifest.json`
Manifest V3 extension config.

Key permissions:
- `activeTab` — read the current tab's URL and inject scripts on demand
- `scripting` — execute content scripts programmatically
- `storage` — persist the auto-detect toggle state via `chrome.storage.local`
- `clipboardWrite` — copy messages to clipboard
- `host_permissions: https://api.anthropic.com/*` — allow the background service worker to call the Anthropic API

### `config.js` *(gitignored — create locally)*
Holds runtime secrets and tuning values. Never committed.

```js
const CONFIG = {
  ANTHROPIC_API_KEY: "sk-ant-...",  // Your Anthropic API key
  MODEL: "claude-sonnet-4-6",        // Claude model to use
  RELEVANCE_THRESHOLD: 0.6           // Minimum score (0–1) to include a match
};
```

Loaded by both `popup.html` (via `<script src="config.js">`) and `content.js` (via content scripts in the manifest). The background service worker receives the config object in the message payload from the content script, so it never needs to load `config.js` directly.

### `friends.json`
The list of people to match against job postings.

**Schema:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name, used in messages and as avatar initial |
| `contact` | string | Email address used for `mailto:` links |
| `skills` | string[] | Technical skills to match against job requirements |
| `interests` | string[] | Industry/domain interests |
| `level` | string | Experience level: `"internship"`, `"new grad"`, `"mid"`, `"senior"` |
| `notify` | boolean | Set to `false` to exclude from all analysis without deleting |

### `content.js`
Injected into every page. Handles two responsibilities:

**1. Detection**

On page load and on every DOM mutation (debounced to 600ms), `checkPage()` runs:
- Extracts visible text from the page (strips `script`, `style`, `nav`, `footer`, `header` tags, truncates to 8000 chars)
- If the text matches job posting signals (≥2 of 6 keyword patterns), stores it in a module-level variable and in `sessionStorage` under `__jn_jobText`
- If the text matches any confirmation pattern (e.g. "application submitted", "thanks for applying"), triggers analysis — but only if `chrome.storage.local.autoDetect !== false`

URL changes in SPAs are detected inside the same MutationObserver by comparing `location.href` to a stored `lastUrl`. On change, `overlayShown` and `capturedJobText` are reset.

**2. Overlay UI**

All overlay HTML and CSS is injected at runtime (`injectStyles()` inserts a `<style id="jn-styles">` tag). All CSS classes are prefixed with `jn-` to avoid collisions with host page styles.

The overlay consists of a fixed backdrop (`#jn-overlay`) and a modal (`#jn-modal`) with:
- A sticky white header with toggle-friendly subtitle
- A scrollable `.jn-body` containing the job card, match cards, and send-all button
- Per-match: avatar initial, editable textarea, Send (mailto) and Copy buttons
- Clicking the backdrop or the × button dismisses the overlay

**Also handles** the `GET_PAGE_TEXT` message from `popup.js` for the manual popup flow.

### `background.js`
Service worker. Activated by a port connection from `content.js`.

Flow on `ANALYZE_JOB` message:
1. Loads `friends.json` once (cached in module-level `friends` array)
2. Filters to friends with `notify !== false`
3. Sends a structured prompt to the Anthropic API with the job text and friends list
4. Parses the JSON response (retries once with stricter instructions if parsing fails)
5. Annotates each match with the friend's `contact` email (since content script can't fetch `friends.json` on CSP-restricted sites)
6. Returns `{ ok: true, result }` or `{ ok: false, error }` via the port

### `popup.html` / `popup.js` / `popup.css`
The extension popup (opened by clicking the toolbar icon).

States:
- **Loading** — shown immediately on open while the page text is fetched and analyzed
- **Results** — job card + matched friends with editable messages, Send and Copy buttons, Send All
- **Error** — shown if the API call or tab access fails
- **Manual fallback** — shown if the active page doesn't look like a job posting; user can paste text manually

The popup calls the Anthropic API **directly** (not through the background), since the popup runs in the extension's own context and is never subject to a host page's CSP.

The **auto-detect toggle** reads from and writes to `chrome.storage.local` key `autoDetect`. Default is `true` (treated as enabled when the key is absent).

---

## Detection patterns

### Job posting signals (need ≥ 2 to match)
- `job`, `position`, `role`, `opening`, `opportunity`
- `responsibilities`, `qualifications`, `requirements`, `about the role`
- `apply`, `application`, `candidates`
- `salary`, `compensation`, `benefits`, `equity`
- `full-time`, `part-time`, `contract`, `internship`, `remote`, `hybrid`, `on-site`
- `experience`, `years`, `skills`, `proficiency`

### Confirmation page triggers (any 1 matches)
- `application submitted`
- `application received`
- `thanks for applying` / `thank you for applying`
- `successfully applied`
- `application is complete` / `application complete`
- `your application has been`
- `we received your application`
- `you've now applied` / `you've applied`
- `application was sent`

To add support for a new site, add its confirmation phrase to the `CONFIRMATION_PATTERNS` array in `content.js`.

---

## Claude prompt design

The prompt asks Claude to do two things in one call:

1. **Extract** structured job metadata: title, company, required skills, level, location, remote flag
2. **Score and draft** — for each active friend, produce a relevance score (0.0–1.0) and a short personalized message if the score meets the threshold

Returning both in a single JSON object keeps the API call to one round-trip. The prompt explicitly prohibits markdown, code fences, or any text outside the JSON to make parsing reliable. A retry path with stricter instructions handles the rare case where the model wraps the output anyway.

---

## Data flow for auto-detection

```
1. User visits job posting
   └─ content.js stores job text in capturedJobText + sessionStorage

2. User submits application → confirmation page loads
   └─ MutationObserver fires → checkPage() detects confirmation text
   └─ Checks chrome.storage.local.autoDetect → if enabled:

3. triggerAnalysis()
   └─ showOverlayLoading() → injects overlay into page
   └─ Opens port to background service worker
   └─ Sends { type: 'ANALYZE_JOB', jobText, config }

4. background.js receives message
   └─ Loads friends.json (cached after first load)
   └─ Calls Anthropic API
   └─ Annotates matches with contact emails
   └─ port.postMessage({ ok: true, result })

5. content.js receives result
   └─ renderOverlayResults() → replaces loading state with job card + matches
   └─ User reviews, edits, and clicks Send (opens mailto:) or Copy
```

---

## Known limitations

- **Confirmation text detection is heuristic.** Sites that show confirmation in a modal, iframe, or via a non-text method (e.g. an animation) may not trigger the overlay. Use manual mode as a fallback.
- **Job text capture is per-tab and in-memory.** If you navigate to the job posting in one tab and the confirmation opens in a new tab, `capturedJobText` will be empty in the new tab. The extension falls back to `sessionStorage` (same origin only) and then to extracting text from the confirmation page itself.
- **`mailto:` opens your default email client.** This is not a true send — you must click Send in Outlook, Gmail, Apple Mail, etc. True auto-send would require OAuth integration with your email provider (e.g. Microsoft Graph API for Outlook).
- **Service worker lifecycle.** Chrome can terminate the background service worker at any time. The port connection keeps it alive during an API call, but if Chrome force-kills it, the overlay will show a "Connection closed unexpectedly" error. Reopening the popup and re-running manually works around this.
