import { CalendarRange, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { Clinic, ClinicMode } from '../lib/types';
import Button from './ui/Button';
import Card from './ui/Card';
import SectionTitle from './ui/SectionTitle';
import Segmented from './ui/Segmented';
import StatusPill from './ui/StatusPill';

interface Props {
  clinic: Clinic;
  onSaved: (patch: Partial<Clinic>) => void;
}

interface WaitlistRow {
  id: string;
  date: string;
  status: string;
  created_at: string;
  family_members: { name: string; phone: string | null; mrn: string } | null;
}

// How this clinic takes patients, plus the waitlist that the appointment-only
// mode generates. Kept together because the waitlist only exists as a
// consequence of the cap.
export default function ClinicBookingMode({ clinic, onSaved }: Props) {
  const [mode, setMode] = useState<ClinicMode>(clinic.mode ?? 'allow_walkins');
  const [horizon, setHorizon] = useState(String(clinic.booking_horizon_days ?? 1));
  const [cap, setCap] = useState(String(clinic.daily_cap ?? 100));
  // Same-day booking on top of appointment_only mode (schema.sql section 37)
  // - meaningless outside that mode, so the inputs below only enable there.
  const [sameDayEnabled, setSameDayEnabled] = useState(clinic.same_day_booking_enabled ?? false);
  const [sameDayCutoff, setSameDayCutoff] = useState(String(clinic.same_day_cutoff_minutes ?? 30));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([]);

  const loadWaitlist = useCallback(async () => {
    const { data } = await supabase
      .from('waitlist')
      .select('id, date, status, created_at, family_members(name, phone, mrn)')
      .eq('clinic_id', clinic.id)
      .gte('date', todayISO())
      .in('status', ['waiting', 'offered'])
      .order('date', { ascending: true })
      .order('created_at', { ascending: true });
    setWaitlist((data ?? []) as unknown as WaitlistRow[]);
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

    setSaving(true);
    const patch = {
      mode,
      booking_horizon_days: horizonNum,
      daily_cap: capNum,
      same_day_booking_enabled: sameDayEnabled,
      same_day_cutoff_minutes: cutoffNum,
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
