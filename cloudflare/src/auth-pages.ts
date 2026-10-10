const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

type FlowFields = { flow: string; csrf: string };
const fields = ({ flow, csrf }: FlowFields) =>
  `<input type="hidden" name="flow" value="${escape(flow)}"><input type="hidden" name="csrf" value="${escape(csrf)}">`;

function page(title: string, content: string, preview = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · Basket Wise</title><link rel="icon" href="/auth-icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/auth.css"></head><body>${preview ? '<div class="preview">Local design preview · sample key only · no live connection or saved data</div>' : ""}<a class="skip" href="#main">Skip to guest access</a><div class="shell"><header><a class="brand" href="/" aria-label="Basket Wise home"><img src="/auth-icon.svg" width="40" height="40" alt=""><span>Basket Wise</span></a><span class="header-note">A little clarity for your next shop.</span></header><main id="main"><section class="intro" aria-labelledby="intro-title"><p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> Your shop. Your space.</p><h1 id="intro-title">Less guessing.<br>More <em>basket wise.</em></h1><p class="lead">A private place for your shopping trips.<br class="desktop-break"> No extra account to remember.</p><div class="facts"><div><span class="fact-number">01</span><p><strong>No email. No password.</strong><span>Connect a guest space to ChatGPT.</span></p></div><div><span class="fact-number">02</span><p><strong>A key to come back.</strong><span>Keep your recovery key somewhere private.</span></p></div><div><span class="fact-number">03</span><p><strong>Temporary by design.</strong><span>Baskets expire after 24 inactive hours. Your shopping list and profile last 90 inactive days.</span></p></div></div><p class="intro-foot">Your widget and chat tools use the same connected space.</p></section><section class="access-card" aria-labelledby="card-title">${content}</section></main><footer><span>Small shops. Clearer numbers.</span><nav aria-label="Help and legal"><a href="/support">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></footer></div></body></html>`;
}

export function authorizationPage(context: FlowFields, preview = false) {
  return page(
    "Connect your guest space",
    `<p class="card-eyebrow">Guest access</p><h2 id="card-title">Make room for<br>your next shop.</h2><p class="card-description">Choose the guest space ChatGPT can view and manage, including its shopping list, trips and items.</p><form method="post" action="/authorize">${fields(context)}<div class="new-space"><button class="button primary" name="decision" value="new" type="submit"><span>Start a new guest space</span><span aria-hidden="true">↗</span></button><p class="hint">A fresh, empty space. No sign-up needed.</p></div><div class="divider"><span>or pick up where you left off</span></div><details class="recovery"><summary><span>Have a recovery key?</span><span class="chevron" aria-hidden="true">+</span></summary><div class="recovery-content"><label for="recovery-key">Your recovery key</label><input id="recovery-key" name="recovery" autocomplete="off" autocapitalize="none" spellcheck="false" type="password" placeholder="Paste your private key" aria-describedby="recovery-help"><p class="hint" id="recovery-help">Reconnect your unexpired profile, even after its baskets have expired. Enter your key only here, never in chat.</p><p class="notice">On the next screen, save and confirm a replacement key. Only then are your old key and earlier connections signed out.</p><button class="button secondary" name="decision" value="recover" type="submit">Recover my guest space <span aria-hidden="true">→</span></button></div></details><div class="card-bottom"><p>Basket data expires after 24 inactive hours; the anonymous profile and key expire after 90 inactive days. Only new foreground basket actions renew these clocks. Recovery does not.</p><button class="text-button" name="decision" value="deny" type="submit">Cancel and return to ChatGPT</button></div></form>`,
    preview,
  );
}

export function recoveryKeyPage(
  context: FlowFields & { recovery: string; replacing: boolean },
  preview = false,
) {
  return page(
    "Save your recovery key",
    `<p class="card-eyebrow">${context.replacing ? "Recover your guest space" : "One last thing"}</p><h2 id="card-title">Save your<br>recovery key.</h2><p class="card-description">Keep it in a password manager or another private place. It is your way back to <strong>this anonymous profile</strong> and any unexpired trips.</p><div class="key-panel"><div class="key-label"><span class="status-dot" aria-hidden="true"></span> Private recovery key</div><pre>${escape(context.recovery)}</pre><p>Anyone with this key can access your space. Never paste it into ChatGPT or send it to support.</p></div>${context.replacing ? '<p class="notice">Your existing key and connections still work. Confirming below activates this replacement and signs out earlier connections.</p>' : ""}<form method="post" action="/continue">${fields(context)}<label class="confirmation"><input type="checkbox" name="saved" value="yes" required><span>I saved the key privately</span></label><button class="button primary" type="submit">Continue to ChatGPT <span aria-hidden="true">↗</span></button></form><p class="card-foot">The key stops working after 90 days without a new foreground basket action, or after guest deletion. Baskets expire separately after 24 inactive hours. Without a working connection or key, access cannot be restored.</p>`,
    preview,
  );
}

export function authorizationErrorPage(code: string) {
  const credential = code === "invalid_credential" || code === "invalid_grant";
  return page(
    "Let’s reconnect",
    `<p class="card-eyebrow">Guest access</p><h2 id="card-title">Let’s try<br>that again.</h2><p class="card-description">${credential ? "This recovery key could not be used. Check the complete key and whether your guest space has expired." : "This connection could not be completed. The request may have expired or is no longer valid."}</p><p class="notice">Return to ChatGPT and open a new Basket Wise connection attempt. Choose recovery if you want your existing trips. Expired or deleted spaces cannot be recovered.</p><a class="button primary" href="https://chatgpt.com/" rel="noreferrer">Return to ChatGPT <span aria-hidden="true">↗</span></a><p class="card-foot">Keep recovery keys out of chat. Need help? <a href="/support">Visit support.</a></p>`,
  );
}

export const authAssetResponse = (
  request: Request,
  styles: string,
): Response | undefined => {
  const path = new URL(request.url).pathname;
  if (!["GET", "HEAD"].includes(request.method)) return;
  const assets: Record<string, [string, string]> = {
    "/auth.css": [styles, "text/css;charset=utf-8"],
    "/auth-icon.svg": [
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="17" fill="#294f3e"/><path d="m21 27 7-10m15 10-7-10" fill="none" stroke="#e4edbd" stroke-width="3.5" stroke-linecap="round"/><path d="M14 28h36l-4 18a4 4 0 0 1-4 3H22a4 4 0 0 1-4-3Z" fill="#fafaf6"/><path d="m24 36 6 6 10-12" fill="none" stroke="#294f3e" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      "image/svg+xml",
    ],
  };
  const asset = assets[path];
  return asset
    ? new Response(request.method === "HEAD" ? null : asset[0], {
        headers: { "Content-Type": asset[1] },
      })
    : undefined;
};
