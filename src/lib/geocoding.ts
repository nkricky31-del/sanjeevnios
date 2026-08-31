// Free-tier geocoding via OpenStreetMap's Nominatim - no API key required.
// Nominatim's usage policy asks callers to identify themselves via a
// User-Agent or HTTP Referer header; browsers already send a Referer on
// every fetch, which satisfies that on its own. Rate limit is ~1 req/sec,
// so callers of searchAddress should debounce (Search.tsx-style, ~400-500ms)
// rather than firing on every keystroke.
//
// No API key is used anywhere in this file. If you later want to switch to
// a keyed provider (Google, Mapbox, etc.), read the key from
// import.meta.env.VITE_<PROVIDER>_KEY - never hard-code it.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

export interface AddressResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

export async function searchAddress(query: string): Promise<AddressResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${NOMINATIM_BASE}/search?format=json&limit=5&q=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((r: { lat: string; lon: string; display_name: string }) => ({
      lat: Number(r.lat),
      lng: Number(r.lon),
      formattedAddress: r.display_name,
    }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.display_name === 'string' ? data.display_name : null;
  } catch {
    return null;
  }
}

// Google Maps direction deep links don't require an API key - just the
// destination coordinates.
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
