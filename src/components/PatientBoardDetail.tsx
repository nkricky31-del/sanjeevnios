import { CheckCircle2, Phone, X, XCircle } from 'lucide-react';
import Loading from './ui/Loading';
import { motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL, type AppointmentStatus } from '../lib/types';
import { BOARD_STATUS, isCancelled, isCheckedIn, timeOf, type BoardRow } from '../lib/patientBoard';
import PatientProfile from './PatientProfile';
import StatusPill from './ui/StatusPill';

interface Props {
  row: BoardRow;
  clinicId: string;
  onClose: () => void;
}

interface EarlierVisit {
  id: string;
  date: string;
  slot_time: string;
  status: AppointmentStatus;
  checked_in_at: string | null;
  doctors: { name: string } | null;
}

const CHECK_IN_METHOD: Record<string, string> = {
  patient_scan: 'Patient scanned the clinic QR',
  clinic_scan: "Desk scanned the patient's QR",
  manual: 'Checked in at the desk',
};

const RELATION: Record<string, string> = {
  self: 'Account holder',
  daughter: 'Family member (daughter)',
  son: 'Family member (son)',
  mother: 'Family member (mother)',
  father: 'Family member (father)',
  spouse: 'Family member (spouse)',
  child: 'Family member (child)',
  parent: 'Family member (parent)',
};

const longDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-2">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

