import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { ConditionRef } from '../lib/types';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

// conditions_ref is admin-write, everyone-else-read (see schema.sql section
// 24) - this is the "admin can add more" screen the spec calls for.
export default function AdminConditions() {
  const [conditions, setConditions] = useState<ConditionRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('conditions_ref').select('*').order('name', { ascending: true });
    setConditions((data ?? []) as ConditionRef[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addCondition = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Enter a condition name.');
      return;
    }
    setSaving(true);
    const { error: insertError } = await supabase.from('conditions_ref').insert({ name: name.trim() });
    setSaving(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setName('');
    load();
  };

  const toggleActive = async (c: ConditionRef) => {
    await supabase.from('conditions_ref').update({ is_active: !c.is_active }).eq('id', c.id);
    load();
  };

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">Known conditions catalog</h2>
      <p className="mt-0.5 text-xs text-slate-400">
        Shown to patients when they fill in known conditions. Deactivate instead of deleting to keep existing
        patient records intact.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Osteoporosis"
          className="flex-1 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button onClick={addCondition} disabled={saving}>
          {saving ? 'Adding...' : 'Add'}
        </Button>
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}

      <div className="mt-4 space-y-2">
        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {!loading && conditions.length === 0 && <p className="text-sm text-slate-400">No conditions yet.</p>}
        {conditions.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-3">
            <p className="text-sm font-semibold text-slate-900">{c.name}</p>
            <div className="flex items-center gap-2">
              <StatusPill label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'live' : 'neutral'} />
              <button onClick={() => toggleActive(c)} className="text-xs font-bold text-brand-600">
                {c.is_active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
