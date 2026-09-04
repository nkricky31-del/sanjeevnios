# Deploying SanjeevniOS to a live URL

This has already been done once - the app is live at **[sanjeevnios.in](https://sanjeevnios.in)**,
deployed on Vercel, connected to the `nkricky31-del/sanjeevnios` GitHub repo. This doc is what to do
again (or on a second machine/account) if that ever needs redoing, and records what actually happened
the first time so the "gotchas" section isn't theoretical.

GitHub only hosts the *code* - getting an actual URL people can open needs a separate hosting step,
since this is a Vite/React single-page app that needs its own build + static file serving. This app has
no server of its own - it's a static SPA that talks directly to Supabase from the browser - so the
cheapest, simplest hosting is a static-site host wired to the GitHub repo, rebuilding and redeploying
automatically on every push. That's what Vercel is being used for here.

**The repo root *is* the app** - `package.json`, `src/`, `supabase/`, etc. are all directly at the top of
`github.com/nkricky31-del/sanjeevnios`, no subfolder to point a "root directory" setting at. (An earlier
version of this doc and of `SETUP.md` claimed otherwise, describing a `sanjeevnios-web/` subfolder and an
unrelated Expo prototype folder - neither exists in the repo as it actually is; that was stale
documentation, now corrected.)

---

## Step 1 — Sign up for Vercel

Go to [vercel.com](https://vercel.com) and sign up (email/Google is fine - GitHub gets connected
separately in the next step regardless of how you sign up).

## Step 2 — Connect GitHub

If the account wasn't created via "Continue with GitHub", link it explicitly: **Settings →
Authentication → GitHub → Connect**, and approve the authorization on GitHub's side.

Then, when importing a project (**Add New → Project → Import Git Repository → GitHub**), Vercel needs
its GitHub App installed against the repo(s) you want it to see: click **Install**, and on GitHub's
install screen either choose "All repositories" or specifically select `sanjeevnios`.

## Step 3 — Import and configure the project

1. Select `nkricky31-del/sanjeevnios` from the repo picker.
2. **Framework Preset** auto-detects as **Vite** - leave it.
3. **Root Directory** - leave as the default (`./`). Nothing to change here (see the note above).
4. **Build Command** / **Output Directory** - leave as the detected defaults (`npm run build` / `dist`).

## Step 4 — Environment variables

The app reads two values at build time (`src/lib/supabaseClient.ts` / `.env.local` locally). Add both
under **Environment Variables** on the same configure screen, using the same values from your local
`.env.local`:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://YOUR-PROJECT-REF.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | your Supabase anon/public key |

These are the **public** anon key and project URL, not a secret admin key (same note as `SETUP.md`) -
fine to have living in a hosting provider's env var panel and fine to end up in the shipped JS bundle.
Real protection comes from Supabase's row-level security policies, not from hiding these two values.

## Step 5 — Deploy

Click **Deploy**. First build takes a minute or two. When it finishes, Vercel gives you a live URL
(`<project-name>.vercel.app`) - open it and confirm the app loads (not stuck on "Loading..." from an env
var typo) and that logging in with a Test OTP number works.

---

## Step 6 — Connect a custom domain

Project → **Settings → Domains → Add Existing** → type the domain (e.g. `sanjeevnios.in`) → Add. Vercel
adds both the bare domain and its `www.` version, and by default sets the bare domain to redirect to
`www` (leave "Redirect apex domains to www" checked unless you have a reason not to - it's the
recommended setup and the bare domain still resolves and works either way).

Click into each domain's **"View DNS configuration"** - Vercel auto-detects the registrar (GoDaddy, in
this case) and gives the exact records needed. For a domain at GoDaddy, that was:

| Type | Name | Value |
|---|---|---|
| A | `@` | `216.198.79.1` |
| CNAME | `www` | `<something>.vercel-dns-XXX.com.` (shown per-project, copy it exactly) |

Add these at **dcc.godaddy.com → your domain → DNS**.

### The gotcha we actually hit

A brand-new domain at GoDaddy usually already has default A records for `@` (a parked-page placeholder),
separate from anything under "Domain Forwarding". Adding Vercel's A record without deleting those leaves
**multiple A records for the same name**, and DNS resolvers will return all of them - meaning some
visitors' requests land on GoDaddy's parking server instead of Vercel's, which fails the TLS handshake
(since that server has no certificate for your domain) even though everything *looks* configured
correctly.

Fix: in GoDaddy's DNS tab, there should be **exactly one** A record with Name `@` - delete any others,
keeping only the one pointing at Vercel's IP. (Domain Forwarding is a separate feature/tab from the DNS
records themselves and is worth checking too, but wasn't the actual cause here - it was already empty.)

### Confirming it actually resolved correctly

DNS caching means your own ISP's resolver can keep serving a stale (wrong) answer for a while after a
fix - `nslookup` locally isn't reliable evidence either way in the first several minutes. Check a public
resolver directly instead, which reflects the real, current state:

```
nslookup sanjeevnios.in 8.8.8.8
```

Should return exactly one address, Vercel's. If it still shows extra IPs, the DNS zone itself (not just
your local cache) still has a leftover record to remove.

---

## What happens after this

Every push to `main` on GitHub now auto-deploys - Vercel watches the repo, so the normal `git commit` →
`git push` workflow is also what ships a new live version, with zero extra steps. Vercel also builds a
preview URL for any other branch/PR if you ever work off of one.

## Before you call this "production"

Worth knowing, not blocking:

- **This points at the same shared dev/test Supabase project** - the database has a mix of real-looking
  data and obvious test junk (walk-in patients named things like "qwerty", a doctor named "Nikhi", etc.).
  Deploying the *app* doesn't change what's *in* the database. Decide whether that's fine for now or
  whether a second, separate Supabase project makes sense for anything you'd call production-real.
- **Phone login currently only works for Supabase's Test OTP numbers** unless you've separately
  configured a real SMS/WhatsApp provider (see `WHATSAPP_OTP_MSG91.md`) - a stranger opening
  `sanjeevnios.in` and typing in their own real number won't get a code today.
- **Migrations 37 and 38** (same-day booking, walk-in slot-availability) still need to be run against
  this same Supabase project before those specific features work in the live deployment, same as they
  did locally.

---

## If you'd rather use Netlify instead

Same shape, different dashboard:

1. [netlify.com](https://netlify.com) → sign up with GitHub → **Add new site → Import an existing
   project** → pick the repo.
2. **Base directory**: leave blank/default (repo root).
3. **Build command**: `npm run build`. **Publish directory**: `dist`.
4. Same two environment variables as Step 4 above, under **Site configuration → Environment variables**.
5. Netlify needs the SPA fallback explicitly (no auto-detection like Vercel's Vite preset) - add a file
   at `public/_redirects` containing:
   ```
   /*  /index.html  200
   ```
   so it ships inside `dist/` on every build.
6. Custom domain: **Domain management → Add a domain**, then the same GoDaddy DNS steps as above, using
   whatever record values Netlify's own dashboard shows for your site.
