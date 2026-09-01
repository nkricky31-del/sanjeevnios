import { useEffect, useState } from 'react';

import { todayISO } from '../lib/date';
import { supabase } from '../lib/supabaseClient';
import type { ClinicHoliday } from '../lib/types';
import Button from './ui/Button';

interface Props {
  clinicId: string;
}

// The only way clinic_holidays (migration_25) ever gets populated - without
// this, SlotPicker's holiday filtering would have nothing to filter.
export default function ClinicHolidays({ clinicId }: Props) {
  const [holidays, setHolidays] = useState<ClinicHoliday[]>([]);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase
      .from('clinic_holidays')
      .select('*')
      .eq('clinic_id', clinicId)
      .gte('date', todayISO())
      .order('date', { ascending: true });
    setHolidays((data ?? []) as ClinicHoliday[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  const addHoliday = async () => {
    setError(null);
    if (!date) {
      setError('Pick a date.');
      return;
    }
    setSaving(true);
    const { error: insertError } = await supabase
      .from('clinic_holidays')
      .insert({ clinic_id: clinicId, date, reason: reason.trim() || null });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setDate('');
    setReason('');
    load();
  };

  const removeHoliday = async (id: string) => {
    await supabase.from('clinic_holidays').delete().eq('id', id);
    load();
  };

  return (
    <div className="mt-3 rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-bold text-slate-900">Holidays</p>
      <p className="mt-0.5 text-xs text-slate-400">
        Dates the clinic is closed - hidden from patients booking ahead and from the walk-in future-booking calendar.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <input
          type="date"
          value={date}
          min={todayISO()}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="flex-1 rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button onClick={addHoliday} disabled={saving}>
          {saving ? 'Adding...' : 'Add'}
        </Button>
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      <div className="mt-3 space-y-1.5">
        {holidays.length === 0 && <p className="text-sm text-slate-400">No upcoming holidays set.</p>}
        {holidays.map((h) => (
          <div key={h.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-700">
              {h.date}
              {h.reason && <span className="text-slate-400"> — {h.reason}</span>}
            </span>
            <button onClick={() => removeHoliday(h.id)} className="text-xs font-semibold text-red-600">
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
