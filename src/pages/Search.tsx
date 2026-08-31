import { ChevronRight, MapPin, SearchIcon, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import VerifiedBadge from '../components/VerifiedBadge';
import { formatDistanceKm, haversineKm } from '../lib/distance';
import { supabase } from '../lib/supabaseClient';
import type { DoctorSearchResult } from '../lib/types';

const QUICK_FILTERS = ['General Physician', 'Cardiologist', 'Dermatologist', 'Paediatrician', 'Orthopaedics'];

interface MyLocation {
  lat: number;
  lng: number;
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DoctorSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [myLocation, setMyLocation] = useState<MyLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      setLoading(true);
      const { data } = await supabase.rpc('search_doctors', { search_term: query });
      setResults(data ?? []);
      setLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const findNearby = () => {
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationError('Your browser does not support location.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setLocationError('Could not get your location - check your browser permission.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const distanceKm = (r: DoctorSearchResult): number | null => {
    if (!myLocation || r.clinic_lat == null || r.clinic_lng == null) return null;
    return haversineKm(myLocation.lat, myLocation.lng, r.clinic_lat, r.clinic_lng);
  };

  // With a location available, clinics with a known distance sort nearest
  // first; clinics that haven't set a location yet fall to the end rather
  // than being hidden.
  const sortedResults = myLocation
    ? [...results].sort((a, b) => {
        const da = distanceKm(a);
        const db = distanceKm(b);
        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      })
    : results;

  return (
    <div>
      <AppHeader title="SanjeevniOS" subtitle="Find a doctor near you" />
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="flex items-center rounded-full border border-slate-200 bg-white px-4 shadow-sm shadow-slate-200/50 focus-within:ring-2 focus-within:ring-brand-500">
          <SearchIcon size={17} className="text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Doctors, specialities, clinics..."
            className="w-full bg-transparent px-3 py-3.5 text-sm outline-none placeholder:text-slate-400"
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          {!query && (
            <div className="flex flex-wrap gap-2">
              {QUICK_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setQuery(f)}
                  className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-brand-300 hover:text-brand-600"
                >
                  {f}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={findNearby}
            disabled={locating}
            className={`ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold ${
              myLocation ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'
            }`}
          >
            <MapPin size={13} />
            {locating ? 'Locating...' : myLocation ? 'Sorted by nearest' : 'Nearest to me'}
          </button>
        </div>
        {locationError && <p className="mt-1.5 text-xs text-red-600">{locationError}</p>}

        <div className="mt-5 space-y-2.5">
          {loading && <p className="text-sm text-slate-400">Searching...</p>}
          {!loading && sortedResults.length === 0 && (
            <p className="text-sm text-slate-400">No approved clinics found.</p>
          )}
          {sortedResults.map((r) => {
            const dist = distanceKm(r);
            return (
              <Link key={r.doctor_id} to={`/doctors/${r.doctor_id}`} className="block">
                <div className="flex items-center gap-3 rounded-3xl border border-slate-100 bg-white p-4 shadow-sm shadow-slate-200/50 transition hover:shadow-md">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                    <Stethoscope size={24} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate font-bold text-slate-900">{r.doctor_name}</p>
                      <VerifiedBadge verified={r.doctor_verified} ownerType="doctor" />
                    </div>
                    {r.specialty && <p className="text-sm font-medium text-coral-600">{r.specialty}</p>}
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <p className="truncate text-sm text-slate-500">{r.clinic_name}</p>
                      <VerifiedBadge verified={r.clinic_verified} ownerType="clinic" />
                    </div>
                    {r.clinic_address && <p className="truncate text-xs text-slate-400">{r.clinic_address}</p>}
                    {dist != null && (
                      <p className="mt-0.5 text-xs font-semibold text-brand-600">{formatDistanceKm(dist)}</p>
                    )}
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-slate-300" />
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
