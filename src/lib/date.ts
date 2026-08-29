// new Date().toISOString() gives the UTC date, which can be a day behind
// India's local date late at night/early morning. This always uses the
// browser's own local calendar date instead.
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
