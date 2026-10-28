// Slot maths for availability set as "patients per hour" (migration 85).
// The database derives the same numbers in derive_availability_capacity() -
// this copy only powers the clinic's live preview before saving.

export const SLOT_LENGTH_OPTIONS = [5, 6, 10, 12, 15, 20, 30, 45, 60];

export interface SlotRatePlan {
  minutesPerPatient: number;
  perSlot: number;
  slotCount: number;
  perDay: number;
  // Patients an hour these slots actually allow - lower than asked when the
  // slot doesn't divide evenly (10/hour in 15-min slots allows 8).
  effectivePerHour: number;
  // Minutes at the end of the window too short for one more slot.
  leftoverMinutes: number;
}

export function planSlots(windowMinutes: number, patientsPerHour: number, slotMinutes: number): SlotRatePlan | { error: string } {
  if (!Number.isInteger(patientsPerHour) || patientsPerHour < 1 || patientsPerHour > 120) {
    return { error: 'Patients per hour must be between 1 and 120.' };
  }
  if (windowMinutes < slotMinutes) {
    return { error: `The working hours are shorter than one ${slotMinutes}-minute slot.` };
  }
  const minutesPerPatient = 60 / patientsPerHour;
  if (patientsPerHour * slotMinutes < 60) {
    const need = Math.ceil(minutesPerPatient);
    return { error: `At ${patientsPerHour} patients an hour each patient needs ${need} minutes - choose a slot of at least ${need} minutes.` };
  }
  const perSlot = Math.max(1, Math.floor((patientsPerHour * slotMinutes) / 60));
  const slotCount = Math.floor(windowMinutes / slotMinutes);
  return {
    minutesPerPatient,
    perSlot,
    slotCount,
    perDay: perSlot * slotCount,
    effectivePerHour: (perSlot * 60) / slotMinutes,
    leftoverMinutes: windowMinutes - slotCount * slotMinutes,
  };
}

// Slot lengths that fit the hourly rate exactly (no patient lost to rounding).
export function exactSlotLengths(patientsPerHour: number): number[] {
  return SLOT_LENGTH_OPTIONS.filter((m) => patientsPerHour * m >= 60 && (patientsPerHour * m) % 60 === 0);
}

// "6 min" / "7.5 min"
export function formatMinutes(m: number): string {
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}