// One patient's details, opened from the patient board. A slide-over from
// the right (full screen on phones): the front desk's view of the patient
// (get_patient_contacts - nothing clinical), everything about this
// appointment, their earlier visits here, and - behind a button - the full
// patient record, which goes through the usual audited, permission-checked
// health-record access (PatientProfile).
export default function PatientBoardDetail({ row, clinicId, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [earlier, setEarlier] = useState<EarlierVisit[] | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const p = row.family_members;
  const inNow = isCheckedIn(row);
  const cancelled = isCancelled(row);
  const st = BOARD_STATUS[row.status];
  const payment = row.payments?.[0];
  const amount = row.payment_status === 'paid_at_clinic' && row.paid_amount != null ? row.paid_amount : payment?.net_amount ?? payment?.amount ?? null;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Focus moves in on open and back to where it was on close; Esc closes;
  // Tab stays inside the panel while it's open.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);

  // The board remounts this per patient (key={row.id}), so state starts fresh.
  useEffect(() => {
    supabase
      .from('appointments')
      .select('id, date, slot_time, status, checked_in_at, doctors(name)')
      .eq('clinic_id', clinicId)
      .eq('member_id', row.member_id)
      .neq('id', row.id)
      .order('date', { ascending: false })
      .order('slot_time', { ascending: false })
      .limit(5)
      .then(({ data }) => setEarlier((data ?? []) as unknown as EarlierVisit[]));
  }, [clinicId, row.id, row.member_id]);

  const phone = p?.phone ? `+${p.phone}` : null;
  const phonePretty = p?.phone && p.phone.length === 12 ? `+${p.phone.slice(0, 2)} ${p.phone.slice(2, 7)} ${p.phone.slice(7)}` : phone;

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-slate-900/30"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={() => onClose()}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="board-detail-title"
        className="absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-2xl sm:w-[460px]"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ type: 'tween', duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
          {inNow ? (
            <CheckCircle2 size={26} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <XCircle size={26} className={`mt-0.5 shrink-0 ${cancelled ? 'text-slate-400' : 'text-rose-500'}`} aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="board-detail-title" className="truncate text-lg font-bold text-slate-900">
              {p?.name ?? 'Patient'}
            </h2>
            <p className={`text-sm font-semibold ${inNow ? 'text-emerald-700' : cancelled ? 'text-slate-500' : 'text-rose-600'}`}>
              {inNow ? `Checked in at ${timeOf(row.checked_in_at!)}` : cancelled ? 'Booking cancelled' : 'Not checked in'}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={() => onClose()}
            aria-label="Close patient details"
            title="Close"
            className="rounded-xl p-2 text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-8">
          <section className="mt-4">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Patient</h3>
            <dl className="mt-1 divide-y divide-slate-100">
              <Row label="MRN">
                <span className="font-mono">{p?.mrn ?? '—'}</span>
              </Row>
              <Row label="Age · gender">
                {[p?.age != null ? `${p.age} years` : null, p?.gender].filter(Boolean).join(' · ') || '—'}
              </Row>
              <Row label="Phone">
                {phone ? (
                  <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 font-semibold text-brand-700 hover:underline">
                    <Phone size={14} aria-hidden /> {phonePretty}
                  </a>
                ) : (
                  '—'
                )}
              </Row>
              <Row label="On the account as">{(p?.relation && RELATION[p.relation]) ?? '—'}</Row>
            </dl>
          </section>

          <section className="mt-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">This appointment</h3>
            <dl className="mt-1 divide-y divide-slate-100">
              <Row label="Doctor">
                {row.doctors?.name ?? '—'}
                {row.doctors?.specialty && <span className="text-slate-500"> · {row.doctors.specialty}</span>}
              </Row>
              <Row label="Date">{longDate(row.date)}</Row>
              <Row label="Appointment time">{formatTimeLabel(row.slot_time)}</Row>
              <Row label="Status">
                <StatusPill label={st.label} tone={st.tone} />
              </Row>
              <Row label="Checked in">
                {row.checked_in_at ? (
                  <>
                    <span className="font-semibold text-emerald-700">{timeOf(row.checked_in_at)}</span>
                    {row.was_late && <span className="text-amber-600"> · arrived late</span>}
                    {row.check_in_method && (
                      <span className="block text-xs text-slate-500">{CHECK_IN_METHOD[row.check_in_method] ?? row.check_in_method}</span>
                    )}
                  </>
                ) : (
                  <span className="text-rose-600">Not yet</span>
                )}
              </Row>
              <Row label="Token">{row.token_number != null ? <span className="font-mono font-bold">#{row.token_number}</span> : '—'}</Row>
              <Row label="Booking ref">
                <span className="font-mono">{bookingReference(row.id)}</span>
              </Row>
              {row.encounters?.encounter_no && (
                <Row label="Encounter no.">
                  <span className="font-mono">{row.encounters.encounter_no}</span>
                </Row>
              )}
              <Row label="Booked">
                {row.patient_type === 'walk_in' ? 'Walk-in at the desk' : 'Booked ahead'} ·{' '}
                {new Date(row.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
              </Row>
              <Row label="Reason for visit">{row.reason?.trim() || '—'}</Row>
              <Row label="Payment">
                {PAYMENT_STATUS_LABEL[row.payment_status]}
                {amount != null && <span className="text-slate-500"> · ₹{Number(amount).toLocaleString('en-IN')}</span>}
              </Row>
              {row.reject_reason && <Row label="Cancellation reason">{row.reject_reason}</Row>}
            </dl>
          </section>

          <section className="mt-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Earlier visits at this clinic</h3>
            {earlier === null && <p className="mt-2 text-sm text-slate-400"><Loading size="sm" /></p>}
            {earlier !== null && earlier.length === 0 && <p className="mt-2 text-sm text-slate-500">First visit here.</p>}
            {earlier !== null && earlier.length > 0 && (
              <ul className="mt-1 divide-y divide-slate-100">
                {earlier.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block text-slate-900">
                        {longDate(v.date)} · {formatTimeLabel(v.slot_time)}
                      </span>
                      <span className="block truncate text-xs text-slate-500">{v.doctors?.name ?? 'Doctor'}</span>
                    </span>
                    <StatusPill label={BOARD_STATUS[v.status].label} tone={BOARD_STATUS[v.status].tone} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {p?.mrn && (
            <section className="mt-5">
              <button
                type="button"
                onClick={() => setShowRecord((s) => !s)}
                aria-expanded={showRecord}
                className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {showRecord ? 'Hide full patient record' : 'Open full patient record'}
              </button>
              {showRecord && (
                <div className="mt-3">
                  <PatientProfile mrn={p.mrn} />
                </div>
              )}
            </section>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
