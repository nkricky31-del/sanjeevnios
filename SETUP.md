# Running this app on a new machine

This app has no backend of its own — it talks to a Supabase project. Cloning the repo gets you the code; you still need to point it at the **same existing Supabase project** to see your existing clinics/doctors/data (creating a new Supabase project instead would mean re-running every migration from scratch).

## 1. Install prerequisites

- **Git** — https://git-scm.com/downloads
- **Node.js** — v20 or newer (this project was built on v24.19.0). npm comes bundled with it: https://nodejs.org

## 2. Clone the repo

```
git clone https://github.com/nkricky31-del/sanjeevnios.git
cd sanjeevnios/sanjeevnios-web
```

The GitHub repo is named `sanjeevnios`, but the actual web app lives in its `sanjeevnios-web/` subfolder — `cd` into that for everything below. There's also a `sanjeevnios/` Expo/React Native folder from an earlier prototype in the same repo — ignore it, it's not the active app.

## 3. Install dependencies

```
npm install
```

## 4. Set up the Supabase connection

```
cp .env.local.example .env.local
```

Then open `.env.local` and fill in:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR-ANON-PUBLIC-KEY
```

`.env.local` is git-ignored, so it never goes to GitHub — you have to carry these two values over yourself from whichever machine already has them (or get them fresh from **Supabase Dashboard → Project Settings → API**). These are the project URL and the public anon key, not a secret admin key, so it's fine to copy them directly.

## 5. Run it

```
npm run dev
```

This prints a local URL (typically `http://localhost:5173/`) — open that in a browser.

## 6. Sanity check

- Log in with one of your existing Test OTP numbers (Supabase Dashboard → Authentication → Providers → Phone → Test OTP). If login works and you see your existing clinics/data, you're pointed at the right project.
- Optionally confirm the checked-out code is clean:
  ```
  npm run lint
  npx tsc -b --noEmit
  ```

No database work is needed on the new machine — steps 1–5 are all that's required, since both machines share the same Supabase backend.
