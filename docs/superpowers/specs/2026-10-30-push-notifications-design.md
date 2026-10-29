# Push notifications for patients: design

Date: 30 October 2026
Status: approved and built for Android (migration 93, send-push, the app). iPhone in a later step.

## 1. Goal

Patients get alerts on their phone even when the SanjeevniOS app is closed:
above all, when their turn at the clinic is near. This is the main reason to
install the app rather than use the website, and it helps the App Store review
(Apple rejects apps that are "just a website").

Success looks like this: a patient checks in, puts the phone away, gets "2
people ahead of you (about 12 min). Please be at the clinic.", then "You're
next", then "It's your turn", and tapping any of them opens their booking.

## 2. Decisions made

| Question | Decision |
| --- | --- |
| Who gets push | Patients only. Clinic and admin alerts can come later on the same foundation. |
| Which alerts | Every alert the app already gives patients, plus new queue alerts (section 3). |
| Queue moments | Three: one or two people ahead (with an estimated wait), you're next, it's your turn. |
| Delivery | Firebase Cloud Messaging for both Android and iPhone (Firebase passes iPhone alerts to Apple). Supabase stays the whole backend; Firebase only delivers. |
| Order of work | Android first (needs a free Firebase project). iPhone once the paid Apple Developer account exists. |
| Sign-out | Tapping Sign out stops alerts on that phone. The automatic sign-out after 60 idle minutes does not, so a long wait in the queue never silently loses "It's your turn". |

## 3. What patients get

Each alert is written once to the existing notification list (the bell) and
pushed to the patient's phones. None is ever sent twice.

### New or moved to the server (they work with the app closed)

| Alert | When | Wording | Type |
| --- | --- | --- | --- |
| Almost your turn | The patient is checked in and 1 or 2 people are ahead, for the first time | "2 people ahead of you (about 12 min). Please be at the clinic." / "1 person ahead of you (about 6 min)…" | `queue_almost` (new) |
| You're next | The patient is checked in, nobody is ahead, not yet called | "You're next. Please be ready." | `queue_next` (new) |
| It's your turn | The patient's status becomes "called", by any route | "It's your turn. Please go in to see Dr. Agarwal (token #12)." | `token_called` (until now written only by the clinic's Call next button; now written by the database) |
| Arrival reminder | A confirmed (`accepted`) booking for today, not yet checked in: from 60 minutes before its reporting time until its slot time. Not for a booking made after that window opened (its confirmation has just said when to come) | "Please reach Sunrise Clinic by 10:15 AM for your 10:30 AM visit, and scan the clinic's QR to check in." Where the clinic doesn't use self check-in: "…and check in at the reception desk." | `reporting_time_reminder` (until now written only while the booking screen was open; now by a server job) |

"People ahead" is counted exactly as the clinic's queue and the patient's
booking screen count it (`get_queue_status`: checked in, called and in
consultation, ordered by fair-queue time then arrival; the one with the doctor
is position 1). The estimated wait is the number ahead times that doctor's
average consultation time (`get_doctor_avg_consultation_minutes`), or the
doctor's slot length when there's no history yet, rounded to whole minutes.

Queue alerts only fire for today's appointments (in the clinic's time zone, India time).

A patient who is skipped (moved to the back with a new token) is told again as
they come up again, and gets "It's your turn" again when called again: each
queue alert is once per appointment *per round*, the round being the
appointment's skip count.

### Already written today, now also pushed

`booking_received`, `appointment_confirmed`, `appointment_rejected`,
`appointment_rescheduled`, `appointment_cancelled_by_clinic`,
`full_day_reschedule`, `waitlist_seat`, `schedule_published`,
`appointment_missed`, `appointment_auto_cancelled`, `follow_up_reminder`,
`checked_in`, `queue_skip`, `visit_completed`, `clinic_reminder`,
`prescription_ready`, `report_added`, `name_change_approved`,
`name_change_rejected`.

Their wording stays as it is, except that `report_added` names the kind of
report, so on the phone it reads "The clinic added a new file to your visit.
Tap to view it." The old client-only type `queue_reminder` is retired
(replaced by `queue_almost` and `queue_next`).

### Rules for every push

- **Patients only.** A notification is pushed only if its type is on the list
  above and its recipient is the patient: the account that owns the family
  member on that appointment, or (for alerts with no appointment, such as
  name-change decisions) the account itself. A clinic owner who is also a
  patient gets only their own patient alerts.
