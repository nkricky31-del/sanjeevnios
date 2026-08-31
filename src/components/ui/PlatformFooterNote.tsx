import { PLATFORM_DISCLAIMER_SHORT } from '../../lib/platformDisclaimer';

// Permanent short disclaimer line - rendered once per patient page (see
// App.tsx), sitting right above the fixed BottomTabBar.
export default function PlatformFooterNote() {
  return (
    <p className="mx-auto max-w-md px-4 pb-2 pt-3 text-center text-[11px] leading-snug text-slate-400">
      {PLATFORM_DISCLAIMER_SHORT}
    </p>
  );
}
