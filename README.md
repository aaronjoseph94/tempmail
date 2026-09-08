<div align="center">

# AJ's Temp Email

**Your own private catch-all inbox.**

Make up any address at your domain — `whatever@yourdomain.com` — send it mail,
and it shows up in a clean, private inbox seconds later. No per-address setup.
Verification codes are spotted for you. Mail deletes itself after 100 days.

Runs entirely on Cloudflare (Workers + Email Routing + D1). Free plan is plenty.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aaronjoseph94/tempmail)

</div>

---

## What you get

- **Catch-all**: every address at your domain lands in one inbox. Filter by address, name one, or wipe it in a click.
- **Instant inboxes**: **New Inbox** in the sidebar makes a fresh, memorable address (`quiet-otter-42@…`) and copies it for you.
- **Burner addresses**: a new inbox can last forever, a day or a week. Once it expires, mail to it bounces at the door, and you can block any address the same way.
- **Leak detector**: each address remembers the service it was given to. Hear from anyone else and the **Leaks** view names them, one tap from blocking the address.
- **Sender check**: a badge next to the sender says whether Cloudflare's SPF, DKIM and DMARC checks passed, and a strip warns when a link's text, characters or domain are pretending to be something else.
- **One-tap unsubscribe**: when a sender supports one-click unsubscribe, the inbox sends the request for you; otherwise it opens their link.
- **Codes, spotted**: verification codes are detected and shown as a one-click copy chip in the list and the message.
- **Star anything**: starred mail is exempt from the nightly cleanup, so a receipt can sit here indefinitely.
- **Bulk actions**: select several messages to mark read, star or delete them together.
- **Big attachments**: messages up to 25 MB are accepted, and attachments stream back on demand rather than loading with the message.
- **Safe rendering**: HTML mail opens sandboxed with scripts blocked and remote images off until you ask. Inline images work; click one to zoom.
- **Search** across sender, subject, address and preview, plus **unread** and **starred** views and **load older** for long histories.
- **Instant delivery**: open tabs hold a live connection to the Worker and show new mail the moment it lands; polling stays as a backstop.
- **Codes on the lock screen**: turn on push notifications and a verification code arrives as a notification, with the code in the title and a Copy action, even with the app closed. On iPhone, add the site to your Home Screen first.
- **Wait for a code**: tap it before you sign up somewhere, and the next code sent to your address appears full-screen and lands on your clipboard.
- **New-mail alerts**: a quiet chime, desktop notifications, and an unread count in the tab title.
- **Tune the limits**: retention, per-address and total caps, max message size and attachment budget are all editable in Settings.
- **Phone-friendly**: a proper mobile layout, installable as a home-screen app (PWA).
- **Zero-config deploy**: click the button, open the site, pick a password. That's the setup.

## How it works

```
 someone emails               you open the site
 anything@yourdomain.com      (password protected)
        │                             ▲
        ▼                             │
 ┌────────────────┐         ┌─────────┴──────┐        ┌──────────────┐
 │ Cloudflare     │  ─────▶ │ Worker         │ ─────▶ │ D1 database  │
 │ Email Routing  │         │ site + API +   │        │ (your mail)  │
 │ (catch-all)    │         │ mail handler   │        └──────────────┘
 └────────────────┘         └────────────────┘
```

One Worker does everything: serves the site, checks the password, receives
mail and stores it. A nightly job deletes mail older than 100 days and keeps
the database under a fixed size.

## Deploy your own (about 10 minutes)

### You need

