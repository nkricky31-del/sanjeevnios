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
  // The structured city component, distinct from formattedAddress (a
  // free-text string) - schema.sql section 56's "cities covered" public
  // stat counts distinct values of this, which a regex over formattedAddress
  // couldn't do reliably. null when Nominatim's address breakdown has none
  // of city/town/village/county for this point (rural pins, mostly).
  city: string | null;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  county?: string;
}

function extractCity(address: NominatimAddress | undefined): string | null {
  if (!address) return null;
  return address.city ?? address.town ?? address.village ?? address.county ?? null;
}

export async function searchAddress(query: string): Promise<AddressResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=5&q=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((r: { lat: string; lon: string; display_name: string; address?: NominatimAddress }) => ({
      lat: Number(r.lat),
      lng: Number(r.lon),
      formattedAddress: r.display_name,
      city: extractCity(r.address),
    }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<{ formattedAddress: string; city: string | null } | null> {
  const url = `${NOMINATIM_BASE}/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data?.display_name !== 'string') return null;
    return { formattedAddress: data.display_name, city: extractCity(data.address) };
  } catch {
    return null;
  }
}

// Google Maps direction deep links don't require an API key - just the
// destination coordinates.
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
