export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, '0');
  const m = Math.floor(mins % 60)
    .toString()
    .padStart(2, '0');
  return `${h}:${m}:00`;
}

export function formatTimeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
}

// Rolls a "HH:MM:SS" time back by some number of minutes, wrapping around
// midnight.
export function minutesBefore(t: string, minutes: number): string {
  const wrapped = ((timeToMinutes(t) - minutes) % 1440 + 1440) % 1440;
  return minutesToTime(wrapped);
}

// The system-wide check-in window (schema.sql's check_in_appointment():
// check-in opens 60 minutes before the slot, hardcoded there) - the ceiling
// a clinic's reporting-time buffer is clamped to, so "when to report" can
// never land before check-in is even possible. See migration_40_reporting_time.sql.
export const CHECK_IN_WINDOW_MINUTES = 60;

// A booked slot's reporting time under a clinic's report_before_minutes
// setting, clamped to CHECK_IN_WINDOW_MINUTES. This is also computed
// server-side (get_checkin_options()) for display - this copy is for call
// sites that only have the clinic's raw setting on hand (e.g. the clinic's
// own accept action) and can't afford an extra round trip.
export function reportingTimeFor(slotTime: string, reportBeforeMinutes: number): string {
  return minutesBefore(slotTime, Math.min(reportBeforeMinutes, CHECK_IN_WINDOW_MINUTES));
}

// Turns a doctor's weekly availability windows into the actual bookable slot
// times patients pick from: each window's [start_time, end_time) range is
// divided into exactly max_patients_per_day evenly-spaced slots. A window
// with end <= start or a non-positive capacity contributes no slots instead
// of throwing, since clinic-entered data shouldn't crash the booking page.
export function computeSlots(windows: { start_time: string; end_time: string; max_patients_per_day: number }[]): string[] {
  const slots: string[] = [];
  for (const w of windows) {
    const start = timeToMinutes(w.start_time);
    const end = timeToMinutes(w.end_time);
    const count = w.max_patients_per_day;
    if (count <= 0 || end <= start) continue;
    const step = (end - start) / count;
    for (let i = 0; i < count; i++) {
      slots.push(minutesToTime(Math.round(start + i * step)));
    }
  }
  return slots.sort();
}

// The doctor's working window divided evenly by their daily capacity - the
// same math DoctorPage uses to lay out bookable slots, reused here to
// estimate how many minutes one queue position is worth.
export function estimateSlotMinutes(windows: { start_time: string; end_time: string; max_patients_per_day: number }[]): number {
  if (windows.length === 0) return 15;
  const w = windows[0];
  const start = timeToMinutes(w.start_time);
  const end = timeToMinutes(w.end_time);
  const count = w.max_patients_per_day || 1;
  if (end <= start || count <= 0) return 15;
  return (end - start) / count;
}
