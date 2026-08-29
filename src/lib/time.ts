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
