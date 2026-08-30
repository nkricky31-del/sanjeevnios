// Arbitrary but reasonable starting thresholds for the fraud worklist -
// crossing any one of these flags the clinic for admin review. Not a hard
// rule (nothing is auto-suspended), just a signal.
export const FRAUD_THRESHOLDS = {
  rejections: 10,
  noShows: 10,
  refunds: 5,
};

export interface ClinicFraudStats {
  clinicId: string;
  clinicName: string;
  rejections: number;
  noShows: number;
  refunds: number;
  flagged: boolean;
}

export function isFlagged(stats: Pick<ClinicFraudStats, 'rejections' | 'noShows' | 'refunds'>): boolean {
  return (
    stats.rejections >= FRAUD_THRESHOLDS.rejections ||
    stats.noShows >= FRAUD_THRESHOLDS.noShows ||
    stats.refunds >= FRAUD_THRESHOLDS.refunds
  );
}
