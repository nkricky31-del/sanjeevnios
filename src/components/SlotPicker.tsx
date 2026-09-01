import { useEffect, useState } from 'react';

import { addDaysISO, todayISO, WEEKDAY_LABELS } from '../lib/date';
import { computeSlots, formatTimeLabel } from '../lib/time';
import { supabase } from '../lib/supabaseClient';
import type { ClinicHoliday, DoctorAvailability } from '../lib/types';

interface Props {
  doctorId: string;
  clinicId: string;
  daysToShow?: number;
  selectedDate: string | null;
  selectedSlot: string | null;
  onSelect: (date: string, slotTime: string) => void;
}

const DEFAULT_DAYS_TO_SHOW = 14;

// The day-strip + slot-grid calendar, shared by DoctorPage.tsx (patient
// self-booking) and WalkInForm.tsx (clinic booking a future visit for a
// walk-in patient in the same flow) so both respect the same working hours,
// taken slots, and clinic holidays instead of drifting apart. Read-only
// picker - it doesn't create anything, just reports back what got clicked.
export default function SlotPicker({ doctorId, clinicId, daysToShow = DEFAULT_DAYS_TO_SHOW, selectedDate, selectedSlot, onSelect }: Props) {
  const [availability, setAvailability] = useState<DoctorAvailability[]>([]);
  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(selectedDate ?? todayISO());
  const [takenSlots, setTakenSlots] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!doctorId) return;
    (async () => {
      setLoading(true);
      const [{ data: availData }, { data: holidayData }] = await Promise.all([
        supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId),
        supabase.from('clinic_holidays').select('date').eq('clinic_id', clinicId),
      ]);
      setAvailability((availData ?? []) as DoctorAvailability[]);
      setHolidays(new Set(((holidayData ?? []) as Pick<ClinicHoliday, 'date'>[]).map((h) => h.date)));
      setLoading(false);
    })();
  }, [doctorId, clinicId]);

  useEffect(() => {
    if (!doctorId || !date) return;
    (async () => {
      const { data } = await supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: date });
      setTakenSlots(new Set((data ?? []).map((r: { slot_time: string }) => r.slot_time)));
    })();
  }, [doctorId, date]);

  const dayOptions = Array.from({ length: daysToShow }, (_, i) => {
    const iso = addDaysISO(todayISO(), i);
    const d = new Date(iso + 'T00:00:00');
    return { iso, dayLabel: WEEKDAY_LABELS[d.getDay()], dateNum: d.getDate(), isHoliday: holidays.has(iso) };
  });

  const isHolidayToday = holidays.has(date);
  const weekday = new Date(date + 'T00:00:00').getDay();
  const windowsToday = availability.filter((a) => a.weekday === weekday);
  const allSlots = isHolidayToday ? [] : computeSlots(windowsToday);
  // Dedupe: rounding in computeSlots can occasionally land two starts on the
  // same minute for a very tight capacity/window combo.
  const openSlots = Array.from(new Set(allSlots.filter((s) => !takenSlots.has(s))));

  if (loading) return <p className="mt-2 text-sm text-slate-400">Loading availability...</p>;

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Select day</p>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {dayOptions.map((d) => (
          <button
            key={d.iso}
            type="button"
            onClick={() => setDate(d.iso)}
            disabled={d.isHoliday}
            className={`flex shrink-0 flex-col items-center rounded-2xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
              date === d.iso ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            <span className="text-xs opacity-80">{d.dayLabel}</span>
            <span className="text-base">{d.dateNum}</span>
          </button>
        ))}
      </div>

      <p className="mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">Available slots</p>
      {isHolidayToday && <p className="mt-2 text-sm text-red-600">Clinic closed this day{holidays.has(date) ? '' : ''}.</p>}
      {!isHolidayToday && windowsToday.length === 0 && (
        <p className="mt-2 text-sm text-slate-400">Doctor doesn't work on this day.</p>
      )}
      {!isHolidayToday && windowsToday.length > 0 && openSlots.length === 0 && (
        <p className="mt-2 text-sm text-red-600">Fully booked for this date.</p>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        {openSlots.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(date, s)}
            className={`rounded-2xl border px-3 py-2.5 text-sm font-semibold ${
              selectedDate === date && selectedSlot === s
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300'
            }`}
          >
            {formatTimeLabel(s)}
          </button>
        ))}
      </div>
    </div>
  );
}
