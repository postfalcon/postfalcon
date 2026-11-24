// Consent page for an app connecting over OAuth (routes/oauth.js). The decision is sent with
// fetch and the browser then navigates to the app from script: a form POST that redirects to
// another site would be blocked by the CSP's form-action 'self' (same fix as Mastodon connect).
const card = document.getElementById('oauth-consent');
const allowBtn = document.getElementById('oauth-allow');
const denyBtn = document.getElementById('oauth-deny');
const errorEl = document.getElementById('error');

async function decide(approve) {
  allowBtn.disabled = true;
  denyBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await fetch('/api/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify({ request_id: card.dataset.request, approve }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.redirect) {
      if (approve) allowBtn.textContent = 'Connecting…';
      window.location.href = data.redirect;
      return;
    }
    errorEl.textContent = data.message || data.error || 'Something went wrong. Try connecting again from the app.';
  } catch {
    errorEl.textContent = 'Couldn’t reach the server. Check your connection and try again.';
  }
  allowBtn.disabled = false;
  denyBtn.disabled = false;
}

allowBtn.addEventListener('click', () => decide(true));
denyBtn.addEventListener('click', () => decide(false));

// "Log in as someone else": log out, then come back to this same request through the login page.
document.getElementById('oauth-switch').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': await getCsrfToken() } }).catch(() => {});
  window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
});
