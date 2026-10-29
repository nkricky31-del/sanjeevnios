import { Link } from 'react-router-dom';

import BrandMark from '../components/ui/BrandMark';
import Wordmark from '../components/ui/Wordmark';

// /delete-account for someone who isn't signed in - the page Google Play
// links to from the store listing. Deleting needs the person to prove the
// account is theirs, so it explains the steps and sends them through sign-in
// straight back to the Delete account screen.
export default function DeleteAccountInfo() {
  return (
    <div className="min-h-screen bg-ground px-5 pb-12 pt-[calc(2.5rem+env(safe-area-inset-top))] font-ui text-ink">
      <main className="mx-auto max-w-xl">
        <Link to="/" className="flex w-fit items-center gap-2.5" aria-label="SanjeevniOS home">
          <BrandMark size={34} animated={false} />
          <span className="font-display text-[15px] font-bold tracking-[-0.02em]">
            <Wordmark dotClassName="text-primary" />
          </span>
        </Link>

        <h1 className="mt-8 font-display text-3xl font-extrabold tracking-[-0.03em]">Delete your SanjeevniOS account</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          You can delete your account yourself, in the SanjeevniOS app or on this website.
        </p>

        <ol className="mt-6 list-decimal space-y-2 pl-5 text-[15px] leading-relaxed text-ink-2">
          <li>Sign in with your phone number.</li>
          <li>Open Profile, then Delete account.</li>
          <li>Confirm. Your account is deleted straight away.</li>
        </ol>

        <Link
          to="/login?next=%2Fdelete-account"
          className="mt-7 inline-flex items-center justify-center rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-white outline-none transition hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          Sign in to delete your account
        </Link>

        <h2 className="mt-10 font-display text-lg font-bold">What is deleted</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          Your login, profile, contact details, Aadhaar numbers and photos; family members who never visited a clinic;
          reports you uploaded yourself, your reviews and notifications.
        </p>

        <h2 className="mt-6 font-display text-lg font-bold">What clinics keep</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          The records of visits you made - notes, prescriptions, reports from the visit, bills and payments - because
          clinics must keep medical records and bills are needed for tax. They stay with each clinic under the
          patient&apos;s name, date of birth and medical record number, with no phone number, address or Aadhaar and no
          link to any login.
        </p>

        <h2 className="mt-6 font-display text-lg font-bold">Clinic and staff accounts</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          Sign in and open Delete account to send a request. We call you to confirm, then close the account.
        </p>
      </main>
    </div>
  );
}
