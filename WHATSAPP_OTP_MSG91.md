# Integrating WhatsApp OTP via MSG91

Today, login (`src/pages/Login.tsx`) works entirely through **Supabase Auth's phone provider**:

```ts
await supabase.auth.signInWithOtp({ phone });                       // sends the code
await supabase.auth.verifyOtp({ phone, token: otp, type: 'sms' });  // checks it, creates the session
```

Supabase generates the OTP, stores it (hashed), sends it through whichever SMS provider is configured
in the dashboard, and verifies it when the user types it back in. `AuthContext` then picks up the
resulting session automatically - nothing else in the app cares how the code was delivered.

**The goal here is to swap *only the delivery channel* - SMS → WhatsApp, via MSG91 - without touching
anything else.** Supabase keeps doing OTP generation, storage, verification, and session creation.
MSG91 becomes responsible only for putting the 6-digit code in front of the patient/clinic on WhatsApp.

That's what a **Supabase Auth "Send SMS" Hook** is for. Instead of Supabase calling its built-in SMS
provider, it calls a small HTTPS endpoint you write, handing it the phone number and OTP; your endpoint's
only job is to actually deliver that code (via MSG91's WhatsApp API) and report success or failure back.

**Net effect on this codebase: `Login.tsx` and `AuthContext.tsx` do not change at all.** The entire
integration lives in one new Supabase Edge Function plus dashboard configuration.

> There's a fallback design (fully custom OTP, bypassing Supabase's phone provider entirely) described
> at the bottom, for if the Hook path turns out to be unavailable on your Supabase plan/region. Start
> with the Hook approach below - it's less code and less to secure.

---

## Step 1 — Set up MSG91 for WhatsApp OTP

