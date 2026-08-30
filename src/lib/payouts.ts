// Flat platform fee taken out of every captured ONLINE payment before the
// rest is owed back to the clinic. COD payments never pass through the
// platform at all (the patient pays the clinic directly in cash), so
// there's nothing to collect or pay out for those - they're excluded here.
export const PLATFORM_FEE_PERCENT = 10;

export interface PayoutPaymentRow {
  amount: number;
  status: string;
  payout_status: string;
  method: string;
  appointments: {
    clinic_id: string;
    clinics: { name: string } | null;
  } | null;
}

export interface ClinicPayout {
  clinicId: string;
  clinicName: string;
  collected: number;
  fee: number;
  owed: number;
  pendingPayoutCount: number;
  paidPayoutCount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Groups captured online payments by clinic and works out what's owed to
// each one after the platform fee. Payments still sitting in 'pending'
// payout_status are what a "Mark payout paid" action would clear.
export function computePayouts(payments: PayoutPaymentRow[]): ClinicPayout[] {
  const byClinic = new Map<string, ClinicPayout>();

  for (const p of payments) {
    if (p.status !== 'captured' || p.method !== 'online') continue;
    const clinicId = p.appointments?.clinic_id;
    if (!clinicId) continue;

    const entry = byClinic.get(clinicId) ?? {
      clinicId,
      clinicName: p.appointments?.clinics?.name ?? 'Unknown clinic',
      collected: 0,
      fee: 0,
      owed: 0,
      pendingPayoutCount: 0,
      paidPayoutCount: 0,
    };
    entry.collected += p.amount;
    if (p.payout_status === 'paid') entry.paidPayoutCount++;
    else entry.pendingPayoutCount++;
    byClinic.set(clinicId, entry);
  }

  for (const entry of byClinic.values()) {
    entry.fee = round2(entry.collected * (PLATFORM_FEE_PERCENT / 100));
    entry.owed = round2(entry.collected - entry.fee);
  }

  return Array.from(byClinic.values()).sort((a, b) => b.collected - a.collected);
}
