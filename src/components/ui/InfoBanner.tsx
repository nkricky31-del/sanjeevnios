import { Info } from 'lucide-react';
import type { PropsWithChildren } from 'react';

export default function InfoBanner({ children }: PropsWithChildren) {
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-brand-50 p-3 text-sm text-brand-800">
      <Info size={16} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
