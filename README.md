# Job Notifier

A Chrome extension that detects when you apply to a job and automatically drafts personalized referral messages for friends who might be a good fit.

## What it does

When you submit a job application, a popup appears with a list of matched friends based on their skills and interests. Each match includes a ready-to-send draft email you can review, edit, and send in one click.

## Features

- Auto-detects job application confirmation pages across major job boards
- Matches friends by skills, interests, and experience level using Claude AI
- Drafts a personalized message for each match explaining why the role fits them
- Send or copy messages per friend, or send to all at once
- Toggle auto-detection on/off from the extension popup
- Manual mode: paste any job posting text to run the analysis yourself

## Setup

**1. Get an Anthropic API key**

Create an account at [console.anthropic.com](https://console.anthropic.com), go to **API Keys**, and generate a key. You'll need to add billing credits — each analysis costs a fraction of a cent.

**2. Configure the extension**

Create `config.js` in the project folder (it's gitignored to protect your key):

```js
const CONFIG = {
  ANTHROPIC_API_KEY: "sk-ant-...",
  MODEL: "claude-sonnet-4-6",
  RELEVANCE_THRESHOLD: 0.6
};
```

**3. Add your friends**

Edit `friends.json` with the people you want to notify:

```json
[
  {
    "name": "Alex",
    "contact": "alex@example.com",
    "skills": ["Python", "React", "backend"],
    "interests": ["fintech", "SaaS"],
    "level": "internship",
    "notify": true
  }
]
```

Set `"notify": false` to temporarily exclude someone without deleting them.

**4. Generate icons**

Open `icons/generate-icons.html` in your browser, download the three icons, and save them as `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png`.

**5. Load into Chrome**

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder

## Usage

**Auto mode (default):** Browse to a job posting, apply normally, and the overlay appears automatically on the confirmation page.

**Manual mode:** Click the extension icon on any page. If a job posting isn't detected, paste the text into the text area and click Analyze.

**Toggle:** Click the extension icon at any time to turn auto-detection on or off using the toggle in the header.

## Supported job boards

Auto-detection works on any site that shows a text confirmation after applying — including LinkedIn, Greenhouse, Lever, Workday, Indeed, and most ATS platforms. If a site isn't detected, use manual mode.
