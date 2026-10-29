import { AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Loading from '../components/ui/Loading';
import ScreenHeader from '../components/ui/ScreenHeader';
import {
  deleteMyAccount,
  getDeletionStatus,
  requestAccountClosure,
  signOutDeleted,
  withdrawAccountClosure,
  type DeletionStatus,
} from '../lib/accountDeletion';

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// Profile > Delete account, for every role (and /delete-account on the
// website, which Google Play links to). A patient deletes their account here;
// a clinic owner, clinic staff number or SanjeevniOS staff member sends a
// request instead (migration 91 explains what's deleted and what clinics keep).
export default function DeleteAccount() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [reason, setReason] = useState('');
  const deleteButton = useRef<HTMLButtonElement | null>(null);

  const load = async () => {
    try {
      setStatus(await getDeletionStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your account.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteMyAccount();
    setBusy(false);
    setConfirming(false);
    if ('error' in result) {
      setError(result.error);
      void load();
      return;
    }
    setDeleted(true);
  };

  const finish = async () => {
    navigate('/', { replace: true });
    await signOutDeleted();
  };

  const sendRequest = async () => {
    setBusy(true);
    setError(null);
    const result = await requestAccountClosure(reason);
    setBusy(false);
    if ('error' in result) setError(result.error);
    else void load();
  };

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    const result = await withdrawAccountClosure();
    setBusy(false);
    if ('error' in result) setError(result.error);
    else void load();
  };

  if (deleted) {
    return (
      <div>
        <ScreenHeader title="Account deleted" home={false} />
        <div className="mx-auto max-w-3xl px-4 py-8">
          <Card className="flex flex-col items-center gap-3 p-6 text-center">
            <CheckCircle2 size={36} className="text-emerald-600" aria-hidden />
            <h1 className="font-display text-xl font-bold text-slate-900">Your account is deleted</h1>
            <p className="max-w-md text-sm leading-relaxed text-slate-600">
              Your login and personal details are gone. The clinics you visited keep the records of those visits, as
              the law requires, with no link to you. Thank you for using SanjeevniOS.
            </p>
            <Button onClick={() => void finish()} className="mt-2">
              Done
            </Button>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader title="Delete account" back={-1} fallback="/profile" />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 pb-28 lg:pb-8">
        {!status && !loadError && <Loading />}
        {loadError && (
          <Card className="p-4">
            <p className="text-sm text-red-600">{loadError}</p>
            <Button variant="outline" onClick={() => void load()} className="mt-3">
              Try again
            </Button>
          </Card>
        )}

        {status?.mode === 'self' && (
          <>
            <p className="text-sm leading-relaxed text-slate-600">
              Deleting your account signs you out and can&apos;t be undone. If you sign up again with this phone
              number later, you&apos;ll start a new, empty account.
            </p>

            <Card className="p-4">
              <h2 className="font-display text-base font-bold text-slate-900">Deleted straight away</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-600">
                <li>Your login - this phone number can no longer sign in to this account.</li>
                <li>Your profile, contact details, Aadhaar numbers and photos.</li>
                <li>Family members who have never visited a clinic.</li>
                <li>Reports you uploaded yourself, your reviews, notifications and name-change requests.</li>
              </ul>
            </Card>

            <Card className="p-4">
              <h2 className="font-display text-base font-bold text-slate-900">Kept by the clinics you visited</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                The records of your past visits - notes, prescriptions, reports from the visit, bills and payments.
                Clinics must keep medical records, and bills are needed for tax. They stay with each clinic under the
                patient&apos;s name, date of birth and medical record number, with no phone number, address or Aadhaar,
                and no link to any login.
              </p>
            </Card>

            {status.upcoming > 0 && (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
                <div>
                  <p className="font-semibold">
                    You have {status.upcoming === 1 ? 'an appointment' : `${status.upcoming} appointments`} coming up.
                  </p>
                  <p className="mt-1">Cancel {status.upcoming === 1 ? 'it' : 'them'} first, then come back here.</p>
                  <Button variant="outline" onClick={() => navigate('/bookings')} className="mt-3 bg-white">
                    Go to appointments
                  </Button>
                </div>
              </div>
            )}

            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

            <button
              ref={deleteButton}
              type="button"
              disabled={status.upcoming > 0 || busy}
              onClick={() => setConfirming(true)}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl bg-red-600 py-3.5 text-sm font-bold text-white outline-none transition hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={17} aria-hidden /> Delete my account
            </button>
          </>
        )}

        {status?.mode === 'request' && (
          <>
            <p className="text-sm leading-relaxed text-slate-600">
              Clinic and staff accounts are closed by the SanjeevniOS team, so the clinic&apos;s patient records,
              payouts and staff logins are handled properly.
            </p>
            <Card className="p-4">
              <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-600">
                <li>We&apos;ll call you on your registered number to confirm, then close the account.</li>
                <li>Patient records your clinic created are kept for as long as the law requires.</li>
                <li>Until then, everything keeps working, and you can withdraw the request.</li>
              </ul>
            </Card>

            {status.pending_request ? (
              <Card className="p-4">
                <p className="text-sm font-semibold text-slate-900">
                  Request sent on {DATE.format(new Date(status.pending_request.created_at))}
                </p>
                <p className="mt-1 text-sm text-slate-600">We&apos;ll be in touch on your registered number.</p>
                {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
                <Button variant="outline" disabled={busy} onClick={() => void withdraw()} className="mt-3">
                  Withdraw request
                </Button>
              </Card>
            ) : (
              <Card className="p-4">
                <label htmlFor="closure-reason" className="text-sm font-semibold text-slate-900">
                  Anything we should know? (optional)
                </label>
                <textarea
                  id="closure-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={1000}
                  rows={3}
                  className="mt-2 w-full rounded-xl border border-slate-200 p-3 text-sm"
                />
                {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
                <Button disabled={busy} onClick={() => void sendRequest()} className="mt-3">
                  {busy ? 'Sending…' : 'Send request'}
                </Button>
              </Card>
            )}
          </>
        )}
      </div>

      {confirming && (
        <ConfirmDelete
          busy={busy}
          onCancel={() => {
            setConfirming(false);
            deleteButton.current?.focus();
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

// "Delete your SanjeevniOS account?" - Cancel has the focus, Escape or a tap
// outside closes it, and Tab stays inside.
function ConfirmDelete({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const buttons = Array.from(panelRef.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div aria-hidden className="absolute inset-0 bg-slate-900/50" onClick={() => !busy && cancel.current()} />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
      >
        <h2 id={titleId} className="font-display text-lg font-bold text-slate-900">
          Delete your SanjeevniOS account?
        </h2>
        <p id={bodyId} className="mt-2 text-sm leading-relaxed text-slate-600">
          This can&apos;t be undone. Your login and personal details are deleted now; clinics keep the records of your
          past visits.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={() => cancel.current()}
            className="inline-flex cursor-pointer items-center justify-center rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-200 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </div>
    </div>
  );
}
