import { CalendarRange, Printer, Users } from 'lucide-react';
import { CapacityChart } from './Insights';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { todayISO } from '../lib/date';
import { type PatientContact, withPatientContacts } from '../lib/patientContact';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, ClinicMode } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import Segmented from './ui/Segmented';
import StatusPill from './ui/StatusPill';
import Toggle from './ui/Toggle';

interface Props {
  clinic: Clinic;
  onSaved: (patch: Partial<Clinic>) => void;
}

interface WaitlistRow {
  id: string;
  date: string;
  status: string;
  created_at: string;
  member_id: string;
  // Minimal patient contact (migration 68's patient_contact view).
  family_members: PatientContact | null;
}

// How this clinic takes patients, plus the waitlist that the appointment-only
// mode generates. Kept together because the waitlist only exists as a
// consequence of the cap.
export default function ClinicBookingMode({ clinic, onSaved }: Props) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ClinicMode>(clinic.mode ?? 'allow_walkins');
  const [horizon, setHorizon] = useState(String(clinic.booking_horizon_days ?? 1));
  const [cap, setCap] = useState(String(clinic.daily_cap ?? 100));
  // Same-day booking on top of appointment_only mode (schema.sql section 37)
  // - meaningless outside that mode, so the inputs below only enable there.
  const [sameDayEnabled, setSameDayEnabled] = useState(clinic.same_day_booking_enabled ?? false);
  const [sameDayCutoff, setSameDayCutoff] = useState(String(clinic.same_day_cutoff_minutes ?? 30));
  // Section 50 - plays the same role as sameDayCutoff above, but for every
  // OTHER case (allow_walkins, or appointment_only without same-day booking
  // turned on) - so unlike sameDayCutoff it's never disabled here.
  const [pastSlotBuffer, setPastSlotBuffer] = useState(String(clinic.past_slot_buffer_minutes ?? 10));
  // Section 40 - unlike the fields above, this applies in BOTH modes, so
  // it's never disabled by the appointmentOnly gate the rest of this form
  // uses.
  const [reportBefore, setReportBefore] = useState(String(clinic.report_before_minutes ?? 30));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([]);
  // Self check-in (sections 28 and 84) - saved separately from the booking
  // mode above, since it's about arrival rather than booking.
  const [selfEnabled, setSelfEnabled] = useState(clinic.self_checkin_enabled ?? false);
  const [openBefore, setOpenBefore] = useState(String(clinic.checkin_open_before_minutes ?? 60));
  const [selfSaving, setSelfSaving] = useState(false);
  const [selfError, setSelfError] = useState<string | null>(null);
  const [selfNote, setSelfNote] = useState<string | null>(null);
  const hasLocation = clinic.lat != null && clinic.lng != null;

  const saveSelfCheckIn = async () => {
    setSelfError(null);
    setSelfNote(null);
    const openNum = Number(openBefore);
    if (!Number.isInteger(openNum) || openNum < 5 || openNum > 180) {
      setSelfError('Check-in opening must be between 5 and 180 minutes before the slot.');
      return;
    }
    if (selfEnabled && !hasLocation) {
      setSelfError("Set your clinic's map location in the Location tab first - self check-in uses it to confirm patients are at the clinic.");
      return;
    }
    setSelfSaving(true);
    const patch = { self_checkin_enabled: selfEnabled, checkin_open_before_minutes: openNum };
    const { error: saveError } = await supabase.from('clinics').update(patch).eq('id', clinic.id);
    setSelfSaving(false);
    if (saveError) {
      setSelfError(saveError.message);
      return;
    }
    onSaved(patch);
    setSelfNote('Saved.');
  };

  const loadWaitlist = useCallback(async () => {
    const { data } = await supabase
      .from('waitlist')
      .select('id, date, status, created_at, member_id')
      .eq('clinic_id', clinic.id)
      .gte('date', todayISO())
      .in('status', ['waiting', 'offered'])
      .order('date', { ascending: true })
      .order('created_at', { ascending: true });
    setWaitlist(await withPatientContacts((data ?? []) as unknown as Omit<WaitlistRow, 'family_members'>[]));
  }, [clinic.id]);

  useEffect(() => {
    loadWaitlist();
  }, [loadWaitlist]);

  const save = async () => {
    setError(null);
    setNote(null);
    const horizonNum = Number(horizon);
    const capNum = Number(cap);
    const cutoffNum = Number(sameDayCutoff);
    const pastSlotBufferNum = Number(pastSlotBuffer);
    const reportBeforeNum = Number(reportBefore);
    if (!Number.isInteger(horizonNum) || horizonNum < 1 || horizonNum > 90) {
      setError('Booking horizon must be between 1 and 90 days.');
      return;
    }
    if (!Number.isInteger(capNum) || capNum < 1) {
      setError('Daily cap must be at least 1.');
      return;
    }
    if (!Number.isInteger(cutoffNum) || cutoffNum < 0) {
      setError('Same-day cutoff must be 0 or more minutes.');
      return;
    }
    if (!Number.isInteger(pastSlotBufferNum) || pastSlotBufferNum < 0) {
      setError('Past-slot buffer must be 0 or more minutes.');
      return;
    }
    if (!Number.isInteger(reportBeforeNum) || reportBeforeNum < 1) {
      setError('Reporting time buffer must be at least 1 minute.');
      return;
    }

    setSaving(true);
    const patch = {
      mode,
      booking_horizon_days: horizonNum,
      daily_cap: capNum,
      same_day_booking_enabled: sameDayEnabled,
      same_day_cutoff_minutes: cutoffNum,
      past_slot_buffer_minutes: pastSlotBufferNum,
      report_before_minutes: reportBeforeNum,
    };
    const { error: saveError } = await supabase.from('clinics').update(patch).eq('id', clinic.id);
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      return;
    }
    onSaved(patch);
    setNote('Saved.');
  };

  const appointmentOnly = mode === 'appointment_only';

  return (
    <div>
      <SectionTitle>Booking mode</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        How this clinic takes patients. Changing it affects new bookings only — anything already booked stands.
      </p>

      <CapacityChart clinicId={clinic.id} cap={clinic.daily_cap ?? 100} />

      <Card className="mt-2">
        <Segmented
          options={[
            { value: 'allow_walkins', label: 'Walk-ins allowed' },
            { value: 'appointment_only', label: 'Appointment only' },
          ]}
          value={mode}
          onChange={setMode}
        />

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          {appointmentOnly ? (
            <>
              Patients book <strong>in advance only</strong> — no walk-ins from the app or this desk, and no
              same-day bookings unless you turn that on below. Bookings inside the daily cap are confirmed
              automatically; you can still cancel any individual one. When a day is full, patients are offered the
              waitlist or the next day with room.
            </>
          ) : (
            <>
              Same-day bookings and walk-ins are accepted, and you approve bookings yourself from the inbox. The
              daily cap, horizon and same-day settings below don't apply in this mode.
            </>
          )}
        </p>

        <div className={`mt-4 grid grid-cols-2 gap-3 ${appointmentOnly ? '' : 'opacity-50'}`}>
          <div>
            <label className="text-xs font-bold text-slate-700">Days ahead patients can book</label>
            <input
              type="number"
              min={1}
              max={90}
              value={horizon}
              onChange={(e) => setHorizon(e.target.value)}
              disabled={!appointmentOnly}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-[11px] text-slate-400">1 = tomorrow only.</p>
          </div>
          <div>
            <label className="text-xs font-bold text-slate-700">Patients per day</label>
            <input
              type="number"
              min={1}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              disabled={!appointmentOnly}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-[11px] text-slate-400">Across the whole clinic.</p>
          </div>
        </div>

        {/* Past-slot buffer (section 50) - always on, in every mode, so a
            same-day slot that's already started (or about to) can never be
            booked. An appointment_only clinic with same-day booking turned
            on uses its own cutoff below instead once that applies. */}
        <div className="mt-4 rounded-2xl border border-slate-100 p-3">
          <label className="text-xs font-bold text-slate-700">Past-slot buffer (minutes)</label>
          <input
            type="number"
            min={0}
            value={pastSlotBuffer}
            onChange={(e) => setPastSlotBuffer(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            A same-day slot that has already started, or starts within this many minutes, is greyed out and can't be
            booked. Applies in every mode except when the same-day cutoff below is the one in effect.
          </p>
        </div>

        {/* Reporting time (section 40) - applies to every accepted booking in
            either mode, so unlike the fields above it's never disabled. */}
        <div className="mt-4 rounded-2xl border border-slate-100 p-3">
          <label className="text-xs font-bold text-slate-700">Reporting time (minutes before slot)</label>
          <input
            type="number"
            min={1}
            value={reportBefore}
            onChange={(e) => setReportBefore(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            How long before their slot an accepted patient is told to arrive by. Shown on their booking as
            "Reporting time" and sent once as a reminder as it approaches. Capped at the check-in opening time set
            under Patient self check-in below, so patients are never asked to arrive before they can check in.
          </p>
        </div>

        {/* Same-day booking on top of appointment_only mode - schema.sql
            section 37. Auto-check-in for a verified-present same-day booking
            (its radius, and walk-in registration itself) stays SQL-only for
            now, same as self check-in's own settings (section 28.3). */}
        <div className={`mt-4 rounded-2xl border border-slate-100 p-3 ${appointmentOnly ? '' : 'opacity-50'}`}>
          <label className="flex items-center justify-between gap-2 text-xs font-bold text-slate-700">
            Allow same-day booking
            <input
              type="checkbox"
              checked={sameDayEnabled}
              onChange={(e) => setSameDayEnabled(e.target.checked)}
              disabled={!appointmentOnly}
              className="h-4 w-4"
            />
          </label>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            On top of advance booking above — a patient can also book (or walk in) for today. A booking made from
            the clinic itself is checked in right away if this clinic's auto-check-in setting is on and the app can
            confirm the patient's location; a booking made remotely just waits and checks in at arrival, like any
            advance booking.
          </p>
          <div className="mt-3">
            <label className="text-xs font-bold text-slate-700">Same-day cutoff (minutes before a slot)</label>
            <input
              type="number"
              min={0}
              value={sameDayCutoff}
              onChange={(e) => setSameDayCutoff(e.target.value)}
              disabled={!appointmentOnly || !sameDayEnabled}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              A same-day slot inside this window (or already passed) can no longer be booked.
            </p>
          </div>
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {note && !error && <p className="mt-2 text-sm font-semibold text-emerald-600">{note}</p>}

        <Button onClick={save} disabled={saving} className="mt-3">
          {saving ? 'Saving...' : 'Save booking mode'}
        </Button>
      </Card>

      {/* Self check-in: the patient scans the clinic's QR from their booking
          and gets a token with no one at the desk (migration 84). */}
      <SectionTitle className="mt-6">Patient self check-in</SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Patients scan the clinic's QR at reception from their booking and get a token straight away. The desk can
        still check anyone in by scanning their code or searching by name, phone or MRN.
      </p>
      <Card className="mt-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-slate-900">Let patients check themselves in</span>
          <Toggle
            checked={selfEnabled}
            onChange={setSelfEnabled}
            label="Let patients check themselves in"
            onLabel="On"
            offLabel="Off"
          />
        </div>
        {!hasLocation && (
          <p className="mt-2 text-xs font-semibold text-amber-700">
            Set your clinic's map location in the Location tab before turning this on.
          </p>
        )}

        <div className="mt-4 rounded-2xl border border-slate-100 p-3">
          <label htmlFor="checkin-open-before" className="text-xs font-bold text-slate-700">
            Check-in opens (minutes before slot)
          </label>
          <input
            id="checkin-open-before"
            type="number"
            min={5}
            max={180}
            value={openBefore}
            onChange={(e) => setOpenBefore(e.target.value)}
            className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            Applies to every check-in, at the desk and by scan. Check-in closes {clinic.checkin_grace_minutes ?? 30}{' '}
            minutes after the slot ends. Default 60.
          </p>
        </div>

        {selfError && <p className="mt-2 text-sm text-red-600">{selfError}</p>}
        {selfNote && !selfError && <p className="mt-2 text-sm font-semibold text-emerald-600">{selfNote}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={saveSelfCheckIn} disabled={selfSaving}>
            {selfSaving ? 'Saving...' : 'Save self check-in'}
          </Button>
          {clinic.self_checkin_enabled && (
            <Button variant="outline" onClick={() => navigate('/poster')}>
              <Printer size={16} /> Print clinic QR
            </Button>
          )}
        </div>
      </Card>

      {/* The waitlist only exists because of the cap, so it lives here. */}
      <SectionTitle className="mt-6" actionLabel="Refresh" onAction={loadWaitlist}>
        Waitlist ({waitlist.length})
      </SectionTitle>
      <p className="mt-0.5 text-xs text-slate-400">
        Patients waiting for a seat on a full day. When someone cancels, the longest-waiting patient for that day
        is notified automatically — it's an invitation to book, not a held seat.
      </p>

      <Card className="mt-2 !p-0">
        {waitlist.length === 0 && <p className="px-4 py-5 text-sm text-slate-400">Nobody is waiting.</p>}
        {waitlist.map((w) => (
          <div key={w.id} className="flex items-center gap-3 border-b border-slate-50 px-4 py-3 last:border-b-0">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
              <Users size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-slate-900">{w.family_members?.name ?? 'Patient'}</p>
              <p className="truncate text-xs text-slate-400">
                {w.family_members?.mrn}
                {w.family_members?.phone ? ` · +${w.family_members.phone}` : ''}
              </p>
              <p className="flex items-center gap-1 text-xs text-slate-500">
                <CalendarRange size={12} />
                {new Date(w.date + 'T00:00:00').toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: 'short',
                })}
              </p>
            </div>
            <StatusPill
              label={w.status === 'offered' ? 'Seat offered' : 'Waiting'}
              tone={w.status === 'offered' ? 'live' : 'warning'}
            />
          </div>
        ))}
      </Card>
    </div>
  );
}
