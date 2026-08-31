import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import PatientProfile from './PatientProfile';

// Normalizes what someone might type - tolerates missing "MRN-" prefix,
// stray spaces, and lowercase - into the exact stored format.
function normalizeMrn(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (trimmed === '') return '';
  return trimmed.startsWith('MRN-') ? trimmed : `MRN-${trimmed}`;
}

export default function PatientLookup() {
  const [input, setInput] = useState('');
  const [mrn, setMrn] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeMrn(input);
    setMrn(normalized || null);
  };

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">Patient lookup</h2>
      <p className="mt-0.5 text-xs text-slate-400">Open a patient's profile by their medical record number (MRN).</p>

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <div className="flex flex-1 items-center rounded-2xl border border-slate-200 bg-white px-3 focus-within:ring-2 focus-within:ring-brand-500">
          <Search size={16} className="text-slate-400" />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="MRN-00012456"
            className="w-full bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-slate-400"
          />
        </div>
        <button type="submit" className="rounded-2xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white">
          Open
        </button>
      </form>

      {mrn && (
        <div className="mt-4">
          <PatientProfile mrn={mrn} />
        </div>
      )}
    </div>
  );
}
