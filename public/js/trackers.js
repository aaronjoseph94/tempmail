/* Who is watching, and what follows you home.
 *
 * Two lists and no cleverness. A tracking pixel is a remote image whose only
 * job is to report that a message was opened, and the company behind it is
 * knowable from the host it loads from; a tracking parameter is a name that
 * identifies a person rather than a page. Both are matters of fact, so they are
 * written down rather than guessed at.
 *
 * Neither list has to be complete to be worth having. The images are blocked
 * whether or not this file recognises them -- that is the message frame's CSP
 * doing its job -- and this only decides whether the app can put a name to one.
 */

/** Host suffix to the company behind it. Longest match wins. */
const TRACKER_HOSTS = {
  "list-manage.com": "Mailchimp",
  "mailchimp.com": "Mailchimp",
  "mcusercontent.com": "Mailchimp",
  "sendgrid.net": "SendGrid",
  "sendgrid.com": "SendGrid",
  "sparkpostmail.com": "SparkPost",
  "mailgun.org": "Mailgun",
  "mandrillapp.com": "Mailchimp",
  "postmarkapp.com": "Postmark",
  "customeriomail.com": "Customer.io",
  "braze.com": "Braze",
  "iterable.com": "Iterable",
  "klaviyomail.com": "Klaviyo",
  "klaviyo.com": "Klaviyo",
  "hubspot.com": "HubSpot",
  "hubspotemail.net": "HubSpot",
  "hs-sites.com": "HubSpot",
  "marketo.com": "Marketo",
  "mktoresp.com": "Marketo",
  "pardot.com": "Salesforce",
  "exacttarget.com": "Salesforce",
  "salesforce.com": "Salesforce",
  "eloqua.com": "Oracle",
  "en25.com": "Oracle",
  "responsys.net": "Oracle",
  "sailthru.com": "Sailthru",
  "cheetahmail.com": "Cheetah Digital",
  "mixpanel.com": "Mixpanel",
  "segment.com": "Segment",
  "segment.io": "Segment",
  "amplitude.com": "Amplitude",
  "branch.io": "Branch",
  "appsflyer.com": "AppsFlyer",
  "adjust.com": "Adjust",
  "doubleclick.net": "Google",
  "google-analytics.com": "Google",
  "googletagmanager.com": "Google",
  "facebook.com": "Meta",
  "fbcdn.net": "Meta",
  "linkedin.com": "LinkedIn",
  "licdn.com": "LinkedIn",
  "twitter.com": "X",
  "t.co": "X",
  "tiktok.com": "TikTok",
  "snapchat.com": "Snap",
  "pinterest.com": "Pinterest",
  "bat.bing.com": "Microsoft",
  "clicktale.net": "Contentsquare",
  "hotjar.com": "Hotjar",
  "fullstory.com": "FullStory",
  "intercom.io": "Intercom",
  "getresponse.com": "GetResponse",
  "constantcontact.com": "Constant Contact",
  "rs6.net": "Constant Contact",
  "aweber.com": "AWeber",
  "convertkit-mail.com": "Kit",
  "substack.com": "Substack",
  "beehiiv.com": "beehiiv",
  "ctrk.klclick.com": "Klaviyo",
};

/** Paths that only ever belong to an open-tracker. */
const TRACKER_PATHS = /(^|\/)(open|opened|pixel|track|tracking|beacon|imp|impression|o\.gif|wf\/open|t\.gif|q\.gif)(\/|\.|$)/i;

/**
 * Parameters that identify the person rather than the page.
 *
 * Apple's Link Tracking Protection is the model: strip what follows someone
 * around and leave everything else exactly as the sender wrote it, because a
 * link that has been over-cleaned is a broken link and that is worse.
 */
const STRIP_EXACT = new Set([
  "fbclid", "gclid", "gbraid", "wbraid", "dclid", "msclkid", "twclid", "ttclid", "igshid",
  "yclid", "rb_clickid", "s_kwcid", "mc_eid", "mc_cid", "mkt_tok", "_hsenc", "_hsmi",
  "vero_id", "vero_conv", "oly_enc_id", "oly_anon_id", "ck_subscriber_id", "sc_cid",
  "epik", "_openstat", "wickedid", "hsa_cam", "hsa_grp", "hsa_mt", "hsa_src", "hsa_ad",
  "hsa_acc", "hsa_net", "hsa_kw", "hsa_tgt", "hsa_ver", "spm", "scm", "trk", "trkCampaign",
  "ml_subscriber", "ml_subscriber_hash", "pk_vid", "guccounter", "cmpid", "ncid",
]);

/** Whole families of them. */
const STRIP_PREFIX = ["utm_", "pi_", "at_", "hmb_", "ir_", "ef_id", "wt_", "elq"];

/**
 * Hosts that wrap a real link, paired with the parameter holding it.
 *
 * Unwrapping only ever reads the URL that is already in front of us. Following
 * a redirect to find out where it goes would be the tracking hit this feature
 * exists to avoid, and would do it from the owner's own Worker.
 */
const UNWRAP_PARAMS = ["url", "u", "target", "redirect", "redirect_url", "redirecturl", "destination", "dest", "link", "r", "ct"];

/** The company behind a host, or null. */
export function trackerCompany(host) {
  const lower = (host || "").toLowerCase();
  let best = null;
  for (const suffix of Object.keys(TRACKER_HOSTS)) {
    if (lower === suffix || lower.endsWith("." + suffix)) {
      if (!best || suffix.length > best.length) best = suffix;
    }
  }
  return best ? TRACKER_HOSTS[best] : null;
}

/**
 * Whether this image exists to report that the message was opened.
 *
 * A known tracking host counts on its own. Otherwise it takes a give-away
 * shape: an image one pixel across, or a path that is only ever an open-tracker.
 */
export function looksLikeTracker(url, width, height) {
  if (trackerCompany(url.hostname)) return true;
  const tiny = (value) => value !== null && value !== "" && Number(value) <= 1;
  if (tiny(width) && tiny(height)) return true;
  return TRACKER_PATHS.test(url.pathname);
}

/** Whether a parameter name is about the person rather than the page. */
export function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return STRIP_EXACT.has(lower) || STRIP_PREFIX.some((prefix) => lower.startsWith(prefix));
}

/**
 * The real destination of a wrapped link, or null.
 *
 * Only unwraps when the wrapper's own parameter holds an absolute http(s) URL,
 * and only one hop: a chain is a sign of something stranger than a mailing
 * list, and following it invites exactly the loop this is trying to avoid.
 */
export function unwrap(url) {
  for (const name of UNWRAP_PARAMS) {
    const raw = url.searchParams.get(name);
    if (!raw || raw.length < 12) continue;
    let candidate;
    try {
      candidate = new URL(raw);
    } catch {
      continue;
    }
    if (candidate.protocol !== "https:" && candidate.protocol !== "http:") continue;
    if (candidate.hostname === url.hostname) continue;
    return candidate;
  }
  return null;
}

/**
 * Cleans one link. Returns the URL to use and what was done to it.
 *
 * Anything that cannot be parsed is left exactly as it was: a mailto:, an
 * anchor, a relative path, or something malformed. Rewriting a link the sender
 * meant is a worse outcome than leaving a parameter on it.
 */
export function cleanLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  let unwrapped = false;
  const real = unwrap(url);
  if (real) {
    url = real;
    unwrapped = true;
  }

  let stripped = 0;
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) {
      url.searchParams.delete(name);
      stripped++;
    }
  }
  return { url, unwrapped, stripped, host: url.hostname.replace(/^www\./, "") };
}
