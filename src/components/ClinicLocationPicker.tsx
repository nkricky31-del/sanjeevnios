import { Search as SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { reverseGeocode, searchAddress, type AddressResult } from '../lib/geocoding';
import { supabase } from '../lib/supabaseClient';
import Button from './ui/Button';
import LeafletMap from './LeafletMap';

interface Props {
  clinicId: string;
  initialLat: number | null;
  initialLng: number | null;
  initialAddress: string | null;
  onSaved: (lat: number, lng: number, formattedAddress: string | null) => void;
}

// Roughly the geographic centre of India - a reasonable default map center
// for a clinic that hasn't set a location yet.
const DEFAULT_LAT = 20.5937;
const DEFAULT_LNG = 78.9629;
const DEFAULT_ZOOM = 5;

let searchDebounce: ReturnType<typeof setTimeout> | undefined;

export default function ClinicLocationPicker({ clinicId, initialLat, initialLng, initialAddress, onSaved }: Props) {
  const [lat, setLat] = useState(initialLat ?? DEFAULT_LAT);
  const [lng, setLng] = useState(initialLng ?? DEFAULT_LNG);
  const [address, setAddress] = useState(initialAddress ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasInitialPin = initialLat != null && initialLng != null;

  const onQueryChange = (value: string) => {
    setQuery(value);
    clearTimeout(searchDebounce);
    if (!value.trim()) {
      setResults([]);
      return;
    }
    // Nominatim's usage policy asks for roughly 1 request/second at most -
    // debouncing keystrokes keeps this well under that.
    searchDebounce = setTimeout(async () => {
      setSearching(true);
      const found = await searchAddress(value);
      setResults(found);
      setSearching(false);
    }, 450);
  };

  const pickResult = (r: AddressResult) => {
    setLat(r.lat);
    setLng(r.lng);
    setAddress(r.formattedAddress);
    setResults([]);
    setQuery('');
  };

  const onMapPick = async (newLat: number, newLng: number) => {
    setLat(newLat);
    setLng(newLng);
    const found = await reverseGeocode(newLat, newLng);
    if (found) setAddress(found);
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    const { error: updateError } = await supabase
      .from('clinics')
      .update({ lat, lng, formatted_address: address.trim() || null })
      .eq('id', clinicId);
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    onSaved(lat, lng, address.trim() || null);
  };

  return (
    <div>
      <div className="relative">
        <div className="flex items-center rounded-2xl border border-slate-200 bg-white px-3 focus-within:ring-2 focus-within:ring-brand-500">
          <SearchIcon size={16} className="text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search for your clinic's address"
            className="w-full bg-transparent px-2 py-2.5 text-sm outline-none"
          />
        </div>
        {(results.length > 0 || searching) && (
          <div className="absolute z-10 mt-1 w-full rounded-2xl border border-slate-200 bg-white shadow-lg">
            {searching && <p className="px-3 py-2 text-sm text-slate-400">Searching...</p>}
            {results.map((r, i) => (
              <button
                key={i}
                onClick={() => pickResult(r)}
                className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                {r.formattedAddress}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Or drag the pin (or tap the map) to place it exactly.
      </p>
      <div className="mt-1 overflow-hidden rounded-2xl">
        <LeafletMap
          lat={lat}
          lng={lng}
          zoom={hasInitialPin ? 15 : DEFAULT_ZOOM}
          interactive
          onPick={onMapPick}
          heightClassName="h-64"
        />
      </div>

      <div className="mt-3">
        <label className="text-sm font-semibold text-slate-700">Formatted address</label>
        <textarea
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          rows={2}
          placeholder="Fills in automatically from search or the pin - edit if needed"
          className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <Button onClick={save} disabled={saving} className="mt-3" full>
        {saving ? 'Saving...' : 'Save location'}
      </Button>
    </div>
  );
}
