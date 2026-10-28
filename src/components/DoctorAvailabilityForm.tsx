import Loading from './ui/Loading';
import { useEffect, useState } from 'react';

import { WEEKDAY_LABELS } from '../lib/date';
import { exactSlotLengths, formatMinutes, planSlots, SLOT_LENGTH_OPTIONS } from '../lib/slotRate';
import { supabase } from '../lib/supabaseClient';
import { computeSlots, formatTimeLabel, timeToMinutes } from '../lib/time';
import type { DoctorAvailability } from '../lib/types';

interface Props {
  doctorId: string;
}

// A doctor's weekly hours, set as "how many patients an hour" plus a slot
// length (migration 85): 10 patients an hour is 6 minutes each, so a
// 15-minute slot takes 2 bookings and is then shown as full.
export default function DoctorAvailabilityForm({ doctorId }: Props) {
  const [windows, setWindows] = useState<DoctorAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set());
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('13:00');
  const [perHour, setPerHour] = useState('10');
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('doctor_availability')
      .select('*')
      .eq('doctor_id', doctorId)
      .order('weekday', { ascending: true });
    setWindows(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  const toggleDay = (day: number) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const perHourNum = Number(perHour);
  const windowMinutes = startTime && endTime ? timeToMinutes(`${endTime}:00`) - timeToMinutes(`${startTime}:00`) : 0;
  const plan = windowMinutes > 0 && perHour !== '' ? planSlots(windowMinutes, perHourNum, slotMinutes) : null;
  const previewSlots =
    plan && !('error' in plan)
      ? computeSlots([
          { start_time: `${startTime}:00`, end_time: `${endTime}:00`, max_patients_per_day: plan.slotCount, slot_minutes: slotMinutes },
        ])
      : [];
  const exactFits = Number.isInteger(perHourNum) && perHourNum > 0 ? exactSlotLengths(perHourNum) : [];

  const submit = async () => {
    setError(null);

    if (selectedDays.size === 0) {
      setError('Select at least one weekday.');
      return;
    }
    if (!startTime || !endTime || endTime <= startTime) {
      setError('End time must be after start time.');
      return;
    }
    if (!plan) {
      setError('Enter how many patients the doctor can see in an hour.');
      return;
    }
    if ('error' in plan) {
      setError(plan.error);
      return;
    }

    setSaving(true);
    const rows = Array.from(selectedDays).map((weekday) => ({
      doctor_id: doctorId,
      weekday,
      start_time: `${startTime}:00`,
      end_time: `${endTime}:00`,
      patients_per_hour: perHourNum,
      slot_minutes: slotMinutes,
      // Also derived by the database (derive_availability_capacity) - sent so
      // the row is right even before that trigger runs.
      max_patients_per_day: plan.slotCount,
      slot_capacity: plan.perSlot,
    }));
    const { error: insertError } = await supabase.from('doctor_availability').insert(rows);
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }
    setSelectedDays(new Set());
    load();
  };

  const removeWindow = async (id: string) => {
    await supabase.from('doctor_availability').delete().eq('id', id);
    load();
  };

  const describeWindow = (w: DoctorAvailability) => {
    const hours = `${formatTimeLabel(w.start_time)} – ${formatTimeLabel(w.end_time)}`;
    if (w.patients_per_hour && w.slot_minutes) {
      const perDay = w.max_patients_per_day * (w.slot_capacity ?? 1);
      return `${hours} · ${w.patients_per_hour} patients/hour · ${w.slot_minutes}-min slots of ${w.slot_capacity} · up to ${perDay}/day`;
    }
    return `${hours} · ${w.max_patients_per_day} slots/day · ${w.slot_capacity ?? 1} per slot`;
  };

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-slate-200 p-4">
      <div>
        <p className="text-sm font-medium text-slate-700">Current weekly availability</p>
        {loading && <p className="mt-1 text-sm text-slate-400"><Loading /></p>}
        {!loading && windows.length === 0 && (
          <p className="mt-1 text-sm text-slate-400">No availability set - patients can't book this doctor yet.</p>
        )}
        <div className="mt-2 space-y-1">
          {windows.map((w) => (
            <div key={w.id} className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{WEEKDAY_LABELS[w.weekday]}</span>{' '}
                <span className="text-slate-600">{describeWindow(w)}</span>
              </span>
              <button onClick={() => removeWindow(w.id)} className="shrink-0 text-xs font-medium text-red-600">
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-slate-700">Add availability</p>
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Weekdays">
          {WEEKDAY_LABELS.map((label, day) => (
            <button
              key={day}
              type="button"
              aria-pressed={selectedDays.has(day)}
              onClick={() => toggleDay(day)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${
                selectedDays.has(day)
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="avail-start" className="text-xs font-medium text-slate-600">
              Start
            </label>
            <input
              id="avail-start"
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 block rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="avail-end" className="text-xs font-medium text-slate-600">
              End
            </label>
            <input
              id="avail-end"
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="mt-1 block rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="avail-per-hour" className="text-xs font-medium text-slate-600">
              Patients per hour
            </label>
            <input
              id="avail-per-hour"
              type="number"
              inputMode="numeric"
              min={1}
              max={120}
              value={perHour}
              onChange={(e) => setPerHour(e.target.value)}
              className="mt-1 block w-28 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="avail-slot" className="text-xs font-medium text-slate-600">
              Slot length
            </label>
            <select
              id="avail-slot"
              value={slotMinutes}
              onChange={(e) => setSlotMinutes(Number(e.target.value))}
              className="mt-1 block rounded-2xl border border-slate-200 bg-white px-2 py-1.5 text-sm"
            >
              {SLOT_LENGTH_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
        </div>

        {plan && 'error' in plan && <p className="mt-2 text-xs font-semibold text-amber-700">{plan.error}</p>}

        {plan && !('error' in plan) && previewSlots.length > 0 && (
          <div className="mt-3 rounded-xl bg-brand-50 p-3 text-xs leading-relaxed text-slate-700">
            <p>
              <strong>{perHourNum} patients an hour</strong> = {formatMinutes(plan.minutesPerPatient)} per patient, so each{' '}
              {slotMinutes}-minute slot takes <strong>{plan.perSlot} booking{plan.perSlot === 1 ? '' : 's'}</strong> and
              is then shown as full.
            </p>
            <p className="mt-1">
              {plan.slotCount} slot{plan.slotCount === 1 ? '' : 's'} from {formatTimeLabel(previewSlots[0])} to{' '}
              {formatTimeLabel(previewSlots[previewSlots.length - 1])} · up to <strong>{plan.perDay} patients</strong> a
              day.
            </p>
            {plan.effectivePerHour < perHourNum && (
              <p className="mt-1 font-semibold text-amber-700">
                That's {Number.isInteger(plan.effectivePerHour) ? plan.effectivePerHour : plan.effectivePerHour.toFixed(1)} an
                hour, not {perHourNum}: a {slotMinutes}-minute slot fits{' '}
                {((perHourNum * slotMinutes) / 60).toFixed(1).replace(/\.0$/, '')} patients and part-patients can't be
                booked.
                {exactFits.length > 0 &&
                  ` For exactly ${perHourNum} an hour, use ${exactFits.join(', ')}-minute slots.`}
              </p>
            )}
            {plan.leftoverMinutes > 0 && (
              <p className="mt-1 text-slate-500">
                The last {plan.leftoverMinutes} minutes before {formatTimeLabel(`${endTime}:00`)} are too short for a
                slot and stay unbooked.
              </p>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <button
          onClick={submit}
          disabled={saving}
          className="mt-3 rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save availability'}
        </button>
      </div>
    </div>
  );
}