1. Create an MSG91 account at [msg91.com](https://msg91.com) if you don't have one, and complete their
   KYC (required before any transactional/WhatsApp sending is unlocked).
2. In the MSG91 dashboard, go to **WhatsApp → Get Started** and connect a WhatsApp Business number.
   This requires a Meta/WhatsApp Business Account - MSG91's onboarding wizard walks you through
   creating one and linking a phone number to it if you don't already have one.
3. Create an **OTP / Authentication template**. WhatsApp requires every business-initiated message to
   use a pre-approved template, and Meta has a specific **Authentication** template category built for
   exactly this (a short "Your code is {{1}}" message, optionally with a one-tap autofill button).
   Submit it for approval in MSG91's template manager - approval is usually fast for the standard
   Authentication category, but budget a day or two the first time.
4. Once approved, note down:
   - Your **Auth Key** (Dashboard → **API** → find your Auth Key - this authenticates every API call)
   - Your **WhatsApp integrated number** (the sender)
   - Your approved **template's ID/name**

Keep these three somewhere safe - you'll put them into Supabase as secrets in Step 3, never into
client-side code.

---

## Step 2 — Get the exact send-OTP request shape from MSG91's own dashboard

MSG91's exact API endpoint and field names for "send WhatsApp OTP via template" have changed across
their API versions, so rather than copy an endpoint URL from outside their docs, get it directly from
your own account:

1. In the MSG91 dashboard, open your approved WhatsApp OTP template.
2. Use the **"API"** / **"Get code snippet"** panel next to it - MSG91 generates a ready-to-use
   `curl`/Node example scoped to *your* auth key, sender number, and template ID.
3. Save that snippet (endpoint URL, headers, and JSON body shape) somewhere - you'll port it into the
   Edge Function below almost verbatim, just swapping the hardcoded phone/OTP for the values Supabase
   hands you at request time.

This guarantees the request shape you implement is actually current, instead of relying on documentation
(mine included) that can drift out of date.

---

## Step 3 — Write the Edge Function that Supabase will call

This function receives `{ phone, otp }` from Supabase's Auth Hook and forwards it to MSG91.

```bash
# from the sanjeevnios-web project root
npx supabase functions new send-whatsapp-otp
```

This creates `supabase/functions/send-whatsapp-otp/index.ts`. Replace its contents with:

```ts
// supabase/functions/send-whatsapp-otp/index.ts
import { Webhook } from 'npm:standardwebhooks@1';

// Supabase signs every Hook request with this secret so you can verify the
// call genuinely came from your own project, not a random request to this
// public URL. Set with `supabase secrets set`, see Step 4.
const HOOK_SECRET = Deno.env.get('SEND_SMS_HOOK_SECRET')!;
const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY')!;

// From Step 2's snippet - adjust to match exactly what MSG91's dashboard
// generated for your template/sender.
const MSG91_ENDPOINT = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const MSG91_TEMPLATE_NAME = Deno.env.get('MSG91_WHATSAPP_TEMPLATE_NAME')!;
const MSG91_SENDER_NUMBER = Deno.env.get('MSG91_WHATSAPP_SENDER')!;

Deno.serve(async (req) => {
  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);

  // Verifies the webhook-id / webhook-timestamp / webhook-signature headers
  // Supabase attaches. Throws if the signature doesn't match - treat that as
  // a rejected request, never as "assume it's fine".
  const wh = new Webhook(HOOK_SECRET);
  let event: { user: { phone: string }; sms: { otp: string } };
  try {
    event = wh.verify(payload, headers) as typeof event;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid signature' }), { status: 401 });
  }

  const { phone } = event.user;   // E.164, e.g. "+919876543210"
  const { otp } = event.sms;

  // Port this body from the snippet MSG91's dashboard gave you in Step 2 -
  // field names for the template's variable(s) vary per account/template.
  const msg91Res = await fetch(MSG91_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: MSG91_AUTH_KEY,
    },
    body: JSON.stringify({
      integrated_number: MSG91_SENDER_NUMBER,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: MSG91_TEMPLATE_NAME,
          language: { code: 'en', policy: 'deterministic' },
          namespace: null,
          to_and_components: [
            {
              to: [phone.replace('+', '')],
              components: {
                body_1: { type: 'text', value: otp },
                // Authentication templates with a one-tap button also need
                // the OTP repeated as a button parameter - check your
                // template's own generated snippet for the exact key name.
              },
            },
          ],
        },
      },
    }),
  });

  if (!msg91Res.ok) {
    const detail = await msg91Res.text();
    console.error('MSG91 send failed', msg91Res.status, detail);
    // Any non-2xx here tells Supabase the OTP was NOT delivered, which
    // surfaces as an error back to signInWithOtp() on the client.
    return new Response(JSON.stringify({ error: 'failed to send WhatsApp OTP' }), { status: 500 });
  }

  return new Response(JSON.stringify({}), { status: 200 });
});
```

A few things worth calling out:

- **Never trust an unsigned request.** The `wh.verify(...)` call is what stops a stranger from hitting
  this public URL directly and using it to either enumerate phone numbers or run up your MSG91 bill.
  Don't skip it, even for a quick test.
- The `standardwebhooks` package matches the signing scheme Supabase Hooks use (same one Svix uses) -
  it's imported straight from npm via Deno's `npm:` specifier, no extra install step needed.
- Everything MSG91-specific (endpoint, body shape, template variable names) should come from **your**
  Step 2 snippet, not copied verbatim from this file - treat the block above as a structural example,
  not a drop-in.

---

## Step 4 — Deploy the function and set its secrets

```bash
npx supabase functions deploy send-whatsapp-otp --no-verify-jwt
```

`--no-verify-jwt` is required here - Supabase Hooks call this endpoint without a user JWT (there isn't
one yet, since the user is mid-login), so the usual auth check would reject every call. The
`standardwebhooks` signature check in Step 3 is what actually secures this endpoint instead.

Set the secrets it needs:

```bash
npx supabase secrets set \
  MSG91_AUTH_KEY=your_msg91_authkey \
  MSG91_WHATSAPP_SENDER=your_whatsapp_integrated_number \
  MSG91_WHATSAPP_TEMPLATE_NAME=your_approved_template_name \
  SEND_SMS_HOOK_SECRET=<generate this in Step 5 first, then come back and set it>
```

---

## Step 5 — Wire it up as the Send SMS Hook

1. Supabase Dashboard → **Authentication** → **Hooks** (sometimes listed under Auth settings as
   "Auth Hooks").
2. Find **Send SMS hook**, enable it, and set its type to **HTTPS**.
3. Point it at your deployed function's URL:
   `https://<your-project-ref>.supabase.co/functions/v1/send-whatsapp-otp`
4. Supabase generates a **signing secret** for this hook right there in the dashboard (starts with
   `v1,whsec_...`) - copy it and set it as `SEND_SMS_HOOK_SECRET` from Step 4 (re-run the `secrets set`
   command now that you have the real value).
5. Save.

From this moment, every `supabase.auth.signInWithOtp({ phone })` call from the app routes the OTP
through your Edge Function → MSG91 → WhatsApp, instead of Supabase's built-in SMS provider.

---

## Step 6 — Test it

1. `npm run dev`, open the app, log in with a **real** phone number that has WhatsApp (this is now
   live-sending, not the Test OTP path - see the note below).
2. Confirm the WhatsApp message arrives with the code, and that entering it on the Verify screen still
   signs you in exactly as before - `Login.tsx` didn't change, so this should just work.
3. Check the Edge Function's logs (`npx supabase functions logs send-whatsapp-otp`) if anything goes
   wrong - a 401 there means the signature check failed (secret mismatch between dashboard and your
   deployed secret); a failed MSG91 call will show the raw MSG91 error response.

**Your existing Test OTP numbers are unaffected.** Supabase's Test OTP feature (Dashboard →
Authentication → Providers → Phone → Test OTP) bypasses the Send SMS Hook entirely - those fixed
phone/code pairs (the clinic and patient test accounts documented in `SETUP.md`/`TESTING.md`) will keep
working exactly as they do now, without spending any MSG91 credits. That's still the right way to run
this project's automated/manual test suite.

