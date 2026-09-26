// A cross-document view transition snapshots the incoming page at its first
// paint, but React mounts the nav a task later — without this the pinned nav has
// nothing to morph into and flashes. Awaiting in pagereveal holds the capture.
addEventListener('pagereveal', async e => {
  if (!e.viewTransition || document.querySelector('.nav')) return;
  await new Promise(done => {
    const obs = new MutationObserver(() => {
      if (!document.querySelector('.nav')) return;
      obs.disconnect();
      done();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Never hold the page hostage to a mount that isn't coming.
    setTimeout(() => { obs.disconnect(); done(); }, 300);
  });
});
