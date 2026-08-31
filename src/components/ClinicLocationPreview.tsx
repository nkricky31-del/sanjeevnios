import { MapPin, Navigation } from 'lucide-react';

import { directionsUrl } from '../lib/geocoding';
import Card from './ui/Card';
import LeafletMap from './LeafletMap';

interface Props {
  lat: number | null;
  lng: number | null;
  formattedAddress: string | null;
  clinicName?: string;
}

export default function ClinicLocationPreview({ lat, lng, formattedAddress, clinicName }: Props) {
  if (lat == null || lng == null) return null;

  return (
    <Card className="mt-3 overflow-hidden !p-0">
      <LeafletMap lat={lat} lng={lng} heightClassName="h-40" />
      <div className="p-3">
        {formattedAddress && (
          <p className="flex items-start gap-1.5 text-sm text-slate-600">
            <MapPin size={14} className="mt-0.5 shrink-0 text-slate-400" />
            {formattedAddress}
          </p>
        )}
        <a
          href={directionsUrl(lat, lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-bold text-brand-600"
        >
          <Navigation size={14} />
          Get directions{clinicName ? ` to ${clinicName}` : ''}
        </a>
      </div>
    </Card>
  );
}
