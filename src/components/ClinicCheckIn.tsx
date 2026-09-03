import { Banknote, CheckCircle2, CreditCard, IdCard, QrCode as QrCodeIcon, Search, UserCheck, UserX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { autoMarkNoShows, checkInAppointment, looksLikeBookingQr, lookupCheckIn } from '../lib/checkIn';
import { ageFromDob, todayISO } from '../lib/date';
import { bookingReference } from '../lib/queue';
import { supabase } from '../lib/supabaseClient';
import { formatTimeLabel } from '../lib/time';
import { PAYMENT_STATUS_LABEL, type AppointmentPaymentStatus, type CheckInLookup } from '../lib/types';
import PatientAvatar from './ui/PatientAvatar';
import QrScanner from './QrScanner';
import Button from './ui/Button';
import Card from './ui/Card';
import IconTile from './ui/IconTile';
import SectionTitle from './ui/SectionTitle';
import StatusPill from './ui/StatusPill';

interface Props {
  doctorId: string;
  date: string;
  clinicId: string;
  /** Bumped after every successful check-in so the waiting list reloads. */
  onCheckedIn: () => void;
}

interface ExpectedRow {
  id: string;
  slot_time: string;
  status: string;
  no_show_auto: boolean;
  payment_status: AppointmentPaymentStatus;
  family_members: {
    name: string;
    phone: string | null;
    mrn: string;
    gender: string | null;
    dob: string | null;
  } | null;
}

// Payment is shown next to the patient purely so the desk knows whether to
// collect money. It has NO bearing on the queue: an unpaid patient who is
// here is ahead of a paid one who isn't. See schema.sql section 30.
const PAYMENT_TONE: Record<AppointmentPaymentStatus, 'live' | 'warning' | 'neutral'> = {
  paid_online: 'live',
  paid_at_clinic: 'live',
  pay_at_clinic: 'warning',
  refunded: 'neutral',
};

interface Outcome {
  tone: 'ok' | 'repeat' | 'error';
  title: string;
  detail?: string;
  token?: number;
  patientName?: string;
}

// The arrivals desk. Two ways in - scan the patient's booking QR, or find
// them by name/phone/MRN and mark them arrived - both ending in the same
// check_in_appointment() call, which is what actually issues the token.
//
// Part 40 scoping is not re-implemented here: the query below is a plain
// select on `appointments`, so RLS already limits it to this clinic's own
// rows, and the check-in function independently refuses an appointment the
// caller's clinic doesn't own. A QR from another clinic simply won't match.
export default function ClinicCheckIn({ doctorId, date, clinicId, onCheckedIn }: Props) {
  const [expected, setExpected] = useState<ExpectedRow[]>([]);
  const [noShows, setNoShows] = useState<ExpectedRow[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [sweptCount, setSweptCount] = useState(0);
  // The scan/patient-ID preview card - identity, payment and the
  // pre-assigned number, shown BEFORE anything is written. See schema.sql
  // section 35.
  const [preview, setPreview] = useState<CheckInLookup | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [patientId, setPatientId] = useState('');

  const isToday = date === todayISO();

  const load = useCallback(async () => {
    if (!doctorId) {
      setExpected([]);
      setNoShows([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('appointments')
      .select(
        'id, slot_time, status, no_show_auto, payment_status, family_members(name, phone, mrn, gender, dob)'
      )
      .eq('doctor_id', doctorId)
      .eq('date', date)
      .in('status', ['accepted', 'no_show'])
      .order('slot_time', { ascending: true });
    const rows = (data ?? []) as unknown as ExpectedRow[];
    setExpected(rows.filter((r) => r.status === 'accepted'));
    setNoShows(rows.filter((r) => r.status === 'no_show'));
    setLoading(false);
  }, [doctorId, date]);

  // Sweep unarrived patients into no_show whenever the desk opens this
  // screen. pg_cron does the same job on a schedule where it's available -
  // this makes the behaviour reliable on projects where it isn't, and means
  // the list is honest the moment a receptionist looks at it.
  useEffect(() => {
    if (!clinicId || !isToday) return;
    autoMarkNoShows(clinicId).then((count) => {
      setSweptCount(count);
      if (count > 0) load();
    });
  }, [clinicId, isToday, load]);

  useEffect(() => {
    load();
  }, [load]);

  const runCheckIn = async (
    appointmentId: string,
    method: 'clinic_scan' | 'manual',
    name?: string,
    allowLate = false
  ) => {
    setBusy(true);
    const result = await checkInAppointment(appointmentId, method, allowLate);
    setBusy(false);

    if (!result.ok) {
      setOutcome({ tone: 'error', title: 'Could not check in', detail: result.error });
      return;
    }
    setOutcome({
      tone: result.alreadyCheckedIn ? 'repeat' : 'ok',
      title: result.alreadyCheckedIn
        ? 'Already checked in'
        : result.wasLate
          ? 'Checked in (late)'
          : 'Checked in',
      detail: result.wasLate && !result.alreadyCheckedIn
        ? 'Arrived after their slot — they join the queue at their arrival position.'
        : undefined,
      token: result.token,
      patientName: name,
    });
    await load();
    onCheckedIn();
  };

  // Taking cash at the counter. Note what this does NOT do: it never touches
  // checked_in_at, and it never issues a token. Settling up and turning up
  // are different events.
  const markPaid = async (appointmentId: string) => {
    setBusy(true);
    const { error } = await supabase.rpc('mark_paid_at_clinic', { p_appointment_id: appointmentId });
    setBusy(false);
    if (error) {
      setOutcome({ tone: 'error', title: 'Could not record payment', detail: error.message });
      return;
    }
    await load();
  };

  // A scan can hand us anything the camera happened to see. The shape check
  // is only to fail fast on an obviously unrelated code (a UPI QR, a product
  // barcode) - the code's SIGNATURE and expiry are verified inside
  // lookup_checkin(), never here, so a doctored string can't get through by
  // looking right.
  //
  // Scanning no longer checks anyone in by itself - it only resolves the
  // code to a preview card (identity, photo, pre-assigned number, payment).
  // "Check in" on that card is the one thing that actually writes anything.
  const handleScan = async (raw: string) => {
    setPreviewError(null);
    setOutcome(null);
    if (!looksLikeBookingQr(raw)) {
      setPreviewError("That QR isn't a SanjeevniOS booking code. Use the patient ID instead.");
      return;
    }

    setBusy(true);
    const result = await lookupCheckIn(clinicId, { code: raw });
    setBusy(false);

    if ('error' in result) {
      setPreviewError(result.error);
      setPreview(null);
      return;
    }
    setScanning(false);
    setPreview(result);
  };

  // Typing (or scanning a barcode reader into) the patient's MRN - the "or
  // types the patient ID" path.
  const lookupById = async () => {
    if (!patientId.trim()) return;
    setPreviewError(null);
    setOutcome(null);
    setBusy(true);
    const result = await lookupCheckIn(clinicId, { mrn: patientId });
    setBusy(false);

    if ('error' in result) {
      setPreviewError(result.error);
      setPreview(null);
      return;
    }
    setPreview(result);
  };

  // The one thing the preview card's "Check in" button does. Uses the
  // ordinary check_in_appointment() path - the same function every other
  // check-in route in this app calls - so the arrival guardrails and the
  // no-show override are identical everywhere.
  const confirmPreviewCheckIn = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await checkInAppointment(
      preview.appointmentId,
      'clinic_scan',
      preview.status === 'no_show'
    );
    setBusy(false);

    if (!result.ok) {
      setOutcome({ tone: 'error', title: 'Could not check in', detail: result.error });
      return;
    }
    setOutcome({
      tone: result.alreadyCheckedIn ? 'repeat' : 'ok',
      title: result.alreadyCheckedIn
        ? 'Already checked in'
        : result.wasLate
          ? 'Checked in (late)'
          : 'Checked in',
      token: result.token,
      patientName: preview.patientName,
    });
    setPreview(null);
    setPatientId('');
    await load();
    onCheckedIn();
  };

  const markPaidForPreview = async () => {
    if (!preview) return;
    setBusy(true);
    const { error } = await supabase.rpc('mark_paid_at_clinic', { p_appointment_id: preview.appointmentId });
    setBusy(false);
    if (error) {
      setPreviewError(error.message);
      return;
    }
    setPreview({ ...preview, paymentStatus: 'paid_at_clinic' });
  };

  const q = query.trim().toLowerCase();
  const matches = q
    ? expected.filter((r) => {
        const m = r.family_members;
        if (!m) return false;
        return (
          m.name.toLowerCase().includes(q) ||
          (m.phone ?? '').includes(q.replace(/\D/g, '')) ||
          m.mrn.toLowerCase().includes(q)
        );
      })
    : expected;

  return (
    <div>
      {scanning && (
        <QrScanner
          onScan={handleScan}
          onClose={() => setScanning(false)}
          hint={
            outcome?.token != null
              ? `Last scan: ${outcome.patientName ?? 'patient'} — token #${outcome.token}`
              : undefined
          }
        />
      )}

      {previewError && !preview && (
        <div className="mt-4 rounded-2xl bg-red-50 p-3.5 text-sm text-red-700">
          {previewError}
          <button onClick={() => setPreviewError(null)} className="ml-2 font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* The scan/patient-ID preview - name, photo, pre-assigned number and
          time, and payment, all shown before "Check in" writes anything. */}
      {preview && (
        <Card className="mt-4 !border-brand-300">
          <div className="flex items-start gap-3">
            <PatientAvatar photoPath={preview.photoPath} name={preview.patientName} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-slate-900">{preview.patientName}</p>
              <p className="truncate text-xs text-slate-400">
                {preview.mrn}
                {preview.dob ? ` · ${ageFromDob(preview.dob)}y` : ''}
                {preview.gender ? ` · ${preview.gender}` : ''}
              </p>
              <p className="text-sm font-medium text-brand-600">
                {preview.doctorName} · slot {formatTimeLabel(preview.slotTime)}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {preview.sequenceNo != null ? (
              <StatusPill
                label={`Expected #${preview.sequenceNo}${preview.estimatedTime ? ` · ~${formatTimeLabel(preview.estimatedTime)}` : ''}`}
                tone="info"
              />
            ) : (
              <StatusPill label="Not yet published" tone="neutral" />
            )}
            {preview.status === 'no_show' && <StatusPill label="Marked no-show" tone="danger" />}
          </div>

          {/* Payment: green "Paid" once settled either way, otherwise the
              exact amount to collect and the button to record it - never a
              reason to hold up check-in. See schema.sql section 30. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50 px-3 py-2.5">
            {preview.paymentStatus === 'pay_at_clinic' ? (
              <>
                <Banknote size={16} className="text-amber-600" />
                <span className="text-sm font-bold text-amber-700">
                  Collect ₹{preview.amountDue ?? 0}
                </span>
                <Button variant="secondary" onClick={markPaidForPreview} disabled={busy}>
                  Mark paid
                </Button>
              </>
            ) : (
              <>
                <CreditCard size={16} className="text-emerald-600" />
                <StatusPill label={PAYMENT_STATUS_LABEL[preview.paymentStatus]} tone="live" />
              </>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {preview.alreadyCheckedIn ? (
              <StatusPill label={`Already checked in — token #${preview.tokenNumber}`} tone="live" />
            ) : (
              <Button onClick={confirmPreviewCheckIn} disabled={busy || !isToday}>
                <CheckCircle2 size={16} /> Check in
              </Button>
            )}
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
              Dismiss
            </Button>
          </div>
        </Card>
      )}

      {/* Result of the last check-in, with the token big enough to read out loud */}
      {outcome && (
        <div
          className={`mt-4 rounded-3xl p-5 text-center ${
            outcome.tone === 'error'
              ? 'bg-red-50 text-red-700'
              : outcome.tone === 'repeat'
                ? 'bg-amber-50 text-amber-800'
                : 'bg-emerald-50 text-emerald-800'
          }`}
        >
          <div className="flex items-center justify-center gap-2 text-sm font-bold">
            {outcome.tone !== 'error' && <CheckCircle2 size={17} />}
            {outcome.title}
            {outcome.patientName ? ` — ${outcome.patientName}` : ''}
          </div>
          {outcome.token != null && (
            <>
              <p className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">Token number</p>
              <p className="text-6xl font-extrabold leading-none">{outcome.token}</p>
            </>
          )}
          {outcome.detail && <p className="mt-1 text-sm">{outcome.detail}</p>}
          <button onClick={() => setOutcome(null)} className="mt-3 text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* 1. Scan */}
      <div className="mt-4">
        <Button full onClick={() => setScanning(true)} disabled={!isToday || busy}>
          <QrCodeIcon size={18} /> Scan patient QR
        </Button>
        {!isToday && (
          <p className="mt-1.5 text-center text-xs text-slate-400">
            Check-in is only possible on the day of the appointment.
          </p>
        )}
      </div>

      {/* 1b. Patient ID - the other half of "scan or type the patient ID" */}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
          <IdCard size={17} className="shrink-0 text-slate-400" />
          <input
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookupById()}
            placeholder="Patient ID (MRN-00000000)"
            className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </div>
        <Button onClick={lookupById} disabled={busy || !patientId.trim() || !isToday}>
          Look up
        </Button>
      </div>

      {/* 2. Manual */}
      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={load}>
        Mark arrived
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        For walk-ups whose phone is dead, or anyone you'd rather find by hand. Search by name, phone or MRN.
      </p>

      <div className="mt-2 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
        <Search size={17} className="shrink-0 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name, phone or MRN"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
        />
      </div>

      <div className="mt-3 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && expected.length === 0 && (
          <p className="text-sm text-slate-400">Nobody left to check in for this date.</p>
        )}
        {!loading && expected.length > 0 && matches.length === 0 && (
          <p className="text-sm text-slate-400">No one expected today matches "{query}".</p>
        )}

        {matches.map((r) => (
          <Card key={r.id}>
            <div className="flex items-center gap-3">
              <IconTile icon={UserCheck} tone="amber" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-slate-900">{r.family_members?.name ?? 'Patient'}</p>
                <p className="truncate text-xs text-slate-400">
                  {r.family_members?.mrn}
                  {r.family_members?.dob ? ` · ${ageFromDob(r.family_members.dob)}y` : ''}
                  {r.family_members?.phone ? ` · +${r.family_members.phone}` : ''}
                </p>
                <p className="text-sm font-medium text-brand-600">
                  slot {formatTimeLabel(r.slot_time)}
                  <span className="font-mono text-xs text-slate-400"> · ref {bookingReference(r.id)}</span>
                </p>
              </div>
              <StatusPill
                label={PAYMENT_STATUS_LABEL[r.payment_status]}
                tone={PAYMENT_TONE[r.payment_status]}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                onClick={() => runCheckIn(r.id, 'manual', r.family_members?.name)}
                disabled={busy || !isToday}
              >
                <CheckCircle2 size={16} /> Mark arrived
              </Button>
              {r.payment_status === 'pay_at_clinic' && (
                <Button variant="secondary" onClick={() => markPaid(r.id)} disabled={busy}>
                  <Banknote size={16} /> Mark paid
                </Button>
              )}
            </div>
            {r.payment_status === 'paid_online' && (
              <p className="mt-1.5 text-xs text-slate-400">
                Nothing to collect — but they still need to be checked in like anyone else.
              </p>
            )}
          </Card>
        ))}
      </div>

      {/* No-shows: written off, but still admittable if they walk in. */}
      {noShows.length > 0 && (
        <>
          <SectionTitle className="mt-8">Marked as no-show ({noShows.length})</SectionTitle>
          <p className="mt-0.5 text-xs text-slate-400">
            Never arrived before the cut-off{sweptCount > 0 ? ` (${sweptCount} written off just now)` : ''}. If one
            of them turns up after all, admit them here — they get the next token, like a walk-in.
          </p>
          <div className="mt-2 space-y-2">
            {noShows.map((r) => (
              <Card key={r.id}>
                <div className="flex items-center gap-3">
                  <IconTile icon={UserX} tone="slate" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-slate-900">{r.family_members?.name ?? 'Patient'}</p>
                    <p className="truncate text-xs text-slate-400">
                      {r.family_members?.mrn}
                      {r.family_members?.phone ? ` · +${r.family_members.phone}` : ''}
                    </p>
                    <p className="text-sm text-slate-500">
                      slot {formatTimeLabel(r.slot_time)}
                      <span className="text-slate-400">
                        {' '}
                        · {r.no_show_auto ? 'auto-marked at cut-off' : 'marked by the desk'}
                      </span>
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <Button
                    variant="outline"
                    onClick={() => runCheckIn(r.id, 'manual', r.family_members?.name, true)}
                    disabled={busy}
                  >
                    <CheckCircle2 size={16} /> Check in anyway
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
