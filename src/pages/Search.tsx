import { ChevronRight, SearchIcon, Stethoscope } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import { supabase } from '../lib/supabaseClient';
import type { DoctorSearchResult } from '../lib/types';

const QUICK_FILTERS = ['General Physician', 'Cardiologist', 'Dermatologist', 'Paediatrician', 'Orthopaedics'];

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DoctorSearchResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(async () => {
      setLoading(true);
      const { data } = await supabase.rpc('search_doctors', { search_term: query });
      setResults(data ?? []);
      setLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

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

        {!query && (
          <div className="mt-3 flex flex-wrap gap-2">
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

        <div className="mt-5 space-y-2.5">
          {loading && <p className="text-sm text-slate-400">Searching...</p>}
          {!loading && results.length === 0 && (
            <p className="text-sm text-slate-400">No approved clinics found.</p>
          )}
          {results.map((r) => (
            <Link key={r.doctor_id} to={`/doctors/${r.doctor_id}`} className="block">
              <div className="flex items-center gap-3 rounded-3xl border border-slate-100 bg-white p-4 shadow-sm shadow-slate-200/50 transition hover:shadow-md">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
                  <Stethoscope size={24} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-slate-900">{r.doctor_name}</p>
                  {r.specialty && <p className="text-sm font-medium text-coral-600">{r.specialty}</p>}
                  <p className="mt-0.5 truncate text-sm text-slate-500">{r.clinic_name}</p>
                  {r.clinic_address && <p className="truncate text-xs text-slate-400">{r.clinic_address}</p>}
                </div>
                <ChevronRight size={18} className="shrink-0 text-slate-300" />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
