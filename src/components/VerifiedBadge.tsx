import { BadgeCheck } from 'lucide-react';
import { useState } from 'react';

import type { OwnerType } from '../lib/types';

interface Props {
  verified: boolean;
  ownerType: OwnerType;
}

const EXPLANATION: Record<OwnerType, string> = {
  clinic: 'Clinic registration and map location verified by SanjeevniOS.',
  doctor: 'Identity, medical registration and qualification verified by SanjeevniOS.',
};

// Renders nothing unless `verified` is true - callers always compute
// `verified` from is_currently_verified() (see schema.sql), never from a
// raw stored flag, so this never shows a stale badge. stopPropagation on
// tap: this is used inside <Link> result cards, and tapping the badge
// should open its explanation, not navigate.
export default function VerifiedBadge({ verified, ownerType }: Props) {
  const [open, setOpen] = useState(false);
  if (!verified) return null;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700"
      >
        <BadgeCheck size={13} />
        Verified
      </button>
      {open && (
        <span
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="absolute left-0 top-full z-20 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-2.5 text-xs font-normal leading-snug text-slate-600 shadow-lg"
        >
          {EXPLANATION[ownerType]}
        </span>
      )}
    </span>
  );
}
