// Service worker — currently a placeholder.
// Phase 2 will use this for badge updates and background sync.
chrome.runtime.onInstalled.addListener(() => {
  console.log("Job Notifier installed.");
});