- **Nothing medical on the lock screen.** Alerts carry the clinic, doctor,
  times, tokens and queue counts, never diagnoses, prescriptions or report
  contents. A future alert type that would need medical detail must use a
  generic text ("You have a new update in SanjeevniOS").
- **Title** is the clinic's name for appointment alerts, "SanjeevniOS" otherwise.
  The text is the notification's message.
- **Tapping** opens the booking (`/bookings/<id>`), or the notification list for
  alerts without one.
- **Queue alerts replace each other** on the lock screen for the same
  appointment (Android tag, iPhone collapse id and thread), so the phone shows
  the latest, not a pile. The queue group is `checked_in`, `queue_almost`,
  `queue_next`, `token_called`, `clinic_reminder` and `queue_skip`.
- **Late is worse than never.** Queue alerts expire after 10 minutes if the
  phone can't be reached, the arrival reminder after an hour, the rest after
  a day.
- **While the app is open**, the alert shows as a banner inside the app instead
  of a phone notification.

## 4. How it works

```
clinic action / server job / existing alert code
        │ writes a row
        ▼
notifications (the bell list)  ──► trigger (patient alerts only)
                                        │ async HTTP (pg_net), ids only
                                        ▼
                               send-push (Supabase function)
                                        │ looks up the patient's phones
                                        ▼
                         Firebase Cloud Messaging ──► Android (and, later, Apple ──► iPhone)
```

1. **Phones register.** When a patient turns alerts on, the app gets the phone's
   Firebase address (token) and saves it with `register_push_device(token,
   platform)`. A token that was registered by another account (shared phone,
   different login) moves to the new account. Firebase can change a token; the
   app re-registers when it does.
2. **The trigger.** An `AFTER INSERT` statement-level trigger on
   `notifications` collects the new rows that pass the patient rules (in-app
   channel only) and makes one asynchronous `net.http_post` call to
   `send-push` with their ids. It never blocks or fails the insert: an error
   is logged as a warning, like the admin signals in migration 90.
3. **send-push** (public endpoint, no login, because the database calls it):
   - accepts only a list of notification ids (at most 500 per call) and
     nothing else, so a caller can't supply any wording or recipient;
   - claims the notifications atomically: sets `pushed_at` only on rows that
     are on the patient list, written in the last 10 minutes and not yet
     pushed. That makes it impossible to send anything twice, and a stray or
     forged call can only deliver real, unsent alerts to their own patients;
   - loads the recipient's enabled phones and sends one Firebase message per
     phone (Firebase's HTTP v1 API, signed in with the service key);
   - deletes phones Firebase reports as gone (`UNREGISTERED`, invalid token);
     retries a temporary error (429, 5xx) once, after about a second.
4. **Queue alerts.** A row trigger on `appointments` (status, check-in time,
   fair-queue order, token, doctor or date changed) runs
   `queue_alerts_for(doctor, date)` for today's queues. It recounts that
   doctor's queue and writes `queue_almost` and `queue_next` for patients who
   just reached those points, and `token_called` when a status becomes
   "called". `queue_alert_log` (appointment, alert, round) makes each at most
   once per appointment per round. Exception-safe: the clinic's action always
   succeeds. An app still open from before this change that writes
   `token_called` or `queue_reminder` itself has those rows dropped, so
   nothing is doubled while old copies are about.
5. **Arrival reminders.** A `pg_cron` job every 5 minutes runs
   `sweep_reporting_reminders()`, using the reporting time the app already shows
   (the same formula as `get_checkin_options`) and the clinic's self check-in
   setting for the wording. The existing unique index keeps it to one per
   appointment.
6. **The apps stop writing these themselves.** The booking screen no longer
   inserts `queue_reminder` or `reporting_time_reminder`, and the clinic's Call
   next button no longer inserts `token_called`. The booking screen shows the
   newest alert for the booking at the top, now the database's.
7. **The rate limiter** no longer counts the project's own functions (the
   service key): they share a few Supabase addresses and would use up one
   another's allowance on a busy day.

## 5. Data

