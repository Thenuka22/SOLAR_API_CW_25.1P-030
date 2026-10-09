// The landing page a browser gets at "/". One self-contained HTML document: inline CSS, no
// build step. The animated background is a Spline scene loaded from its CDN, only on screens
// wider than 900px where it shows beside the text; phones and tablets, and any screen where it
// fails to load, get the plain light background.
//
// `checks` is a list of { title, detail, healthy } rows for the status card.

const SPLINE_VIEWER = 'https://unpkg.com/@splinetool/viewer@1.12.70/build/spline-viewer.js';
const PORTFOLIO = 'https://itkannagara.dev';
const SPLINE_SCENE ='https://prod.spline.design/20jpRUaCuLM5JX8q/scene.splinecode';

function renderHome(checks) {
  const allHealthy = checks.every((check) => check.healthy);
  const rows = checks.map(({ title, detail, healthy }) => `
          <li class="row">
            <span class="dot ${healthy ? '' : 'down'}"></span>
            <span class="row-text"><strong>${title}</strong><small>${detail}</small></span>
            <span class="badge ${healthy ? '' : 'down'}">${healthy ? 'Healthy' : 'Unavailable'}</span>
          </li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Real-Time Solar Generation Data API</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --ink: #0a0a0a; --muted: #5c5c5c; --lime: #c8f560; --panel: #121212; --line: rgba(255, 255, 255, 0.09); }
    html, body { height: 100%; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f7f7f7; color: var(--ink); overflow-x: hidden;
    }
    .hero { position: relative; min-height: 100vh; min-height: 100svh; display: flex; align-items: center; overflow: hidden; }
    /* The scene is drawn bright on dark; inverted, it becomes grey on white. */
    .scene {
      position: absolute; top: 0; bottom: 0; left: 28%; width: 95%; z-index: 0; pointer-events: none;
      filter: invert(1) hue-rotate(180deg); transform: scale(1.05);
    }
    /* Keeps the text on the left readable where the scene passes behind it. */
    .hero::after {
      content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
      background: linear-gradient(90deg, #f7f7f7 0%, rgba(247, 247, 247, 0.92) 32%, rgba(247, 247, 247, 0) 58%);
    }
    .scene spline-viewer { width: 100%; height: 100%; display: block; }
    .wrap {
      position: relative; z-index: 1; width: 100%; max-width: 1200px; margin: 0 auto; padding: 64px 24px;
      display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 48px; align-items: center;
    }
    .wrap > * { min-width: 0; }
    .eyebrow { font-size: 0.78rem; font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 22px; }
    h1 { font-size: clamp(2.6rem, 6vw, 4.6rem); font-weight: 800; line-height: 1.04; letter-spacing: -0.035em; margin-bottom: 26px; }
    .lead { font-size: 1.12rem; line-height: 1.6; color: var(--muted); max-width: 440px; margin-bottom: 34px; }
    .button {
      display: inline-block; background: var(--ink); color: #fff; text-decoration: none;
      font-weight: 600; font-size: 0.95rem; padding: 15px 28px; border: 1px solid var(--ink);
      transition: background 0.2s, color 0.2s;
    }
    .button:hover, .button:focus-visible { background: #fff; color: var(--ink); }
    .stage { position: relative; display: flex; justify-content: center; }
    /* Faint grid behind the card. */
    .stage::before {
      content: ''; position: absolute; inset: -56px -40px; z-index: -1;
      background-image: linear-gradient(rgba(0, 0, 0, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 0, 0, 0.05) 1px, transparent 1px);
      background-size: 28px 28px;
      mask-image: radial-gradient(closest-side, #000 55%, transparent);
      -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent);
    }
    /* The card and its toast; the toast is placed against the card, not the column. */
    .device { position: relative; width: 100%; max-width: 440px; }
    .card {
      width: 100%; max-width: 440px; background: var(--panel); color: #fff; border-radius: 16px;
      padding: 22px 26px 12px; box-shadow: 0 30px 70px rgba(0, 0, 0, 0.28);
      background-image: radial-gradient(120% 80% at 10% 0%, rgba(200, 245, 96, 0.12), transparent 60%);
    }
    .card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
    .lights { display: flex; gap: 6px; }
    .lights span { width: 7px; height: 7px; border-radius: 50%; background: #555; }
    .live {
      display: inline-flex; align-items: center; gap: 8px; font-size: 0.8rem; font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 999px; padding: 6px 14px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 0 5px rgba(200, 245, 96, 0.16); flex: none; }
    .dot.down { background: #ff6b6b; box-shadow: 0 0 0 5px rgba(255, 107, 107, 0.16); }
    .card-head { display: flex; align-items: center; gap: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
    .logo {
      width: 62px; height: 62px; border-radius: 6px; background: var(--lime); color: var(--ink);
      display: flex; align-items: center; justify-content: center; gap: 2px; font-weight: 800; font-size: 1.5rem; flex: none;
    }
    .card-head h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 4px; }
    .card-head p { font-size: 0.9rem; color: #b5b5b5; }
    ul { list-style: none; }
    .row { display: flex; align-items: center; gap: 16px; padding: 15px 4px; border-bottom: 1px solid var(--line); }
    .row:last-child { border-bottom: 0; }
    .row-text { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .row-text strong { font-size: 0.95rem; font-weight: 600; }
    .row-text small { font-size: 0.82rem; color: #a8a8a8; overflow-wrap: anywhere; }
    .badge { flex: none; font-size: 0.78rem; font-weight: 500; color: var(--lime); background: #262626; border-radius: 4px; padding: 7px 12px; }
    .badge.down { color: #ff9c9c; }
    .toast {
      position: absolute; right: -28px; bottom: -52px; background: #fff; color: var(--ink); border-radius: 6px;
      padding: 14px 20px 14px 16px; display: flex; align-items: center; gap: 14px; box-shadow: 0 18px 40px rgba(0, 0, 0, 0.14);
    }
    .tick { width: 32px; height: 32px; border-radius: 50%; background: #dff5b4; display: grid; place-items: center; color: #2f7d1f; font-weight: 800; }
    .toast strong { display: block; font-size: 0.85rem; }
    .toast small { font-size: 0.75rem; color: var(--muted); }
    .author {
      position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 1;
      display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
      font-size: 0.92rem; font-weight: 700; letter-spacing: -0.02em; color: var(--ink); text-decoration: none;
      opacity: 0.75; transition: opacity 0.2s;
    }
    .author:hover, .author:focus-visible { opacity: 1; }
    @media (max-width: 900px) {
      .wrap { grid-template-columns: 1fr; gap: 56px; padding: 56px 24px 96px; }
      .lead { max-width: 560px; }
      .stage { justify-content: flex-start; }
      .device { max-width: 520px; }
      .toast { right: 16px; bottom: -44px; }
    }
    @media (max-width: 600px) {
      .hero { align-items: flex-start; }
      .wrap { gap: 36px; padding: 40px 16px 76px; }
      .eyebrow { font-size: 0.7rem; letter-spacing: 0.14em; margin-bottom: 16px; }
      h1 { font-size: clamp(2.1rem, 10vw, 2.8rem); margin-bottom: 18px; }
      .lead { font-size: 1rem; margin-bottom: 26px; }
      .button { display: block; text-align: center; }
      .stage::before { display: none; }
      .card { padding: 18px 16px 6px; border-radius: 14px; }
      .card-top { margin-bottom: 14px; }
      .card-head { gap: 14px; padding-bottom: 16px; }
      .logo { width: 50px; height: 50px; font-size: 1.25rem; }
      .card-head h2 { font-size: 1.08rem; }
      .card-head p { font-size: 0.85rem; }
      .row { gap: 12px; padding: 13px 0; }
      .row-text strong { font-size: 0.9rem; }
      .row-text small { font-size: 0.78rem; }
      .badge { padding: 6px 9px; font-size: 0.72rem; }
      /* In the page flow below the card, so it never covers a status row. */
      .toast { position: static; margin-top: 14px; }
      .author { bottom: 18px; }
    }
  </style>
</head>
<body>
  <main class="hero">
    <div class="scene" aria-hidden="true"></div>
    <div class="wrap">
      <section>
        <p class="eyebrow">Real-Time Solar Generation Data API</p>
        <h1>Your Functions are up and running.</h1>
        <p class="lead">The API endpoints for solar generation readings, installations, and district summaries are deployed and ready to use.</p>
        <a class="button" href="/api-docs">View Endpoints</a>
      </section>
      <section class="stage" aria-label="Service status">
        <div class="device">
        <div class="card">
          <div class="card-top">
            <div class="lights"><span></span><span></span><span></span></div>
            <span class="live"><span class="dot ${allHealthy ? '' : 'down'}"></span>${allHealthy ? 'Live' : 'Degraded'}</span>
          </div>
          <div class="card-head">
            <div class="logo">{<svg width="18" height="24" viewBox="0 0 18 24" aria-hidden="true"><path d="M11 0 0 14h7l-2 10L18 9h-8z" fill="currentColor"/></svg>}</div>
            <div>
              <h2>${allHealthy ? 'Functions Online' : 'Functions Degraded'}</h2>
              <p>${allHealthy ? 'All systems operational' : 'Some checks are failing'}</p>
            </div>
          </div>
          <ul>${rows}
          </ul>
        </div>
        <div class="toast">
          <span class="tick">&#10003;</span>
          <span><strong>Deploy Complete</strong><small>The API is running on version 1.0.</small></span>
        </div>
        </div>
      </section>
    </div>
    <a class="author" href="${PORTFOLIO}" target="_blank" rel="noopener">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
      I T Kannangara
    </a>
  </main>
  <script>
    // The 3D scene is several megabytes of WebGL; load it only where it is shown.
    if (window.matchMedia('(min-width: 901px)').matches) {
      const viewer = document.createElement('script');
      viewer.type = 'module';
      viewer.src = '${SPLINE_VIEWER}';
      document.head.append(viewer);
      const scene = document.createElement('spline-viewer');
      scene.setAttribute('url', '${SPLINE_SCENE}');
      document.querySelector('.scene').append(scene);
    }
  </script>
</body>
</html>
`;
}

module.exports = { renderHome };
