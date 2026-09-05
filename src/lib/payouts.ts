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
  // Present from migration 41 onward; null on an older payment row, in
  // which case gross === amount (there was never a discount to speak of).
  gross_amount: number | null;
  discount_amount: number | null;
  funded_by: 'platform' | 'clinic' | null;
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
//
// A coupon complicates "collected" vs "owed" (section 41): `amount` is what
// was actually captured from the patient - net of any discount - but the
// clinic's OWED figure should only shrink for that discount when the
// clinic itself is funding it (funded_by = 'clinic'). A platform-funded
// coupon leaves the clinic's payout on the full gross fee - the platform
// eats the gap between what it collected and what it owes out of its own
// fee/margin, same as any other promotional discount a marketplace funds
// itself. Falls back to `amount` as the gross when gross_amount is null
// (a payment row from before this migration never had a coupon anyway).
export function computePayouts(payments: PayoutPaymentRow[]): ClinicPayout[] {
  const byClinic = new Map<string, ClinicPayout>();
  // Running totals this function needs mid-loop but ClinicPayout has no
  // field for - kept separate rather than borrowing `fee`/`owed` as
  // scratch space, which would make the values wrong for anyone reading
  // `byClinic` before the final pass below.
  const grossTotals = new Map<string, number>();
  const clinicFundedDiscountTotals = new Map<string, number>();

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

    const gross = p.gross_amount ?? p.amount;
    const clinicFundedDiscount = p.funded_by === 'clinic' ? (p.discount_amount ?? 0) : 0;

    entry.collected += p.amount;
    if (p.payout_status === 'paid') entry.paidPayoutCount++;
    else entry.pendingPayoutCount++;
    byClinic.set(clinicId, entry);

    grossTotals.set(clinicId, (grossTotals.get(clinicId) ?? 0) + gross);
    clinicFundedDiscountTotals.set(clinicId, (clinicFundedDiscountTotals.get(clinicId) ?? 0) + clinicFundedDiscount);
  }

  for (const entry of byClinic.values()) {
    const grossTotal = grossTotals.get(entry.clinicId) ?? 0;
    const clinicFundedDiscountTotal = clinicFundedDiscountTotals.get(entry.clinicId) ?? 0;
    entry.fee = round2(grossTotal * (PLATFORM_FEE_PERCENT / 100));
    entry.owed = round2(grossTotal - entry.fee - clinicFundedDiscountTotal);
  }

  return Array.from(byClinic.values()).sort((a, b) => b.collected - a.collected);
}