- **`push_devices`** (new): `id`, `user_id` (references `auth.users`,
  deleted with the account), `token` (unique), `platform` (`android` / `ios`),
  `enabled` (the Profile switch), `created_at`, `last_seen_at`.
  Row-level security: each person sees and changes only their own phones.
  Written through `register_push_device`, `unregister_push_device(token)` and
  `set_push_enabled(token, enabled)`.
- **`notifications.pushed_at`** (new column): when the alert went to the phones.
- **`queue_alert_log`** (new, server only): which queue alerts each
  appointment has had, per round (`skip_count`).
- **`push_settings`** (new, one row): the address of `send-push`, so a test
  project can point at its own functions, and a switch for all sending.
- **Secret** `FIREBASE_SERVICE_ACCOUNT`: the Firebase service key, set as a
  Supabase function secret by `scripts/set-firebase-key.sh` (stored as base64),
  never pasted anywhere.

Account deletion (migration 91) needs no change: phones go with the login.

## 6. The app

- **Plugin:** `@capacitor-firebase/messaging` (supports Capacitor 8; gives
  Firebase tokens on both platforms). Loaded only inside the phone apps, like
  the other plugins in `lib/native.ts`.
- **Asking permission:** not at first launch. Once there is a booking or a
  place in the queue, the booking screen shows a small card: "Get an alert
  when your turn is near", with **Turn on**, which shows the phone's own
  permission prompt, and **Not now**. It isn't shown again once answered (then
  Profile has the switch, and explains how to allow alerts in the phone's
  settings if they were refused). On Android 12 and older, where apps need no
  permission, alerts still start only when the patient turns them on.
- **Which account:** a phone where the patient turned alerts on registers for
  whoever is signed in, at each start and sign-in; signing in with another
  account on the same phone moves the alerts to it.
- **Only where they can work:** the app offers alerts only in a build that
  includes Firebase's config (`google-services.json`); a small native check
  (`AppSetupPlugin`) tells the web app, so no build crashes or offers a
  button that can't work.
- **Profile:** a switch "Alerts on this phone", which sets `enabled` for this
  phone's token.
- **Sign out:** one helper used by every Sign out button removes this phone's
  token first, then signs out. The 60-minute idle sign-out keeps the token
  (section 2).
- **Android:** two notification channels, "Queue updates" (`queue`: high
  importance, sound and vibration) for the queue alerts and "Bookings and
  reminders" (`general`: default) for the rest, both leaving the lock-screen
  detail to the phone's own setting; a white leaf as the status-bar icon,
  tinted indigo; the Android 13 notification permission; Firebase's automatic
  token creation and analytics switched off.
