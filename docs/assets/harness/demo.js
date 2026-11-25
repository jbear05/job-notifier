// Adds the extension page a shot needs over the demo site: the popup as Chrome
// drops it from the toolbar (#popup), or the overlay frame as content.js adds it
// (#overlay). stub.js in that frame reports when it's ready.
const which = location.hash.slice(1);
if (!which) document.documentElement.dataset.shotReady = 'ok';
else {
  const frame = document.createElement('iframe');
  frame.title = 'Job Notifier';
  frame.className = which;
  frame.src = `../../../${which}.html`;
  addEventListener('message', e => {
    if (e.source !== frame.contentWindow || !e.data.shot) return;
    if (which === 'popup') frame.style.height = `${e.data.height + 2}px`;
    document.documentElement.dataset.shotReady = e.data.shot;
  });
  document.body.append(frame);
}
