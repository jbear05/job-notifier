let friends = [];

async function loadFriends() {
  if (friends.length) return;
  const resp = await fetch(chrome.runtime.getURL('friends.json'));
  friends = await resp.json();
}

async function callClaude(jobText, config, retry = false) {
  const activeFriends = friends.filter(f => f.notify !== false);
  const strictInstruction = retry
    ? "IMPORTANT: Your entire response must be ONLY the JSON object. No explanation, no markdown, no code fences."
    : "";

  const prompt = `You are a job notification assistant. Given a job posting and a list of friends, do two things:

1. Extract the job details as JSON.
2. For each friend with notify=true, decide if this job is relevant (score 0.0–1.0). If score >= ${config.RELEVANCE_THRESHOLD}, draft a short casual message (2–3 sentences) as if the user is texting the friend. The message should mention why it fits them specifically.

Friends list:
${JSON.stringify(activeFriends, null, 2)}

Job posting text:
${jobText}

${strictInstruction}
Respond ONLY with valid JSON in exactly this shape:
{
  "job": { "title": "", "company": "", "skills": [], "level": "", "location": "", "remote": false },
  "matches": [{ "name": "", "score": 0.0, "message": "" }]
}
Only include friends with score >= ${config.RELEVANCE_THRESHOLD} in matches. Do not include any text outside the JSON.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: config.MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (!retry) return callClaude(jobText, config, true);
    throw new Error("Response was not valid JSON after retry.");
  }
  return parsed;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Job Notifier installed.");
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'analyze') return;

  port.onMessage.addListener(async msg => {
    if (msg.type !== 'ANALYZE_JOB') return;
    try {
      await loadFriends();
      const result = await callClaude(msg.jobText, msg.config);
      result.matches = (result.matches || []).map(match => {
        const friend = friends.find(f => f.name === match.name);
        return { ...match, contact: friend?.contact || '' };
      });
      port.postMessage({ ok: true, result });
    } catch (e) {
      port.postMessage({ ok: false, error: e.message });
    }
  });
});
