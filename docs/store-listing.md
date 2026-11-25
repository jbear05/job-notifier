# Chrome Web Store listing

Copy for the Job Notifier 2.0.0 submission, field by field, in the order the Developer Dashboard asks for it. Paste the text as plain text; the dashboard doesn't render Markdown.

Requirements checked on 2026-11-25 against developer.chrome.com: [store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [images](https://developer.chrome.com/docs/webstore/images), [privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [user data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), and the [manifest description](https://developer.chrome.com/docs/extensions/reference/manifest/description) limit (132 characters).

## Store listing tab

### Name

Job Notifier

### Summary

Taken from `description` in manifest.json, which is limited to 132 characters. If one changes, change the other.

Finds friends who'd fit a job posting and drafts a message to each. Uses your own Anthropic API key.

### Category

Productivity. If the dashboard asks for a subcategory under Productivity, pick Communication.

### Language

English (United States)

### Detailed description

```text
Job Notifier helps you pass job postings to friends who'd want them.

Open Job Notifier on a job posting and click Find friends. Claude reads the posting, scores how well it fits each friend on your list by their skills, interests, and level, and drafts a short message to each good match. You review and edit every draft, then open it in your own email app or copy it. Nothing reaches a friend unless you send it.

HOW IT WORKS
- Add friends in settings: name, email, skills, interests, and level. You can import and export the list as JSON.
- On a posting, click the Job Notifier toolbar button. It reads that one page. You can also paste the posting text.
- Each match shows a score and an editable draft. Open email opens the draft in your email app. Copy and Copy all put drafts on your clipboard.
- If you have the recruiter's LinkedIn for the role, paste it once and it's added to each email.
- Auto-detect is optional and off by default. When it's on and you apply to a job you just viewed, Job Notifier asks "Find friends for this job?" before doing anything. Turning it on asks Chrome for access to all sites; turning it off gives that access back.

BRING YOUR OWN ANTHROPIC API KEY
Job Notifier calls Claude with your own Anthropic API key. Each click on Find friends is one request, billed to your Anthropic account at Anthropic's API prices. Job Notifier itself is free, with no account to create and no server of its own. The default model is the lower-cost Claude Haiku 5.5; Claude Sonnet 5.5 and Claude Opus 5.5 are also offered. You can set a spend limit in the Claude Console.

PRIVACY
- Your key, settings, and friends are stored only in this browser.
- When you click Find friends, the posting text (up to 8,000 characters) and each included friend's name, skills, interests, and level go to Anthropic's API. Friends' email addresses and recruiter links are never sent.
- No analytics, no tracking, no developer server.

Privacy policy: https://github.com/jbear05/job-notifier/blob/main/PRIVACY.md
Source code (MIT License): https://github.com/jbear05/job-notifier
```

### Graphic assets

Sizes from the images page: store icon 128x128 (96x96 artwork with 16px transparent padding), 1 to 5 screenshots at 1280x800 or 640x400 with square corners and no padding, small promo tile 440x280, marquee 1400x560. Only the icon and one screenshot are required. Ours are PNG without alpha, except the icon, which keeps its transparent padding.

| Field | File | Size |
|---|---|---|
| Store icon | `icons/icon128.png` | 128x128 |
| Screenshot 1 | `docs/assets/screenshot-1-overlay.png` (results overlay on the demo confirmation page) | 1280x800 |
| Screenshot 2 | `docs/assets/screenshot-2-popup.png` (popup on the demo posting) | 1280x800 |
| Screenshot 3 | `docs/assets/screenshot-3-settings.png` (settings, Claude section) | 1280x800 |
| Screenshot 4 (optional) | `docs/assets/screenshot-4-prompt.png` (the "Find friends for this job?" prompt) | 1280x800 |
| Small promo tile | `docs/assets/promo-440x280.png`, exported from `docs/assets/promo-440x280.svg` | 440x280 |
| Marquee promo tile | Not made. It's optional and only needed to be featured in the marquee. | 1400x560 |

Upload screenshots in the order above. No YouTube video.

### Additional fields

- Homepage URL: https://github.com/jbear05/job-notifier
- Support URL: https://github.com/jbear05/job-notifier/issues
- Mature content: No

## Privacy practices tab

### Single purpose description

```text
Job Notifier has a single purpose: helping the user tell friends about a job posting. It reads a job posting the user chooses, asks Claude (with the user's own Anthropic API key) which friends on the user's list fit it, and drafts a message to each match for the user to review and send from their own email app. The friends list, the toolbar popup, the optional prompt after applying, and the copy and email buttons all serve that purpose.
```

### Permission justifications

**activeTab**
```text
When the user clicks the toolbar button, Job Notifier reads the visible text of that one tab so they can find friends for the job posting on it. It doesn't need access to any other tab.
```

**scripting**
```text
Used with activeTab to run the function that reads the visible text of the tab the user opened the popup on (chrome.scripting.executeScript). Also used to register the auto-detect content script (chrome.scripting.registerContentScripts) only after the user turns auto-detect on and grants site access, and to unregister it when they turn auto-detect off.
```

**storage**
```text
Saves the user's settings, Anthropic API key, and friends list in chrome.storage.local on their device, and recently viewed job postings in chrome.storage.session, which is memory only and cleared when Chrome closes. Nothing is synced or sent to a developer server.
```

**clipboardWrite**
```text
The Copy and Copy all buttons put drafted messages on the clipboard so the user can paste them into another app. The permission covers the copy fallback when the asynchronous Clipboard API isn't available.
```

**Host permission: `https://api.anthropic.com/*`**
```text
When the user clicks Find friends, the service worker sends one request to Anthropic's Messages API with the user's own API key. This is the only server the extension contacts.
```

**Optional host permissions: `https://*/*` and `http://*/*`**
```text
Requested only when the user turns on auto-detect, which is off by default. With it, a content script reads visible page text locally to recognize a job posting and, later, an application confirmation on whatever site the user applies through, since applications happen on many different sites. Nothing is sent until the user clicks Find friends in the prompt. Turning auto-detect off unregisters the script and gives the permission back with chrome.permissions.remove.
```

### Remote code

No, I am not using remote code. All scripts, styles, and fonts are bundled in the package. The Anthropic API returns JSON data, which is parsed and never run.

### Data usage

Collected (stored or processed by the extension, including locally, as the user data FAQ requires):

| Data type | Answer | What and why |
|---|---|---|
| Personally identifiable information | Yes | Friends' names and email addresses that the user enters. Stored locally. Names are sent to Anthropic to score matches; email addresses only address the mailto draft and are never sent. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | Yes | The user's Anthropic API key. Stored locally and sent only to Anthropic to authorize each request. |
| Personal communications | No | It doesn't read the user's email or messages. Drafts it writes are opened in the user's own email app and not kept after the browser closes. |
| Location | No | |
| Web history | Yes | With auto-detect on, the address, title, and time of viewed job postings, kept in session memory until the tab or Chrome closes. Never sent anywhere. |
| User activity | No | No click, scroll, or keystroke monitoring. |
| Website content | Yes | Visible text of a job posting. Sent to Anthropic, up to 8,000 characters, only when the user clicks Find friends. |

Certifications (check all three):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

The only transfer is to Anthropic, to provide the single purpose, at the user's click.

### Privacy policy URL

https://github.com/jbear05/job-notifier/blob/main/PRIVACY.md (the repository's [PRIVACY.md](../../PRIVACY.md)).

## Distribution tab

- Visibility: Public
- Regions: All regions
- Price: Free

## Notes for review (optional field)

```text
Job Notifier needs the user's own Anthropic API key to run an analysis. Without one, the popup shows a setup screen and nothing is sent. Auto-detect is off by default, so the install asks for no site access; all-sites access is requested only when the user turns auto-detect on.
```
