import { useState } from 'react';

import { supabase } from '../lib/supabaseClient';
import type { PrescriptionDrug } from '../lib/types';

interface Props {
  appointmentId: string;
  doctorId: string;
  onSaved: () => void;
  onCancel: () => void;
}

export default function VisitNotesForm({ appointmentId, doctorId, onSaved, onCancel }: Props) {
  const [diagnosis, setDiagnosis] = useState('');
  const [notes, setNotes] = useState('');
  const [drugs, setDrugs] = useState<PrescriptionDrug[]>([]);
  const [drugName, setDrugName] = useState('');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState('');
  const [duration, setDuration] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addDrug = () => {
    if (!drugName.trim()) return;
    setDrugs((prev) => [
      ...prev,
      { name: drugName.trim(), dosage: dosage.trim(), frequency: frequency.trim(), durationDays: Number(duration) || 0 },
    ]);
    setDrugName('');
    setDosage('');
    setFrequency('');
    setDuration('');
  };

  const save = async () => {
    setError(null);
    setSaving(true);

    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .insert({ appointment_id: appointmentId, diagnosis: diagnosis.trim() || null, notes: notes.trim() || null })
      .select()
      .single();

    if (visitError || !visit) {
      setSaving(false);
      setError(visitError?.message ?? 'Could not save visit notes.');
      return;
    }

    if (drugs.length > 0) {
      const { error: rxError } = await supabase
        .from('prescriptions')
        .insert({ visit_id: visit.id, items: drugs, signed_by: doctorId, status: 'final' });
      if (rxError) {
        setSaving(false);
        setError(rxError.message);
        return;
      }
    }

    setSaving(false);
    onSaved();
  };

  return (
    <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
      <input
        type="text"
        placeholder="Diagnosis"
        value={diagnosis}
        onChange={(e) => setDiagnosis(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
      />
      <textarea
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
      />

      {drugs.length > 0 && (
        <div className="space-y-1">
          {drugs.map((d, i) => (
            <p key={i} className="text-xs text-slate-600">
              • {d.name} — {d.dosage} · {d.frequency} · {d.durationDays}d
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Drug"
          value={drugName}
          onChange={(e) => setDrugName(e.target.value)}
          className="min-w-[100px] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          type="text"
          placeholder="Dosage"
          value={dosage}
          onChange={(e) => setDosage(e.target.value)}
          className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          type="text"
          placeholder="Freq"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          type="text"
          placeholder="Days"
          inputMode="numeric"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="w-16 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button onClick={addDrug} className="rounded-lg bg-slate-200 px-3 py-1.5 text-sm font-medium">
          + Add
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save visit'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
