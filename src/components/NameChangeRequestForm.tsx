import { Lock, ShieldAlert, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ID_DOCUMENTS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { NameChangeRequest } from '../lib/types';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';

interface Props {
  accountId: string;
  // null = requesting a change to the account holder's own profiles.name.
  // set = requesting a change to that family member's family_members.name.
  memberId: string | null;
  currentName: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

// The patient-facing half of schema.sql section 53: the name field itself is
// always shown read-only by the caller (Profile.tsx) - this is the only way
// to actually get it changed. Submitting here never touches the name; it
// only files a name_change_requests row for an admin to act on.
export default function NameChangeRequestForm({ accountId, memberId, currentName }: Props) {
  const [latest, setLatest] = useState<NameChangeRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [requestedName, setRequestedName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    let query = supabase.from('name_change_requests').select('*').eq('account_id', accountId);
    query = memberId === null ? query.is('member_id', null) : query.eq('member_id', memberId);
    const { data } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
    setLatest((data as NameChangeRequest | null) ?? null);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, memberId]);

  const submit = async () => {
    setError(null);
    if (!file) {
      setError('Upload a government ID (Aadhaar, passport, PAN, etc.) as proof.');
      return;
    }
    setSubmitting(true);

    const path = `${accountId}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from(ID_DOCUMENTS_BUCKET).upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setSubmitting(false);
      setError(uploadError.message);
      return;
    }

    const { error: rpcError } = await supabase.rpc('request_name_change', {
      p_member_id: memberId,
      p_requested_name: requestedName.trim() || null,
      p_id_document_path: path,
    });
    setSubmitting(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setSubmitted(true);
    setOpen(false);
    setRequestedName('');
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    load();
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setFile(null);
      return;
    }
    if (!ALLOWED_TYPES.includes(f.type)) {
      setError('Only JPG, PNG, or PDF files are allowed.');
      setFile(null);
      e.target.value = '';
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('File must be under 10MB.');
      setFile(null);
      e.target.value = '';
      return;
    }
    setFile(f);
  };

  if (loading) return null;

  // A pending request already covers this name - no point letting a second
  // one pile up (request_name_change() would refuse it server-side anyway).
  if (latest?.status === 'pending') {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-700">
        <ShieldAlert size={15} className="shrink-0" />
        Name-change request pending review since {new Date(latest.created_at).toLocaleDateString()}.
      </div>
    );
  }

  return (
    <div className="mt-2">
      {latest?.status === 'rejected' && !submitted && (
        <p className="mb-2 text-xs font-medium text-red-600">
          Your last request was rejected: "{latest.reject_reason}"
        </p>
      )}
      {submitted && <p className="mb-2 text-xs font-medium text-emerald-600">Request submitted for review.</p>}

      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Lock size={14} /> Request name change
        </Button>
      ) : (
        <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3">
          <p className="text-xs text-slate-500">
            Current name on file: <span className="font-semibold text-slate-700">{currentName}</span>. Upload a
            government ID (Aadhaar, passport, PAN, etc.) as proof - an admin checks it before anything changes.
          </p>
          <div>
            <label className="text-xs font-bold text-slate-700">Corrected name (optional)</label>
            <input
              type="text"
              value={requestedName}
              onChange={(e) => setRequestedName(e.target.value)}
              placeholder="Leave blank if the ID alone should decide the spelling"
              className="mt-1 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-slate-700">Government ID proof</label>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              onChange={pickFile}
              disabled={submitting}
              className="mt-1 block w-full text-xs"
            />
            <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF - up to 10MB.</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <Button onClick={submit} disabled={submitting}>
              <UploadCloud size={14} /> {submitting ? 'Submitting...' : 'Submit request'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {latest?.status === 'approved' && (
        <div className="mt-2">
          <StatusPill label="Last request approved" tone="live" />
        </div>
      )}
    </div>
  );
}
