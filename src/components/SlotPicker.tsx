import { useEffect, useState } from 'react';

import { bookableRange, getBookingPolicy, getDayAvailability, DEFAULT_POLICY, type BookingPolicy, type DayAvailability } from '../lib/bookingPolicy';
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
  const [policy, setPolicy] = useState<BookingPolicy>(DEFAULT_POLICY);
  const [dayInfo, setDayInfo] = useState<DayAvailability | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!doctorId) return;
    (async () => {
      setLoading(true);
      const [{ data: availData }, { data: holidayData }, loadedPolicy] = await Promise.all([
        supabase.from('doctor_availability').select('*').eq('doctor_id', doctorId),
        supabase.from('clinic_holidays').select('date').eq('clinic_id', clinicId),
        getBookingPolicy(clinicId),
      ]);
      setAvailability((availData ?? []) as DoctorAvailability[]);
      setHolidays(new Set(((holidayData ?? []) as Pick<ClinicHoliday, 'date'>[]).map((h) => h.date)));
      setPolicy(loadedPolicy);
      // An appointment-only clinic never offers today, so start the strip on
      // the first day it will actually accept.
      setDate((prev) => (prev < bookableRange(loadedPolicy).firstISO ? bookableRange(loadedPolicy).firstISO : prev));
      setLoading(false);
    })();
  }, [doctorId, clinicId]);

  useEffect(() => {
    if (!doctorId || !date) return;
    (async () => {
      const { data } = await supabase.rpc('get_taken_slots', { p_doctor_id: doctorId, p_date: date });
      setTakenSlots(new Set((data ?? []).map((r: { slot_time: string }) => r.slot_time)));
      // How many seats are left in the clinic's daily cap for this date.
      setDayInfo(await getDayAvailability(clinicId, date));
    })();
  }, [doctorId, clinicId, date]);

  // In appointment_only mode the strip runs from tomorrow to the clinic's
  // horizon and no further; otherwise it's the usual rolling fortnight.
  const range = bookableRange(policy);
  const appointmentOnly = policy.mode === 'appointment_only';
  const stripDays = appointmentOnly ? range.days : daysToShow;
  const dayOptions = Array.from({ length: stripDays }, (_, i) => {
    const iso = addDaysISO(range.firstISO, i);
    const d = new Date(iso + 'T00:00:00');
    return { iso, dayLabel: WEEKDAY_LABELS[d.getDay()], dateNum: d.getDate(), isHoliday: holidays.has(iso) };
  });

  const isHolidayToday = holidays.has(date);
  const weekday = new Date(date + 'T00:00:00').getDay();
  const windowsToday = availability.filter((a) => a.weekday === weekday);
  // Dedupe: rounding in computeSlots can occasionally land two starts on the
  // same minute for a very tight capacity/window combo.
  const allSlots = isHolidayToday ? [] : Array.from(new Set(computeSlots(windowsToday)));

  // A same-day slot inside the clinic's cutoff (schema.sql section 37.3) -
  // greyed out here purely so the grid doesn't invite a tap that the server
  // will refuse with SAME_DAY_CUTOFF. Only meaningful for today's date; any
  // other day is either fully in the future or not offered at all.
  const isToday = date === todayISO();
  const cutoffMs = policy.sameDayCutoffMinutes * 60_000;
  const withinCutoff = (s: string) => isToday && new Date(`${date}T${s}`).getTime() - Date.now() < cutoffMs;

  // takenSlots (from get_taken_slots, section 36) already means "this exact
  // time's active bookings have reached its capacity" - a slot with room
  // left never appears here, regardless of how many patients it can hold.
  const openSlots = allSlots.filter((s) => !takenSlots.has(s) && !withinCutoff(s));

  if (loading) return <p className="mt-2 text-sm text-slate-400">Loading availability...</p>;

  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Select day</p>
      {appointmentOnly && !policy.sameDayBookingEnabled && (
        <p className="mt-1 text-xs text-slate-500">
          This clinic takes advance bookings only — no same-day appointments, and you can book up to{' '}
          {policy.bookingHorizonDays} day{policy.bookingHorizonDays === 1 ? '' : 's'} ahead.
        </p>
      )}
      {appointmentOnly && policy.sameDayBookingEnabled && (
        <p className="mt-1 text-xs text-slate-500">
          This clinic takes advance bookings up to {policy.bookingHorizonDays} day
          {policy.bookingHorizonDays === 1 ? '' : 's'} ahead, plus same-day bookings up to{' '}
          {policy.sameDayCutoffMinutes} minutes before a slot.
        </p>
      )}
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

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Available slots</p>
        {/* The clinic's daily cap, separate from whether this doctor has a
            free slot - a day can be full even when the grid still shows
            times, because the cap counts the whole clinic. */}
        {dayInfo && (
          <p className={`text-xs font-semibold ${dayInfo.isFull ? 'text-red-600' : 'text-slate-500'}`}>
            {dayInfo.isFull
              ? 'Day full'
              : `${dayInfo.seatsLeft} of ${dayInfo.dailyCap} seat${dayInfo.dailyCap === 1 ? '' : 's'} left`}
          </p>
        )}
      </div>
      {isHolidayToday && <p className="mt-2 text-sm text-red-600">Clinic closed this day.</p>}
      {!isHolidayToday && dayInfo?.isFull && (
        <p className="mt-2 text-sm text-red-600">
          This day is fully booked ({dayInfo.seatsTaken}/{dayInfo.dailyCap}). Pick another day, or continue to join
          the waitlist.
        </p>
      )}
      {!isHolidayToday && !dayInfo?.isFull && windowsToday.length === 0 && (
        <p className="mt-2 text-sm text-slate-400">Doctor doesn't work on this day.</p>
      )}
      {!isHolidayToday &&
        !dayInfo?.isFull &&
        windowsToday.length > 0 &&
        openSlots.length === 0 &&
        (isToday && allSlots.every((s) => withinCutoff(s) || takenSlots.has(s)) && allSlots.some(withinCutoff) ? (
          <p className="mt-2 text-sm text-red-600">
            Same-day booking has closed for the rest of today - pick another day.
          </p>
        ) : (
          <p className="mt-2 text-sm text-red-600">Fully booked for this date.</p>
        ))}
      {/* Every computed slot is shown, not just the open ones - a full slot
          is greyed out and unselectable rather than disappearing, so it's
          clear there was a time there and that it's someone else's now. */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        {allSlots.map((s) => {
          const full = takenSlots.has(s);
          const cutoff = !full && withinCutoff(s);
          return (
            <button
              key={s}
              type="button"
              disabled={full || cutoff}
              onClick={() => onSelect(date, s)}
              className={`rounded-2xl border px-3 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-300 ${
                full || cutoff
                  ? ''
                  : selectedDate === date && selectedSlot === s
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300'
              }`}
            >
              {formatTimeLabel(s)}
              {full && <span className="ml-1 text-xs font-normal">· Full</span>}
              {cutoff && <span className="ml-1 text-xs font-normal">· Closed</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