- A **Cloudflare account** (free) — [sign up](https://dash.cloudflare.com/sign-up).
- **A domain on Cloudflare.** If yours is registered elsewhere, add it to
  Cloudflare and switch its nameservers: [Add a site](https://developers.cloudflare.com/fundamentals/setup/manage-domains/add-site/).

No terminal, no credit card, no servers.

### 1. Click **Deploy to Cloudflare**

The button at the top clones this project into your account, creates the
database and deploys the Worker. When it finishes, open the Worker's URL
(`https://tempmail.<your-subdomain>.workers.dev`).

### 2. Create your password

The first visit shows a one-time setup screen. Choose a password (and, if you
like, type your mail domain so the address generator knows it). You're signed
in. Nobody else can set up the inbox after this point.

> Do this right after deploying: until a password exists, whoever opens the
> URL first gets to set it. Prefer to manage the password yourself? Add an
> `AUTH_PASSWORD` **secret** under **Settings → Variables and Secrets** and the
> setup screen never appears.

### 3. Send mail to the Worker

This is the only part that has to happen in the Cloudflare dashboard.

1. Dashboard → your **domain** → **Email** → **Email Routing** → **Get started**
   / **Enable Email Routing**. Accept the MX records it offers.
   ⚠️ This makes Cloudflare the mail receiver for the whole domain. If the domain
   already receives mail elsewhere (Google Workspace, etc.), that would stop —
   use a spare domain or a subdomain instead.
2. **Email Routing → Routing rules → Catch-all address → Edit** →
   action **Send to a Worker** → pick **tempmail** → **Save**. Make sure the
   catch-all toggle is on.

Guide with screenshots: [Enable Email Routing](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/).

### Done ✅

Send a test message to `hello@yourdomain.com` from anywhere. It appears in the
inbox within seconds.

### Optional: use your own hostname

The workers.dev URL works fine. If you'd rather open `mail.yourdomain.com`:
**Workers & Pages → tempmail → Settings → Domains & Routes → Add → Custom
domain**. Cloudflare sets up DNS and HTTPS for you.

## Using it

| | |
|---|---|
| **Your inbox** | The card in the sidebar. Click the address to copy it, **Open** to see only its mail. **New Inbox** opens a sheet showing the address you are about to get, a re-roll, and how long it should live — forever, a day, or a week. On phones the card is hidden and the **+** in the top bar opens the same sheet. |
| **Get code** | Tap before you sign up somewhere. The next message to that address shows its code full-screen and copies it, whatever the list is filtered to. |
| **Read** | Click a message. `J` / `K` move through the list, `Esc` closes. |
| **Star** | The star on any row, or `S` in the reading pane. Starred mail survives the nightly cleanup. |
| **Select** | The tick icon in the list header, or `X`. Then **All**, mark read or unread, star or unstar, or delete in bulk. |
| **Delete** | The trash chip, or `#`. Nothing asks first: a toast offers **Undo** for ten seconds, and the trash is emptied a day later. |
| **Codes** | A key chip shows the detected verification code; click to copy. Code-shaped text in the message body is tappable too, for the ones no chip names. |
| **Images** | Remote images are blocked. **Load images** shows them for that message, or turn them on for good in Settings. |
| **Attachments** | Click to download. They stream from the Worker, so a 25 MB file costs nothing until you ask for it. |
| **Export** | Saves the open message as a plain `.txt` file. |
| **Sender check** | A badge beside the sender: **Verified sender**, **Failed authentication** or **Unverified**. A strip warns when a link's text, characters or domain are pretending to be something else. |
| **Unsubscribe** | The chip appears when a message carries an unsubscribe header. One-click senders are handled for you; others open in a new tab. |
| **Search** | The box in the top bar, or press `/`. **All / Unread / Starred / Leaks** switch the view. |
| **Leaks** | Every address remembers the first company that wrote to it. If anyone else turns up, that company shared or sold your address — they are listed here, and **Block address** bounces everything to it from then on. |
| **Block** | The ⃠ icon on an address row, in the list header, or under a leaked message. Blocked addresses bounce at the door; the toast offers Undo. |
| **Inboxes** | The sidebar lists every address that has received mail or been made as a burner, with its message count and a tag for its lifetime (`<1h`, `23h`, `6d`, `blocked`). Name one with the tag icon, or delete it and its mail with the trash icon. On phones there is no sidebar: tap the list title to open the picker, one inbox per line with its count. |
| **Refresh** | New mail arrives live while the tab is open (the green dot by the domain). The refresh icon, or `R`, checks by hand. |
| **Settings** | Gear icon (or `,`): the site's name, mail domain, password, sound, desktop and push notifications, auto-refresh, theme (System / Light / Dark), accent colour, remote images, storage limits. |

## Privacy and protection

- The site is password-protected. The password is stored as a salted PBKDF2
  hash; sessions are signed cookies (`__Host-`, HttpOnly, Secure, SameSite)
  that stop working the moment the password changes.
- Five wrong passwords lock that IP out for 15 minutes, and every wrong guess
  is delayed. For a hard guarantee, add a free Cloudflare WAF rate-limiting
  rule on `/api/login`.
- Every response carries strict security headers and a Content-Security-Policy.
  Messages render in a sandboxed frame with scripts, forms and remote images
  blocked (images load only on request).
- **The mail side is a true catch-all**: anyone who knows or guesses an address
  at your domain can send to it, and it lands in your inbox. Don't use it for
  password resets on accounts you care about.
- Storage stays bounded: 200 messages per address, 5,000 in total, 25 MB per
  message, 25 MB of attachments per message, and everything older than 100
  days is deleted nightly (starred mail is kept indefinitely).

## Customization

Every limit lives in [`src/limits.ts`](src/limits.ts). Change a number and redeploy.

| Setting | Default |
|---|---|
| Retention | 100 days |
| Messages per address / in total | 200 / 5,000 |
| Max raw message size | 25 MB |
| Attachment bytes kept per message | 25 MB (chunked across D1 rows) |

Two things a fork usually wants are in **Settings**, not in the source: the
name the site goes by (top bar and browser tab), and the accent colour — six
presets, each checked for contrast against every surface in both themes.

Everything else is CSS variables at the top of
[`public/style.css`](public/style.css): the grey ramp, the spacing scale, the
radii, the type scale and the timings. The front-end is plain ES modules under
[`public/js/`](public/js) with no build step — edit a file and reload.

Optional variables (dashboard → Worker → **Settings → Variables and Secrets**,
or `wrangler.jsonc`):

| Variable | What it does |
|---|---|
| `AUTH_PASSWORD` (secret) | Manage the password outside the app. Overrides the one created in the setup screen. |
| `MAIL_DOMAIN` | Comma-separated allow-list of domains to accept mail for, e.g. `example.com, other.org`. Unset accepts everything Email Routing sends here, which is normally what you want. |

## Deploy from the terminal instead

```bash
git clone https://github.com/aaronjoseph94/tempmail && cd tempmail
npm install
npx wrangler login
npx wrangler deploy      # creates the D1 database on the first run
```

Then open the Worker URL and follow steps 2 and 3 above.

## Local development

```bash
cp .dev.vars.example .dev.vars   # enables the test-mail endpoint
npm run dev                      # http://localhost:8787
```

Push a message into the local inbox without Email Routing:

```bash
curl -X POST "http://localhost:8787/api/dev/ingest?to=test@example.com" \
     -H "x-ingest-key: dev-key" --data-binary @message.eml
```

`npm test` runs the test suite inside the Workers runtime (local D1 included);
`npm run check` adds the type check.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Mail never arrives | Dashboard → your domain → Email → Email Routing: are the MX records active, is the catch-all rule **Send to a Worker: tempmail**, and is it enabled? Senders get a bounce if the Worker rejected the mail (too big, or a domain outside `MAIL_DOMAIN`). |
| Forgot the password | Workers & Pages → tempmail → Settings → Bindings → the D1 database → **Console**: `DELETE FROM settings WHERE key = 'password_hash';` then reload the site for a fresh setup screen. Or set an `AUTH_PASSWORD` secret. |
| Signed out everywhere | Expected after a password change. Sign in again. |
| `error 1042` on workers.dev | Happens when a custom domain is attached and the workers.dev route was disabled. Use your domain or re-enable the route in the Worker's settings. |
| Address card says "@…" | The site doesn't know your domain yet. Set it in Settings, or just receive one message and it learns it. |
| Start over | Settings → **Delete all mail**. |

## License

MIT — fork it, deploy it, make it yours.
