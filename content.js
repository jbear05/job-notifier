chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GET_PAGE_TEXT") return;

  const text = document.body.innerText || "";
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 3000);

  const looksLikeJobPage = isJobPage(trimmed);

  sendResponse({
    text: trimmed,
    isJobPage: looksLikeJobPage,
    length: trimmed.length
  });

  return true;
});

function isJobPage(text) {
  if (text.length < 200) return false;

  const jobSignals = [
    /\b(job|position|role|opening|opportunity)\b/i,
    /\b(responsibilities|qualifications|requirements|about the role)\b/i,
    /\b(apply|application|candidates)\b/i,
    /\b(salary|compensation|benefits|equity)\b/i,
    /\b(full.?time|part.?time|contract|internship|remote|hybrid|on.?site)\b/i,
    /\b(experience|years|skills|proficiency)\b/i
  ];

  const matches = jobSignals.filter(re => re.test(text));
  return matches.length >= 2;
}
