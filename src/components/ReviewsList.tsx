import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Review } from '../lib/types';
import Card from './ui/Card';
import RatingBadge from './RatingBadge';

interface Props {
  doctorId: string;
}

const FETCH_LIMIT = 50;

// The doctor's own visible reviews (migration_61_reviews.sql), read
// straight off `reviews` under reviews_select's public "status = 'visible'"
// branch - any signed-in patient can read these, not just the reviewer.
// reviewer_name is only ever shown when a review's own anonymous flag is
// false - see that migration's comment on why the name lives on the row at
// all.
export default function ReviewsList({ doctorId }: Props) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [summary, setSummary] = useState<{ avg_rating: number | null; review_count: number; percent_positive: number | null }>({
    avg_rating: null,
    review_count: 0,
    percent_positive: null,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: rows }, { data: ratingRows }] = await Promise.all([
        supabase
          .from('reviews')
          .select('*')
          .eq('doctor_id', doctorId)
          .eq('status', 'visible')
          .order('created_at', { ascending: false })
          .limit(FETCH_LIMIT),
        supabase.rpc('get_doctor_rating', { p_doctor_id: doctorId }),
      ]);
      setReviews((rows ?? []) as Review[]);
      const rating = (ratingRows ?? [])[0] as { avg_rating: number | null; review_count: number; percent_positive: number | null } | undefined;
      setSummary(rating ?? { avg_rating: null, review_count: 0, percent_positive: null });
      setLoading(false);
    })();
  }, [doctorId]);

  if (loading) return null;
  if (summary.review_count === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-slate-900">Patient reviews</p>
        <RatingBadge
          avgRating={summary.avg_rating}
          reviewCount={summary.review_count}
          percentPositive={summary.percent_positive}
          variant="full"
        />
      </div>

      <div className="mt-2 space-y-2">
        {reviews.map((r) => (
          <Card key={r.id} className="!p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-0.5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star key={n} size={14} className={r.rating >= n ? 'fill-amber-400 text-amber-400' : 'text-slate-200'} />
                ))}
              </div>
              <p className="shrink-0 text-[11px] text-slate-400">{new Date(r.created_at).toLocaleDateString()}</p>
            </div>
            {r.comment && <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{r.comment}</p>}
            <p className="mt-1.5 text-xs font-semibold text-slate-400">
              {r.anonymous || !r.reviewer_name ? 'Anonymous patient' : r.reviewer_name}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
