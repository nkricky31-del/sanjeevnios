function dateToISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// new Date().toISOString() gives the UTC date, which can be a day behind
// India's local date late at night/early morning. This always uses the
// browser's own local calendar date instead.
export function todayISO(): string {
  return dateToISO(new Date());
}

// Used to walk forward day-by-day when looking for the next open slot after
// a rejection (see findNextBestSlot in lib/queue.ts).
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return dateToISO(d);
}

// Index matches doctor_availability.weekday (0 = Sunday ... 6 = Saturday),
// same as JS Date#getDay(), so this can index straight off either.
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ageFromDob(dob: string): number {
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

export function isMinorDob(dob: string): boolean {
  return ageFromDob(dob) < 18;
}

// A walk-in is typically given as "I'm 34", not an exact birth date - this
// approximates one (Jan 1 of the birth year) so it can still go through the
// same dob/guardian-consent check every other family member does.
export function dobFromAge(age: number): string {
  const year = new Date().getFullYear() - age;
  return `${year}-01-01`;
}