---

## Optional — SMS fallback

WhatsApp delivery depends on the recipient having WhatsApp installed and not having blocked the
sender, which SMS doesn't. A safer production setup sends WhatsApp first and falls back to SMS if MSG91
reports the number isn't reachable on WhatsApp: check MSG91's WhatsApp send response for their
"undeliverable" status, and on that specific failure, call MSG91's plain SMS OTP API instead before
returning success. Left out of the function above to keep the first working version simple - add it
once the WhatsApp-only path is confirmed working end to end.

---

## Fallback design, if the Send SMS Hook isn't available to you

Auth Hooks require a Supabase plan that supports them (Pro tier and above on hosted Supabase, or any
tier locally via the CLI). If yours doesn't have it, the alternative is to stop using Supabase's phone
provider for the OTP step entirely and build it by hand:

1. A Postgres table `otp_codes (phone, code_hash, expires_at)`, written by a new Edge Function
   `send-otp` that generates a random 6-digit code, hashes it, stores it, and calls MSG91 to deliver it.
2. A second Edge Function `verify-otp` that checks the submitted code against the stored hash and
   expiry, and on success calls Supabase's **Admin API**
   (`supabase.auth.admin.generateLink({ type: 'magiclink', ... })` or `createUser` +
   `admin.createSession`) to actually establish the session, since only the service-role key can mint a
   session without a password.
3. `Login.tsx` would then call these two Edge Functions directly instead of
   `signInWithOtp`/`verifyOtp`.

This is meaningfully more code and a larger attack surface (you're now responsible for OTP expiry,
rate-limiting, and brute-force protection yourself, all of which Supabase's built-in phone provider
already handles) - only take this path if Step 5's Hook genuinely isn't available to you.

---

## What to do next

This file is a plan, not yet-applied code - none of it has been created in this repo. Once you've done
the MSG91-side setup (Steps 1-2, which need your own MSG91 account and can't be done for you), tell me
and I'll write the actual Edge Function, wire up the secrets command, and update this file with the
exact values you end up using in place of the placeholders.
