import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { useEffect, useRef } from 'react';

// Leaflet's default marker icon resolves image URLs relative to its own
// source location, which breaks under Vite's bundling - this is the
// standard fix: import the images as assets and point the default icon at
// the resolved URLs. Runs once, at module load.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface Props {
  lat: number;
  lng: number;
  zoom?: number;
  interactive?: boolean;
  onPick?: (lat: number, lng: number) => void;
  heightClassName?: string;
}

const DEFAULT_HEIGHT = 'h-48';

export default function LeafletMap({ lat, lng, zoom = 15, interactive = false, onPick, heightClassName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Mount once. Re-mounting on every lat/lng change would flash/reset user
  // pan+zoom while they're actively picking a location.
  useEffect(() => {
    if (!containerRef.current) return;

    const map = L.map(containerRef.current, {
      center: [lat, lng],
      zoom,
      dragging: true,
      scrollWheelZoom: interactive,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const marker = L.marker([lat, lng], { draggable: interactive }).addTo(map);
    if (interactive) {
      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        onPick?.(pos.lat, pos.lng);
      });
      map.on('click', (e: L.LeafletMouseEvent) => {
        marker.setLatLng(e.latlng);
        onPick?.(e.latlng.lat, e.latlng.lng);
      });
    }

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When lat/lng change from OUTSIDE this component (e.g. an address search
  // result was picked), re-center the existing map/marker instead of
  // rebuilding it.
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    markerRef.current.setLatLng([lat, lng]);
    mapRef.current.setView([lat, lng]);
  }, [lat, lng]);

  return <div ref={containerRef} className={`w-full rounded-2xl ${heightClassName ?? DEFAULT_HEIGHT}`} />;
}
