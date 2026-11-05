// Sandbox side of yt.js solve(): one EJS input in, { result } or { error } out.
// Stateless — yt.js uses a fresh frame per call, because running YouTube's
// player JS can navigate this frame away afterwards.
addEventListener('message', (e) => {
  let out;
  try {
    const r = jsc(e.data); // eslint-disable-line no-undef -- global from yt.solver.core
    out = r.type === 'result' ? { result: r } : { error: r.error ?? r.type };
  } catch (err) {
    out = { error: String(err?.message ?? err) };
  }
  e.source.postMessage(out, '*');
});
