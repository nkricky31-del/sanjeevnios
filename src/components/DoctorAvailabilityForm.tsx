import { useEffect, useState } from 'react';

import { WEEKDAY_LABELS } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import { computeSlots, formatTimeLabel } from '../lib/time';
import type { DoctorAvailability } from '../lib/types';

interface Props {
  doctorId: string;
}

export default function DoctorAvailabilityForm({ doctorId }: Props) {
  const [windows, setWindows] = useState<DoctorAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDays, setSelectedDays] = useState<Set<number>>(new Set());
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('13:00');
  const [maxPerDay, setMaxPerDay] = useState('12');
  const [slotCapacity, setSlotCapacity] = useState('1');
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

  const maxNum = Number(maxPerDay);
  const slotCapacityNum = Number(slotCapacity);
  // Same math patients see turned into slots on DoctorPage - shown here so
  // the clinic can see exactly what "12 patients/day, 10:00-13:00" produces
  // before they save it.
  const previewSlots =
    selectedDays.size > 0 && maxNum > 0
      ? computeSlots([{ start_time: `${startTime}:00`, end_time: `${endTime}:00`, max_patients_per_day: maxNum }])
      : [];

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
    if (!Number.isFinite(maxNum) || maxNum <= 0) {
      setError('Max patients per day must be a positive number.');
      return;
    }
    if (!Number.isFinite(slotCapacityNum) || slotCapacityNum <= 0) {
      setError('Capacity per slot must be a positive number.');
      return;
    }

    setSaving(true);
    const rows = Array.from(selectedDays).map((weekday) => ({
      doctor_id: doctorId,
      weekday,
      start_time: `${startTime}:00`,
      end_time: `${endTime}:00`,
      max_patients_per_day: maxNum,
      slot_capacity: slotCapacityNum,
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

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-slate-200 p-4">
      <div>
        <p className="text-sm font-medium text-slate-700">Current weekly availability</p>
        {loading && <p className="mt-1 text-sm text-slate-400">Loading...</p>}
        {!loading && windows.length === 0 && (
          <p className="mt-1 text-sm text-slate-400">No availability set - patients can't book this doctor yet.</p>
        )}
        <div className="mt-2 space-y-1">
          {windows.map((w) => (
            <div key={w.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span>
                <span className="font-medium text-slate-800">{WEEKDAY_LABELS[w.weekday]}</span>{' '}
                <span className="text-slate-600">
                  {formatTimeLabel(w.start_time)} – {formatTimeLabel(w.end_time)} · {w.max_patients_per_day}{' '}
                  patients/day · {w.slot_capacity ?? 1} per slot
                </span>
              </span>
              <button onClick={() => removeWindow(w.id)} className="text-xs font-medium text-red-600">
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium text-slate-700">Add availability</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {WEEKDAY_LABELS.map((label, day) => (
            <button
              key={day}
              type="button"
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
            <label className="text-xs font-medium text-slate-600">Start</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 block rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">End</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="mt-1 block rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Max patients/day</label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
              className="mt-1 block w-28 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">Capacity per slot</label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              value={slotCapacity}
              onChange={(e) => setSlotCapacity(e.target.value)}
              className="mt-1 block w-28 rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        {previewSlots.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            → {previewSlots.length} bookable slot{previewSlots.length === 1 ? '' : 's'}/day,{' '}
            {formatTimeLabel(previewSlots[0])} to {formatTimeLabel(previewSlots[previewSlots.length - 1])}, each
            holding {slotCapacityNum > 0 ? slotCapacityNum : 1} patient{slotCapacityNum === 1 ? '' : 's'}
          </p>
        )}

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <button
          onClick={submit}
          disabled={saving}
          className="mt-3 rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-brand-600/25 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save availability'}
        </button>
      </div>
    </div>
  );
}
