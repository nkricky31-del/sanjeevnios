import { SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import AppHeader from '../components/ui/AppHeader';
import Card from '../components/ui/Card';
import { supabase } from '../lib/supabaseClient';
import type { DoctorSearchResult } from '../lib/types';

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
      <AppHeader title="SanjeevniOS" subtitle="Find a clinic near you" />
      <div className="mx-auto max-w-md px-4 py-6">
        <div className="flex items-center rounded-xl border border-slate-300 bg-white px-3 focus-within:ring-2 focus-within:ring-blue-500">
          <SearchIcon size={16} className="text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Doctor name, specialty, or city"
            className="w-full px-2 py-3 outline-none"
          />
        </div>

        <div className="mt-4 space-y-2">
          {loading && <p className="text-sm text-slate-400">Searching...</p>}
          {!loading && results.length === 0 && (
            <p className="text-sm text-slate-400">No approved clinics found.</p>
          )}
          {results.map((r) => (
            <Link key={r.doctor_id} to={`/doctors/${r.doctor_id}`} className="block">
              <Card className="hover:shadow-md">
                <p className="font-semibold text-slate-900">{r.doctor_name}</p>
                {r.specialty && <p className="text-sm text-blue-600">{r.specialty}</p>}
                <p className="mt-1 text-sm text-slate-500">{r.clinic_name}</p>
                {r.clinic_address && <p className="text-xs text-slate-400">{r.clinic_address}</p>}
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
