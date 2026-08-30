import { useState } from 'react';

interface Props {
  label: string;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}

export default function AdminRejectForm({ label, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('Enter a reason - this is shown to the clinic.');
      return;
    }
    setSaving(true);
    await onConfirm(trimmed);
    setSaving(false);
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-red-50 p-3">
      <label className="text-sm font-medium text-red-900">{label}</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason shown to the clinic..."
        rows={2}
        className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-red-400"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Rejecting...' : 'Confirm reject'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
