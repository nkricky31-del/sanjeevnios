# Razorpay setup — what's left

Everything on the code/infra side is built and deployed. What's left is
account-level and data-entry work that only you can do. In order:

## 1. Security cleanup (do this first, regardless of anything else)

- [ ] Rotate the **live** Razorpay key/secret you pasted into this chat earlier
      (`rzp_live_Ta0q1DZlUWTPEw`) — Razorpay Dashboard → Settings → API Keys →
      regenerate. It's been exposed in a chat transcript, so treat it as burned
      even though we never wired it into anything live.
- [ ] Delete `UI/razorpay_test_api_keys_1788628269893.csv` from the repo working
      tree — it has a plaintext test key + secret sitting untracked in git, not
      used by the app at all. (Say the word and I'll delete it for you.)
- [ ] Commit the payout-account feature files (migrations 64/65, the two new
      edge functions, `AdminPayoutAccounts.tsx`, the `AdminConsole.tsx`/
      `types.ts`/`razorpay-webhook` edits) — I've held off committing until you
      confirm. (Say the word and I'll commit — not push — locally.)

## 2. Fix patient-side checkout (currently broken)

The `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` secrets configured on the live
Supabase project are **invalid** (401 Authentication failed) — last touched
2026-09-05. Until this is fixed, a patient trying to pay online will hit a
broken checkout.

- [ ] Log into the Razorpay Dashboard (test mode) → Settings → API Keys →
      generate a **fresh test key pair**. Regenerating invalidates the old one,
      so do this right before you're ready to hand it over.
- [ ] Give me the new test key + secret so I can verify it authenticates
      (a simple order-creation check, no money moves) before setting it as the
      Supabase secret.
- [ ] Once verified, I'll run:
      `supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=...`

## 3. Onboard at least one clinic's payout account

Nothing has been submitted yet — 0 of your 4 approved clinics have a payout
account. In the app:

- [ ] Admin Console → **Payout accounts** tab → pick a clinic → "Set up payout
      account"
- [ ] Fill in the clinic's real: legal business name, business type, PAN,
      address, and settlement bank account (account number, IFSC, beneficiary
      name) → Submit
- [ ] Click **Check status** periodically until it reads "Active" — Razorpay
      reviews linked accounts before activating them, this isn't instant.
      (No webhook is configured, so this manual check is the only way it
      updates — see step 4 if you change your mind on that.)

## 4. Optional: wire up the Route webhook events later

You said no webhooks for now, so status only updates when you click "Check
status." If you later want it to update itself:

- [ ] Razorpay Dashboard → Settings → Webhooks → your existing webhook →
      enable `product.route.under_review`, `product.route.needs_clarification`,
      `product.route.activated` (the handler code for these is already
      deployed in `razorpay-webhook`, just inert until enabled).

## 5. Only after step 3 shows "Active" for at least one clinic

- [ ] Do a real end-to-end settlement test: two paid, completed visits at that
      clinic → watch them turn eligible (Admin → Settlements) → release one
      payment by itself → release the rest all at once → confirm the clinic's
      net (after fee) and released/settled states.
- [ ] Only then revisit putting a **live** key into the patient-checkout
      secrets — not before payouts are proven to actually reach a clinic.
