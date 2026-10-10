/** Public information only. Never reads a guest vault or starts an OAuth flow. */
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

export const PUBLIC_PAGE_PATHS = [
  "/",
  "/support",
  "/privacy",
  "/terms",
] as const;
type PagePath = (typeof PUBLIC_PAGE_PATHS)[number];
const updated = "10 October 2026";
const titles: Record<PagePath, string> = {
  "/": "Private shopping baskets, without another account",
  "/support": "Help with Basket Wise",
  "/privacy": "Privacy policy",
  "/terms": "Terms of service",
};

export function publicContact(
  value?: string,
): { href: string; label: string } | undefined {
  if (
    !value ||
    value.length > 1024 ||
    /[\s\u0000-\u001f\u007f<>"'\\]/.test(value)
  )
    return;
  if (
    /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      value,
    )
  )
    return {
      href: `mailto:${encodeURIComponent(value).replace(/%40/g, "@")}`,
      label: value,
    };
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.hostname.includes(".")
    )
      return { href: url.href, label: "Open the support contact form" };
  } catch {
    /* An invalid contact keeps the public pages disabled. */
  }
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#294f3e"/><path d="M161 207 213 131M351 207 299 131" fill="none" stroke="#e4edbd" stroke-width="27" stroke-linecap="round"/><path d="M107 214h298l-34 156c-4 19-17 29-36 29H177c-19 0-32-10-36-29Z" fill="#fafaf6"/><path d="M101 213h310" fill="none" stroke="#fafaf6" stroke-width="29" stroke-linecap="round"/><path d="m195 302 43 43 86-92" fill="none" stroke="#294f3e" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const css = `
:root{color-scheme:light;--ink:#243b30;--green:#294f3e;--muted:#5d6d63;--paper:#fafaf6;--line:#d9dfd5;--lime:#e4edbd;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper);font-synthesis:none}
*{box-sizing:border-box}body{margin:0}a{color:var(--green);text-underline-offset:.2em}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid #657d26;outline-offset:5px}p,li{line-height:1.75}p{margin:0 0 1.25rem}h1,h2,h3{line-height:1.1;text-wrap:balance}h1,h2{font-family:Georgia,"Times New Roman",serif;font-weight:400;letter-spacing:-.045em}h1{font-size:clamp(2.6rem,6vw,5.6rem);margin:0 0 1.5rem}h2{font-size:clamp(1.8rem,3.3vw,2.65rem);margin:2.4rem 0 1rem}h3{font-size:1.05rem;margin:1.5rem 0 .6rem}ul,ol{padding-left:1.4rem}li+li{margin-top:.7rem}strong{font-weight:650}.wrap{max-width:1160px;margin:0 auto;padding:0 32px}.skip{position:absolute;left:1rem;top:-100px;background:white;padding:1rem;z-index:4}.skip:focus{top:1rem}.site-header{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:110px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:1.25rem;font-weight:650;letter-spacing:-.04em}.brand img{width:42px;height:42px}.nav{display:flex;flex-wrap:wrap;gap:12px 26px;font-size:.9rem}.nav a{text-decoration:none;padding:8px 0}.nav a[aria-current=page]{text-decoration:underline;font-weight:650}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:.76rem;font-weight:700;color:var(--muted);margin-bottom:1.25rem}.hero{display:grid;grid-template-columns:1.25fr .75fr;gap:70px;align-items:center;padding:80px 0 70px}.hero h1{max-width:720px}.intro{font-size:1.15rem;color:var(--muted);max-width:650px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 21px;background:var(--green);color:var(--paper);border-radius:999px;text-decoration:none;font-weight:600;margin:8px 12px 8px 0}.button.secondary{background:transparent;color:var(--green);box-shadow:inset 0 0 0 1px var(--line)}.sample{background:var(--green);color:var(--paper);padding:34px;border-radius:8px;box-shadow:16px 16px 0 var(--lime)}.sample .eyebrow{color:#d0dec8}.sample h2{margin:0 0 24px;color:var(--paper);font-size:2.25rem}.sample dl{margin:0}.sample .row{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #ffffff38;padding:13px 0}.sample dt,.sample dd{margin:0}.sample .total{border-bottom:0;font-size:1.3rem;font-weight:600;padding-top:23px}.small{font-size:.82rem;line-height:1.6;color:var(--muted)}.sample .small{color:#d0dec8;margin-top:25px;margin-bottom:0}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;padding:27px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.facts strong{display:block;margin-bottom:.35rem}.facts p{font-size:.9rem;margin:0;color:var(--muted)}.section{max-width:760px;padding:32px 0}.steps{list-style:none;padding:0;counter-reset:steps}.steps li{counter-increment:steps;position:relative;padding:0 0 24px 54px}.steps li:before{content:counter(steps);position:absolute;left:0;top:0;width:32px;height:32px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:.85rem}.steps li strong{display:block;margin-bottom:.3rem}.notice{background:#eef1e8;border-left:3px solid var(--green);padding:23px 26px;margin:24px 0}.notice p:last-child{margin-bottom:0}.document{max-width:780px;padding:65px 0 60px}.document h1{font-size:clamp(2.8rem,5vw,4.3rem)}.document .intro{font-size:1.05rem}.document h2{font-size:1.95rem;margin-top:2.7rem}.toc{display:flex;flex-wrap:wrap;gap:12px 20px;font-size:.85rem;border-block:1px solid var(--line);padding:18px 0;margin:26px 0}.contact{background:var(--lime);padding:26px;border-radius:6px;overflow-wrap:anywhere}.contact h2{margin:0 0 1rem}.contact a{font-weight:650}.contact p:last-child{margin-bottom:0}details{border-bottom:1px solid var(--line);padding:20px 0}summary{cursor:pointer;font-weight:600;line-height:1.5}details p{margin:14px 0 0}.site-footer{border-top:1px solid var(--line);padding:30px 0 40px;display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.site-footer p{font-size:.82rem;color:var(--muted);margin:0}.site-footer nav{display:flex;gap:18px;flex-wrap:wrap;font-size:.82rem}.preview{padding:12px 24px;background:#fff0cf;border-bottom:1px solid #bd9646;text-align:center;font-size:.85rem;color:#60450c}.contact-pending{font-weight:600}
@media(max-width:750px){.wrap{padding:0 22px}.site-header{align-items:flex-start;flex-direction:column;justify-content:center;gap:12px;padding:24px 0}.nav{gap:12px 22px}.hero{grid-template-columns:1fr;gap:36px;padding:48px 0}.sample{max-width:420px;margin-right:12px}.facts{grid-template-columns:1fr;gap:22px}.document{padding-top:44px}.site-footer{flex-direction:column}.section{padding-top:15px}h1{font-size:3.15rem}}@media(prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}`;

function contactSection(
  contact: ReturnType<typeof publicContact>,
  privacy = false,
) {
  return `<section class="contact" id="contact"><h2>${privacy ? "Privacy questions" : "Contact support"}</h2><p>${contact ? `<a href="${escape(contact.href)}" rel="noreferrer noopener">${escape(contact.label)}</a>` : '<span class="contact-pending">Public contact awaiting publisher confirmation.</span>'}</p><p class="small">Never send recovery keys, access tokens, passwords, or payment details. Include only what is needed to explain your request.</p></section>`;
}

function home() {
  return `<section class="hero"><div><p class="eyebrow">A little clarity for your next shop</p><h1>Your basket.<br>Your numbers.<br>No extra account.</h1><p class="intro">Keep track of supermarket trips, item totals, and your personal spending thresholds — from Basket Wise in ChatGPT.</p><a class="button" href="#connect">How to get started</a><a class="button secondary" href="/privacy">How privacy works</a></div><aside class="sample" aria-label="Illustrative basket, not saved data"><p class="eyebrow">An example, not a saved basket</p><h2>The weekly shop</h2><dl><div class="row"><dt>Apples · 2 × €1.25</dt><dd>€2.50</dd></div><div class="row"><dt>Milk · 1 × €1.99</dt><dd>€1.99</dd></div><div class="row total"><dt>Basket total</dt><dd>€4.49</dd></div></dl><p class="small">You provide the prices. Basket Wise keeps the arithmetic in integer currency units.</p></aside></section><section class="facts" aria-label="The essentials"><div><strong>No separate login</strong><p>Connect a guest space through ChatGPT. No Basket Wise email or password is required.</p></div><div><strong>One connected space</strong><p>The widget and chat tools work with the same guest trips.</p></div><div><strong>24 hours of inactivity</strong><p>Basket data expires after a day without a new successful basket action. The shopping list and profile last 90 inactive days.</p></div></section><section class="section" id="connect"><p class="eyebrow">Getting started</p><h2>A guest space, with a key to keep.</h2><ol class="steps"><li><strong>Open Basket Wise in ChatGPT.</strong>Use your available Basket Wise connection. This website explains the service; it does not create or open a guest space.</li><li><strong>Connect on the Basket Wise authorization page.</strong>Choose a new guest space or recover an existing one. Save the recovery key privately, outside chat, before continuing.</li><li><strong>Add your trip and prices.</strong>Use the widget or ask in chat. Check the store, currency, quantities, and prices before saving changes.</li></ol><div class="notice"><p><strong>Temporary by design.</strong>New foreground basket actions renew both windows; list actions renew only the 90-day profile window. Displaying a saved widget, refreshing authorization, retries, and recovery do not. Expired or deleted trips cannot be recovered.</p></div></section><section class="section"><h2>Know what it does — and what it doesn’t.</h2><p>Track your own prices, exact totals, personal spending thresholds, and item-removal suggestions. Basket Wise does not provide live supermarket prices, verify vouchers, purchase goods, take payments, or send background reminders.</p><p>Need a hand? <a href="/support">Read the support guide.</a></p></section>`;
}

function support(contact: ReturnType<typeof publicContact>) {
  return `<p class="intro">Connection, recovery, and everyday questions. Basket Wise is developed by Yiping Deng.</p><div class="notice"><p><strong>Keep your recovery key private.</strong>Enter it only on the Basket Wise authorization page opened by ChatGPT. Support will not ask you to paste it into an email, support form, or chat.</p></div><h2>Connection and recovery</h2><ol><li>Open your Basket Wise connection in ChatGPT and start its connection or reconnection flow.</li><li>To return to an existing guest space, choose recovery on the authorization page and enter the key you saved privately.</li><li>Save the replacement key before confirming. Confirmation replaces the old key and signs out earlier connections.</li><li>Return to ChatGPT and load your basket again. Check the returned trip before making changes.</li></ol><p>Recovery works while the anonymous profile is unexpired, even if its baskets have already expired. It does not restart the inactivity clock. If you leave recovery before confirming, the existing key and connections remain valid.</p><h2>Common questions</h2><details><summary>My guest space expired, or I lost every credential.</summary><p>There is no email or password account to reset. Support cannot recover an expired or deleted space, or bypass a missing recovery key. Create a new guest space if you cannot reconnect.</p></details><details><summary>A change timed out. Should I repeat it?</summary><p>Use the widget’s retry for the pending action when available. It preserves the operation ID so the server can avoid applying the same change twice. If you are unsure what happened, read the current basket before requesting another change.</p></details><details><summary>The basket changed somewhere else.</summary><p>Reload the current trip and reconcile the changes. Basket Wise checks revisions to prevent silent overwrites; do not keep retrying an old edit against a new revision.</p></details><details><summary>How can I delete my trips?</summary><p>Use “Clear baskets” to remove baskets while retaining the shopping list, connection and recovery key. Use “Delete guest identity” to remove both shopping data and credentials. Confirm either action carefully; neither restores deleted baskets.</p></details><details><summary>Does disconnecting ChatGPT delete the guest?</summary><p>No. Disconnecting removes that host connection, not the guest’s stored trips. Basket data expires after 24 inactive hours; the profile and credentials expire after 90 inactive days. Disconnecting does not itself renew or delete either.</p></details><h2>Report a problem</h2><p>Include the approximate time, the action you tried, the visible error, and whether you used the widget or chat. Do not include private shopping details unless necessary, or screenshots containing a recovery key.</p>${contactSection(contact)}`;
}

function privacy(contact: ReturnType<typeof publicContact>) {
  return `<p class="intro">This policy describes the Basket Wise Cloudflare guest service developed by Yiping Deng. It does not describe OpenAI’s separate handling of your ChatGPT conversations.</p><p class="small">Last updated: ${updated}</p><nav class="toc" aria-label="On this page"><a href="#information">Information</a><a href="#purpose">Use and hosting</a><a href="#retention">Retention</a><a href="#choices">Your choices</a><a href="#contact">Contact</a></nav><h2 id="information">Information the service processes</h2><p>Basket Wise receives the structured shopping information sent to its tools: trips, profile-wide shopping-list entries, store and item names, quantities, prices, currencies, personal spending thresholds, notes, and checkout status. It also uses guest and trip identifiers, revisions, timestamps, and request identifiers for authorization, duplicate prevention, and retention.</p><p>No Basket Wise email, password, or named account is required. Guest access uses OAuth credentials and a recovery key. The service stores credential hashes and authorization records; keep the actual credentials private.</p><p>The service does not receive or store photographs or your complete ChatGPT conversation. Only the structured shopping details sent to its tools are processed. Basket Wise does not make separate model API calls.</p><h2 id="purpose">How information is used and hosted</h2><p>Information is used to provide the baskets you request, calculate totals, keep widget and chat changes consistent, authorize access, support recovery, and limit abuse.</p><p>The service runs on Cloudflare Workers. Guest records are stored in Cloudflare Durable Objects. OpenAI sends tool requests and receives tool results as part of ChatGPT. These providers also process network and security information under their own policies.</p><p>Authorization uses a secure, first-party cookie and short-lived server-side flow state to bind the browser and prevent forged requests. It is not an advertising cookie. The application adds no analytics, advertising trackers, or custom request-body logs; Worker observability is disabled in its deployment configuration. Provider infrastructure processing is separate from those application settings.</p><h2 id="retention">Retention and deletion</h2><p><strong>Basket data expires after 24 hours without a successful new foreground basket action. The account-wise shopping list, anonymous profile, recovery-key hash, and OAuth grants expire after 90 days without a new foreground list or basket action. List activity renews only the profile, never basket retention.</strong>New intentional reads and changes count as activity. Token refresh, recovery, merely displaying a saved widget, failed requests, and retries do not extend either deadline. An explicit new open request counts as foreground activity for its list or basket.</p><p>Expired baskets are inaccessible even if cleanup is delayed; the same authorized connection can start fresh. At 90 inactive days, profile credentials are rejected even if cleanup is delayed. Access checks, alarms and scheduled cleanup purge expired trips, current-trip pointers and shopping snapshots. Minimal hashed replay records (request ID, fingerprint and expiry, not item contents) and clear-operation receipts remain for up to 90 days to prevent delayed retries recreating data. The list and its content-free idempotency receipts remain until profile expiry. Explicit guest deletion removes the guest’s list, trips and credentials from active storage without waiting for inactivity expiry.</p><p>Authorization flow state expires separately, normally after ten minutes. OAuth application-client registrations hold configuration and credential hashes rather than shopping records; they remain valid for the ChatGPT connection and are not deleted when baskets or profiles expire. Registration capacity is bounded. They do not keep an expired guest accessible.</p><div class="notice"><p><strong>Active storage and infrastructure copies are different.</strong>Application expiry is not a promise that every provider backup or operational record is erased at the same instant. Cloudflare operates its infrastructure and backup systems separately. Its SQLite Durable Object point-in-time recovery can retain earlier database states for up to 30 days; the 24-hour rule is an application-access and active-storage rule, not a guarantee of immediate erasure of every backup. Basket Wise provides no workflow to restore an expired or deleted guest space.</p></div><p>Your ChatGPT history is not erased by deleting a Basket Wise guest. Manage it through OpenAI’s controls. Messages you choose to send to support are also separate from guest-vault storage and do not follow its automatic 24-hour deadline.</p><h2 id="choices">Your choices and requests</h2><p>Provide only what your basket needs. Correct or remove items through the connected tools, clear baskets while retaining your list and profile, or explicitly delete the whole guest identity. Disconnecting ChatGPT alone is not a request to erase the guest’s records.</p><p>Use the contact below for privacy questions or requests about access, correction, or deletion. Do not send credentials. Because the service has no named accounts, an email address alone cannot identify a guest space or prove ownership. Support cannot bypass guest authorization or reconstruct lost credentials.</p><p>OpenAI’s and Cloudflare’s own privacy policies apply to their separate services and infrastructure: <a href="https://openai.com/policies/privacy-policy/" rel="noreferrer noopener">OpenAI privacy policy</a> and <a href="https://www.cloudflare.com/privacypolicy/" rel="noreferrer noopener">Cloudflare privacy policy</a>.</p>${contactSection(contact, true)}`;
}

function terms(contact: ReturnType<typeof publicContact>) {
  return `<p class="intro">These terms describe use of the Basket Wise guest shopping service developed by Yiping Deng.</p><p class="small">Last updated: ${updated}</p><h2>A shopping record, not a seller</h2><p>Basket Wise records shopping information and calculates totals from the prices, quantities, and currencies you provide. It is not a supermarket, payment service, voucher issuer, or food-safety authority. It does not process purchases, subscriptions, or payments.</p><p>Check the prices, quantities, and results against your receipts. Personal spending thresholds are not evidence of voucher eligibility. Removal suggestions are advisory and do not change your basket unless you confirm the items to remove.</p><h2>Temporary guest storage</h2><p>Your basket data expires after 24 hours without a successful new foreground basket action. Keep a separate copy of anything you need beyond that period. Basket Wise is not a permanent record-keeping or reminder service.</p><p>Keep your recovery key private. The shopping list and profile expire after 90 days without a new foreground list or basket action. The list survives basket expiry; list-only activity does not extend basket retention. Recovery requires an unexpired profile and a valid recovery key; it cannot restore expired baskets. Confirming a replacement key revokes earlier connections. Support cannot bypass this requirement, recover a lost key, or restore expired or deleted trips.</p><h2>Authorized use</h2><p>Use only guest spaces you are authorized to access. Do not share recovery credentials, attempt to access another person’s records, interfere with the service, or bypass request and storage limits. Limits may prevent further actions.</p><p>Confirm destructive actions carefully. Deleting the guest space removes all its list entries, trips and credentials from active storage, and there is no recovery-key undo.</p><h2>Availability and other services</h2><p>Connections can expire, fail, or be interrupted. Re-read the current basket after an uncertain result and before changing shared data. Do not rely on the service as the only copy of information you need.</p><p>Your use of ChatGPT and Cloudflare-hosted infrastructure is also subject to the relevant providers’ terms. These terms do not replace the terms of a supermarket purchase.</p><h2>Privacy and questions</h2><p>Read the <a href="/privacy">privacy policy</a> for information about guest data, retention, deletion, and provider processing. Contact the publisher with questions about this service or these terms.</p>${contactSection(contact)}`;
}

export function publicPageResponse(
  request: Request,
  contactValue?: string,
  preview = false,
): Response | undefined {
  if (!["GET", "HEAD"].includes(request.method)) return;
  const path = new URL(request.url).pathname;
  if (![...PUBLIC_PAGE_PATHS, "/site.css", "/site-icon.svg"].includes(path))
    return;
  const contact = publicContact(contactValue);
  // Never publish placeholders or a non-working contact to satisfy a listing.
  if (!preview && !contact) return;
  let content: string;
  let contentType: string;
  if (path === "/site.css") {
    content = css;
    contentType = "text/css;charset=utf-8";
  } else if (path === "/site-icon.svg") {
    content = logo;
    contentType = "image/svg+xml";
  } else {
    const pagePath = path as PagePath;
    const body =
      pagePath === "/"
        ? home()
        : pagePath === "/support"
          ? support(contact)
          : pagePath === "/privacy"
            ? privacy(contact)
            : terms(contact);
    content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Basket Wise: private guest shopping baskets, help, privacy, and terms.">${preview ? '<meta name="robots" content="noindex,nofollow">' : ""}<title>${escape(titles[pagePath])} · Basket Wise</title><link rel="stylesheet" href="/site.css"><link rel="icon" href="/site-icon.svg" type="image/svg+xml"></head><body>${preview ? '<div class="preview">Local preview — not published. Contact details are awaiting confirmation.</div>' : ""}<a class="skip" href="#main">Skip to content</a><div class="wrap"><header class="site-header"><a class="brand" href="/"><img src="/site-icon.svg" alt="" width="42" height="42">Basket Wise</a><nav class="nav" aria-label="Main navigation">${PUBLIC_PAGE_PATHS.map((href, index) => `<a href="${href}"${href === path ? ' aria-current="page"' : ""}>${["Home", "Support", "Privacy", "Terms"][index]}</a>`).join("")}</nav></header><main id="main"${pagePath === "/" ? "" : ' class="document"'}>${pagePath === "/" ? "" : `<p class="eyebrow">Basket Wise</p><h1>${titles[pagePath]}</h1>`}${body}</main><footer class="site-footer"><p>Basket Wise · Developed by Yiping Deng<br>Guest shopping data is temporary. Keep your recovery key private.</p><nav aria-label="Footer navigation"><a href="/support">Support</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a></nav></footer></div></body></html>`;
    contentType = "text/html;charset=utf-8";
  }
  return new Response(request.method === "HEAD" ? null : content, {
    headers: {
      "Content-Type": contentType,
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...(preview ? { "X-Robots-Tag": "noindex, nofollow" } : {}),
    },
  });
}
