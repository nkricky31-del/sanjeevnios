import { Suspense } from 'react';

import { lazyPage } from '../lib/lazyPage';

// The map library (Leaflet) is only downloaded when a map is actually shown.
const LeafletMap = lazyPage(() => import('./LeafletMap'));

type Props = {
  lat: number;
  lng: number;
  zoom?: number;
  interactive?: boolean;
  onPick?: (lat: number, lng: number) => void;
  heightClassName?: string;
};

export default function LazyMap(props: Props) {
  return (
    <Suspense
      fallback={<div aria-hidden className={`${props.heightClassName ?? 'h-48'} w-full animate-pulse bg-slate-100`} />}
    >
      <LeafletMap {...props} />
    </Suspense>
  );
}
