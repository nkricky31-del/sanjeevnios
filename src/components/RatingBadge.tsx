import { Star } from 'lucide-react';

interface Props {
  avgRating: number | null;
  reviewCount: number;
  percentPositive: number | null;
  /** 'compact' for a search-result row (next to the name); 'full' for a
      profile header, next to VerifiedBadge. */
  variant?: 'compact' | 'full';
  className?: string;
}

// "One review can't swing it": the percent-positive figure only ever shows
// once there are at least this many ratings - below that, only the average
// and count show. A pure display rule (never touches what's stored or
// computed server-side - migration_61_reviews.sql's get_doctor_rating() /
// get_clinic_rating() / search_doctors() all return percent_positive
// unconditionally), so this threshold can change without a migration.
const MIN_RATINGS_FOR_PERCENT = 5;

// Shown next to VerifiedBadge (Part 39) wherever a doctor or clinic appears
// - patient search results (compact) and the doctor's own profile (full).
// Renders nothing at all with zero ratings yet - an empty "★0.0 (0)" badge
// would read as a bad score, not an absent one.
export default function RatingBadge({ avgRating, reviewCount, percentPositive, variant = 'compact', className = '' }: Props) {
  if (!reviewCount || avgRating == null) return null;
  const showPercent = reviewCount >= MIN_RATINGS_FOR_PERCENT && percentPositive != null;

  if (variant === 'compact') {
    return (
      <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-600 ${className}`}>
        <Star size={12} className="fill-amber-400 text-amber-400" />
        {avgRating.toFixed(1)}
        <span className="font-normal text-slate-400">({reviewCount})</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700 ${className}`}
    >
      <Star size={13} className="fill-amber-400 text-amber-400" />
      {avgRating.toFixed(1)}
      {showPercent && <span>· {percentPositive}% positive</span>}
      <span className="font-normal text-amber-600">
        ({reviewCount} rating{reviewCount === 1 ? '' : 's'})
      </span>
    </span>
  );
}
