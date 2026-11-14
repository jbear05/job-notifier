# Job Notifier

A Chrome extension that detects when you apply to a job and automatically drafts personalized referral messages for friends who might be a good fit.

## What it does

When you submit a job application, a popup appears with a list of matched friends based on their skills and interests. Each match includes a ready-to-send draft email you can review, edit, and send in one click.

## Features

- Auto-detects job application confirmation pages across major job boards, including when the confirmation is on a different site than the posting
- Matches friends by skills, interests, and experience level using Claude
- Drafts a personalized message for each match explaining why the role fits them
- Send or copy messages per friend, step through all checked emails, or copy them all at once
- Toggle auto-detection on/off from the extension popup
- Manual mode: paste any job posting text to run the analysis yourself

## Setup

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this folder. Nothing needs to be built or generated first.
2. The settings page opens automatically. Paste an Anthropic API key (create one at [console.anthropic.com](https://console.anthropic.com/settings/keys)), add your friends, and click **Save**. You can reopen settings from the gear icon in the popup.

Friends are a JSON list:

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

Your key and friends list are stored only in Chrome's extension storage on your machine. Only names, skills, interests, and level are sent to Claude; contact details never leave the browser.

## Usage

**Auto mode (default):** Browse to a job posting, apply normally, and the overlay appears on the confirmation page. Each posting is analyzed at most once.

**Manual mode:** Click the extension icon. If the page is a job posting, its text is pre-filled; otherwise paste the text. Click **Find matching friends**. Opening the popup by itself never calls Claude.

**Toggle:** Use the switch in the popup header to turn auto-detection on or off.

## Development

```sh
npm test        # unit tests for detection, prompt building, and response parsing
npm run check   # syntax check every script
```

The same checks run on GitHub for every push and pull request.

## Supported job boards

Auto-detection works on any site that shows a text confirmation after applying — including LinkedIn, Greenhouse, Lever, Workday, Indeed, and most ATS platforms. If a site isn't detected, use manual mode. Confirmations shown inside an embedded iframe aren't detected yet.
