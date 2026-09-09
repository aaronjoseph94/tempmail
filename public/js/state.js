/* Shared state, the preference keys and the localStorage wrapper. */

/* ------------------------------------------------------------------ state */

export const PAGE_SIZE = 50;
export const MAX_WINDOW = 500;       // the API's own page-size ceiling
export const POLL_VISIBLE_MS = 8000;
export const POLL_HIDDEN_MS = 30000;
export const POLL_LIVE_MS = 60000;        // with a live socket the poll is only a backstop
export const CACHE_KEY = "cache_v3";

export const state = {
  config: null,          // GET /api/config
  mailDomain: "",        // the default domain, shown after the @
  mailDomains: [],       // every domain this inbox offers, default first
  address: "",           // generated local part, e.g. "quiet-otter-42"
  messages: [],
  addresses: [],
  box: "inbox",          // which mailbox: inbox | screener | junk
  boxCounts: {},         // how much is waiting in the boxes that are not the inbox
  addressesTruncated: false, // the address list hit its ceiling; older ones are not shown
  filter: "",            // address being viewed; "" is all mail
  candidate: "",         // the local part the new-inbox sheet is offering
  query: "",             // search text
  servedQuery: null,     // the query state.messages was actually fetched with
  hasMore: false,
  nextCursor: null,
  windowSize: PAGE_SIZE, // how many messages the list holds and each poll refreshes
  open: null,            // full message object in the viewer
  prepared: null,        // the open message's cleaned body, trackers and links
  showHtml: true,
  imagesAllowed: false,
  newestSeen: 0,         // receivedAt of the newest mail seen; newer than this is "new"
  leaksSeen: 0,          // the newest leak the Leaks view has shown; newer than this is unseen
  polledOnce: false,
  pollTimer: null,
  feedSig: "",
  railSig: "",
  lastFeedRender: 0,
  sound: true,
  notify: false,
  autoRefresh: true,
  view: "all",             // all | unread | starred | leaks
  waiting: null,           // { address, since } while the code overlay is up
  push: false,             // this browser is subscribed to pushes
  selecting: false,
  picked: new Set(),
  alwaysImages: false,
  cleanLinks: true,      // strip follow-me parameters and unwrap redirects
};

/** Preference keys kept per device rather than on the server. */
export const PREFS = {
  sound: "sound", notify: "notify", autoRefresh: "auto_refresh",
  images: "always_images", cleanLinks: "clean_links", address: "address", theme: "theme", push: "push",
  scheme: "scheme", leaksSeen: "leaks_seen",
};

/* Accent presets. Every one is contrast-checked against c1 through c5 in both
   themes; the values live in style.css under [data-scheme]. "mono" is the
   default and carries no attribute -- it is the achromatic accent the tokens
   already declare. */
export const SCHEMES = ["mono", "indigo", "emerald", "amber", "rose", "cyan"];

/** Lifecycles a generated address can be given, keyed by the picker's value. */
export const ROLL_MODES = {
  permanent: { mode: "permanent" },
  "24h": { mode: "expires", ttlHours: 24 },
  "7d": { mode: "expires", ttlHours: 24 * 7 },
};
