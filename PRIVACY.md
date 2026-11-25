# Job Notifier privacy policy

Last updated: November 25, 2026. Applies to Job Notifier 2.0.0 and later.

Job Notifier is a Chrome extension that reads a job posting, asks Claude which of your friends might fit it, and drafts a message to each one. It has no server of its own. Everything it keeps stays in your Chrome profile, and the only place it sends data is Anthropic's API, using an API key you provide.

## What it reads

- **When you open the Job Notifier popup on a tab**, it reads the visible text of that one page so you can check it before analyzing. Chrome grants this access only for the tab you clicked on (the `activeTab` permission).
- **When auto-detect is on**, it reads the visible text of pages you open, in your browser, to spot job postings and application confirmations. Text from a page that doesn't look like a job posting or a confirmation isn't kept. Auto-detect is off until you turn it on, and turning it off stops all page reading and gives back Chrome's all-sites access.
- **Text you paste** into the popup when a page can't be read.

Job Notifier doesn't read form fields, passwords, cookies, or your browsing history.

## What it stores, and where

All of this is stored on your computer, in Chrome's extension storage for your profile. Web pages can't read it.

| What | Where | How long |
|---|---|---|
| Your Anthropic API key and friends list (names, email addresses, skills, interests, level, whether each is included) | `chrome.storage.local` (`vault`, encrypted with your passphrase) | Until you change them, erase saved data, or remove the extension |
| Model, effort, match threshold, and whether auto-detect is on | `chrome.storage.local` (`settings`, `autoDetect`) | Until you change them or remove the extension |
| Session unlock key (`vaultKey`) | `chrome.storage.session` | In memory only while unlocked, until you click **Lock now**, erase saved data, or close Chrome |
| Job postings you viewed: the posting text (up to 8,000 characters), page title, the site's hostname (such as `jobs.example.com`, never the full address), and time viewed | `chrome.storage.session` | In memory only, until you close that tab or close Chrome. A posting is offered after a confirmation only within 30 minutes of viewing it |
| A pending "Find friends for this job?" prompt (the posting and the site that showed the confirmation), and fingerprints of postings already offered | `chrome.storage.session` | In memory only. The prompt is cleared when you close it, load another page in that tab, or close the tab; everything here is cleared when you close Chrome |

Analysis results (the job summary, scores, and drafts) are not stored. They exist only while the popup or results panel is open.

Your API key and friends list are **encrypted at rest** using AES-256-GCM with a key derived from a **passphrase** you choose (PBKDF2-SHA256). Your passphrase is never stored anywhere and never leaves this browser. Job Notifier has no server and **cannot recover** a forgotten passphrase; if you forget it, you must use **Forgot passphrase?** in settings to erase your saved key and friends list and start over.

Once you unlock settings with your passphrase, your data stays unlocked in Chrome's session memory until you click **Lock now** (in settings or the popup) or close Chrome. While unlocked, the extension keeps the session key in `chrome.storage.session` (which content scripts cannot read) so you aren't prompted on every page. Locking clears the session key and wipes any displayed API key, friend list, or analysis results from open extension pages.

To cap what any key can cost, set a spend limit for your Anthropic organization at [platform.claude.com/settings/spend-limits](https://platform.claude.com/settings/spend-limits).

Exporting your friends list writes a **readable, unencrypted JSON file** (`job-notifier-friends.json`) containing your friends' names, email addresses, skills, interests, and levels (excluding your API key and passphrase) to your computer. Anyone with access to that file can read it outside Chrome.

A recruiter link you paste into the results is held only while that window is open. It is never saved.

## What it sends to Anthropic, and when

Job Notifier sends one request to Anthropic's API (`https://api.anthropic.com`) each time you click **Find friends**. Nothing is sent when you open the popup, view a posting, reach a confirmation page, or unlock your passphrase. The request contains:

- the job posting text, up to 8,000 characters;
- each included friend's name, skills, interests, and level;
- your chosen model, effort, and match threshold;
- your API key, which authorizes the request.

It never sends your friends' email addresses, your passphrase, or a recruiter link you paste. Your API key goes only to Anthropic.

The request is billed to your Anthropic account. Anthropic handles the data under your agreement with them and its [privacy policy](https://www.anthropic.com/legal/privacy).

## What it doesn't do

- No analytics, telemetry, ads, or tracking of any kind.
- No developer server. The developer never receives your passphrase, your key, your friends list, the pages you read, or the drafts.
- No data is sold or shared with anyone other than Anthropic, and only to provide the matching you ask for.
- It never sends an email. **Open email** opens a draft in your own email app, and you choose whether to send it. **Copy** puts the draft on your clipboard.

Job Notifier's use of this data follows the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Deleting your data

- **Everything:** remove Job Notifier from Chrome (uninstall it on `chrome://extensions`, or right-click the toolbar icon and choose **Remove from Chrome**). Chrome deletes all of its stored data.
- **Encrypted key and friends list:** in settings, click **Forgot passphrase?** (or **Erase saved data**) and confirm to permanently erase the encrypted API key and friends list while keeping model, match, and auto-detect preferences.
- **Only your key:** unlock settings, clear the API key field, and click **Save**.
- **Friends:** unlock settings and remove them one by one. An exported friends file is yours to delete; it is unencrypted and contains email addresses, so keep it private.
- **Recent postings:** close the tab, or close Chrome.

Erasing or overwriting data uses Chrome's extension storage API (logical deletion). Prior OS/browser profile backups or underlying storage compaction blocks written before encryption or deletion are outside the extension's control. Requests already sent to Anthropic are covered by Anthropic's retention policies. Deleting the key here doesn't delete the key itself; revoke it in the Claude Console if you no longer want it to work.

## Changes

If a future version reads, stores, or sends anything new, this file will change before that version is published, and the date at the top will be updated. The full history is in the repository.

## Contact

Questions or problems: open an issue at [github.com/jbear05/job-notifier/issues](https://github.com/jbear05/job-notifier/issues).