- **iPhone (later phase):** the Push Notifications capability and remote
  notification background mode, Firebase's iPhone config file, Apple's push
  key uploaded to Firebase, and the plugin added back to the iPhone build
  (`ios.includePlugins` in `capacitor.config.ts` leaves it out for now, so the
  iPhone app doesn't carry Firebase before it can use it). Until then the app
  offers alerts only on Android.

## 7. When things go wrong

- Firebase down or slow: the alert is still in the notification list; the
  clinic's action and the patient's booking are never delayed.
- Patient turned alerts off, or refused permission: nothing is sent to that
  phone.
- App deleted: Firebase reports the token as gone; it is removed.
- Temporary sending error: one retry. Alerts older than 10 minutes are never
  sent (a late "You're next" is worse than none).
- `pg_net` or `pg_cron` unavailable: the migration says so and pushes simply
  don't go out; nothing else is affected.

## 8. Your setup steps

1. **Straight after this change is live:** run
   `supabase/migration_93_push_notifications.sql` in the Supabase SQL editor.
   It switches on `pg_net` and `pg_cron` if they aren't already; if it says
   one of them is unavailable, enable it under Database → Extensions and run it
   again. Then deploy the functions as before (`./scripts/deploy-functions.sh`).
   From then on the database writes the queue alerts and arrival reminders to
   the bell; nothing goes to phones until Firebase is set up.
2. **Firebase** (free): at console.firebase.google.com, add a project
   (SanjeevniOS; Google Analytics can stay off), then add an Android app with
   the package name `in.sanjeevnios.app`. Download `google-services.json` and
   put it in `android/app/` (it identifies the app, isn't secret, and is
   committed). Skip Firebase's "add the SDK" steps: they are already done.
3. **The service key:** in Firebase, Project settings → Service accounts →
   Generate new private key. Run `./scripts/set-firebase-key.sh` and drag the
   downloaded file in when it asks; it stores it as the
   `FIREBASE_SERVICE_ACCOUNT` secret. Then delete the downloaded file.
4. **The Android app:** `npm run cap:sync`, then build and run it from Android
   Studio (`npm run cap:android`).
5. Later, for iPhone: upload Apple's push key to Firebase, add the iPhone
   config file, and add the plugin back to the iPhone build.

## 9. Testing

Done before release:

- **Database** (local Postgres, as for migrations 91 and 92; 82 checks): the
  migration runs twice; phones register, move between accounts, switch off and
  on, unregister, and go with a deleted account; nothing about them is open to
  the app beyond its own phones; the trigger calls `send-push` once per
  statement, with only the patient alerts of patients who have a phone with
  alerts on (not other types, not WhatsApp copies, not a clinic owner for
  someone else's booking, nothing when switched off); `pg_net` failing never
  fails the insert; claiming gives one row per phone and never the same alert
  twice, never an alert older than 10 minutes; queue counts in the fair order
  with the doctor's own pace or the slot length; each queue alert once, again
  after a skip, only for today; "called" from any route; walk-ins, removals,
  moves to another doctor, and changes that don't move the queue; alerts
  written inside the clinic's action handed to `send-push` like any other; a failing
  queue check never blocks the clinic's action; old apps' copies dropped; the
  arrival sweep's window, wording (QR or desk, the fast check-in rule, the
  clamped reporting time) and one-per-booking; the rate limiter's exemption.
- **send-push** against a stand-in for Firebase (28 checks): a real signed
  sign-in, the access token reused and renewed when it expires; the message
  for each kind of alert (channel, replace-tag, priority, expiry, where a tap
  goes, the general text for reports); gone phones forgotten, a broken message
  not mistaken for a gone phone; one retry after a second for a temporary
  error; only `{"ids": [...]}` accepted; the key read as JSON or base64; type
  check with Deno.
- **set-firebase-key.sh** with a stand-in for the Supabase command line: the
  dragged path, a wrong file, a bad token; the key passed through a private
  temporary file that is removed.
- **App:** type check, lint, build, and the full-site crawl. In the
  Android-app mode (a stand-in for the phone's native layer; 32 checks): the
  card, Turn on (the phone's prompt first, nothing registered before it), Not
  now, the Profile switch both ways, the "blocked" state, the in-app banner and
  its tap, a tapped alert opening its booking (and never anything else), a new
  token replacing the old, re-registering on start (once, however much the patient moves around the
  app), Log Out unregistering first; and that a build without Firebase's config, and the website, show
  none of it.

Still to do, once Firebase and Android Studio are set up: an Android emulator
with a test patient: book, check in, have the clinic call others and then the
patient, with the app closed; every alert arrives once and opens the booking.

## 10. Not in this version

Push for clinics and admins; web push for the website; marketing or bulk
messages; alerts in Hindi; per-alert settings (one switch per phone for now).

## 11. What changes

- `supabase/migration_93_push_notifications.sql`
- `supabase/functions/send-push/index.ts` and `push.ts`,
  `supabase/functions/_shared/fcm.ts`
- `scripts/deploy-functions.sh` (send-push deployed as public),
  `scripts/set-firebase-key.sh` (new)
- `src/lib/push.ts`, `src/lib/signOut.ts`, `src/components/PushPrompt.tsx`,
  `src/components/PushBanner.tsx`, `src/components/PhoneAlertsRow.tsx` (new)
- `src/components/NativeAppBridge.tsx` (alert taps, token refresh, sign-in),
  `src/App.tsx` (the banner), `src/pages/BookingStatus.tsx`,
  `src/components/WaitingList.tsx`, `src/pages/Profile.tsx`,
  `src/lib/useUnreadNotifications.ts`, and the Sign out buttons
  (`shell/Sidebar.tsx`, `ClinicQueue.tsx`, `AdminConsole.tsx`, `App.tsx`)
- Android: `AppSetupPlugin.java` (new) and `MainActivity.java`, the status-bar
  icon `ic_stat_sanjeevnios.xml`, the colour, the manifest entries; later
  `google-services.json` (from you)
- `capacitor.config.ts`: the plugin left out of the iPhone build for now
- `package.json`: `@capacitor-firebase/messaging` and its `firebase` peer
