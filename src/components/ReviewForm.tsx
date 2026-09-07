import { Star } from 'lucide-react';
import { useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { Review } from '../lib/types';
import Button from './ui/Button';

interface Props {
  appointmentId: string;
  onSubmitted: (review: Review) => void;
}

// Rate-a-visit form (migration_61_reviews.sql) - only ever rendered once
// BookingStatus.tsx has already confirmed booking.status === 'completed'
// and that no review exists yet for this appointment (see that page's own
// gate). submit_review() re-checks both server-side regardless - this form
// trusts the server's error message rather than trying to duplicate that
// logic here.
export default function ReviewForm({ appointmentId, onSubmitted }: Props) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (rating < 1) {
      setError('Choose a star rating.');
      return;
    }
    setSubmitting(true);
    const { data, error: rpcError } = await supabase.rpc('submit_review', {
      p_appointment_id: appointmentId,
      p_rating: rating,
      p_comment: comment.trim() || null,
      p_anonymous: anonymous,
    });
    setSubmitting(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    onSubmitted(data as Review);
  };

  const shown = hoverRating || rating;

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4">
      <p className="text-sm font-bold text-slate-900">Rate this visit</p>
      <p className="mt-0.5 text-xs text-slate-400">Your feedback helps other patients choose with confidence.</p>

      <div className="mt-3 flex justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            onMouseEnter={() => setHoverRating(n)}
            onMouseLeave={() => setHoverRating(0)}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            className="p-1"
          >
            <Star size={30} className={shown >= n ? 'fill-amber-400 text-amber-400' : 'text-slate-200'} />
          </button>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Anything else other patients should know? (optional)"
        rows={3}
        maxLength={1000}
        className="mt-3 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
      />

      <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={!anonymous} onChange={(e) => setAnonymous(!e.target.checked)} className="h-4 w-4" />
        Show my name on this review (otherwise it's posted anonymously)
      </label>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <Button full className="mt-3" onClick={submit} disabled={submitting}>
        {submitting ? 'Submitting...' : 'Submit review'}
      </Button>
    </div>
  );
}
