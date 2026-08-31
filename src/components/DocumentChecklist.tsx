import { useEffect, useRef, useState } from 'react';

import { uploadableDocTypesFor, type DocumentTypeConfig } from '../lib/documentTypes';
import { openVerificationDoc, VERIFICATION_DOCS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { DocumentRow, OwnerType } from '../lib/types';
import StatusPill from './ui/StatusPill';

interface Props {
  ownerType: OwnerType;
  ownerId: string;
  onChanged?: () => void;
}

const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

function statusTone(latest: DocumentRow | undefined): 'live' | 'warning' | 'info' | 'neutral' {
  if (!latest) return 'neutral';
  if (latest.status === 'verified') return 'live';
  if (latest.status === 'rejected') return 'warning';
  return 'info'; // pending review (upload or "not applicable" claim)
}

function statusLabel(latest: DocumentRow | undefined): string {
  if (!latest) return 'Not uploaded';
  if (latest.not_applicable) {
    if (latest.status === 'verified') return 'Not applicable (confirmed)';
    if (latest.status === 'rejected') return 'Not applicable claim rejected';
    return 'Not applicable (pending review)';
  }
  if (latest.status === 'verified') return 'Verified';
  if (latest.status === 'rejected') return 'Rejected';
  return 'Pending review';
}

interface RowState {
  number: string;
  expiry: string;
  naNote: string;
  showNa: boolean;
  saving: boolean;
  error: string | null;
}

const EMPTY_ROW_STATE: RowState = { number: '', expiry: '', naNote: '', showNa: false, saving: false, error: null };

export default function DocumentChecklist({ ownerType, ownerId, onChanged }: Props) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const configs = uploadableDocTypesFor(ownerType);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('documents')
      .select('*')
      .eq('owner_type', ownerType)
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });
    setDocuments((data ?? []) as DocumentRow[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerType, ownerId]);

  const latestFor = (key: string) => documents.find((d) => d.doc_type === key);

  const getRowState = (key: string): RowState => rowState[key] ?? EMPTY_ROW_STATE;
  const patchRowState = (key: string, patch: Partial<RowState>) =>
    setRowState((prev) => ({ ...prev, [key]: { ...getRowState(key), ...patch } }));

  const upload = async (config: DocumentTypeConfig) => {
    const state = getRowState(config.key);
    const file = fileRefs.current[config.key]?.files?.[0] ?? null;
    if (!file) {
      patchRowState(config.key, { error: 'Choose a file first.' });
      return;
    }
    if (!ALLOWED_DOC_TYPES.includes(file.type)) {
      patchRowState(config.key, { error: 'File must be a JPG, PNG, or PDF.' });
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      patchRowState(config.key, { error: 'File must be under 10MB.' });
      return;
    }

    patchRowState(config.key, { saving: true, error: null });
    const path = `${ownerType}s/${ownerId}/${config.key}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from(VERIFICATION_DOCS_BUCKET).upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      patchRowState(config.key, { saving: false, error: uploadError.message });
      return;
    }

    const { error: insertError } = await supabase.from('documents').insert({
      owner_type: ownerType,
      owner_id: ownerId,
      doc_type: config.key,
      storage_path: path,
      number: config.hasNumber ? state.number.trim() || null : null,
      expiry_date: config.hasExpiry ? state.expiry || null : null,
      status: 'pending',
    });
    patchRowState(config.key, { saving: false });
    if (insertError) {
      patchRowState(config.key, { error: insertError.message });
      return;
    }
    if (fileRefs.current[config.key]) fileRefs.current[config.key]!.value = '';
    setRowState((prev) => ({ ...prev, [config.key]: { ...EMPTY_ROW_STATE } }));
    load();
    onChanged?.();
  };

  const saveNotApplicable = async (config: DocumentTypeConfig) => {
    const state = getRowState(config.key);
    if (!state.naNote.trim()) {
      patchRowState(config.key, { error: 'Add a short note explaining why this is not applicable.' });
      return;
    }
    patchRowState(config.key, { saving: true, error: null });
    const { error: insertError } = await supabase.from('documents').insert({
      owner_type: ownerType,
      owner_id: ownerId,
      doc_type: config.key,
      not_applicable: true,
      not_applicable_note: state.naNote.trim(),
      status: 'pending',
    });
    patchRowState(config.key, { saving: false });
    if (insertError) {
      patchRowState(config.key, { error: insertError.message });
      return;
    }
    setRowState((prev) => ({ ...prev, [config.key]: { ...EMPTY_ROW_STATE } }));
    load();
    onChanged?.();
  };

  const view = async (path: string) => {
    await openVerificationDoc(path);
  };

  if (loading) return <p className="text-sm text-slate-400">Loading documents...</p>;

  return (
    <div className="space-y-3">
      {configs.map((config) => {
        const latest = latestFor(config.key);
        const state = getRowState(config.key);
        const needsAction = !latest || latest.status === 'rejected';

        return (
          <div key={config.key} className="rounded-2xl border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-slate-900">
                {config.label}
                {config.required && <span className="text-coral-500"> *</span>}
              </p>
              <StatusPill label={statusLabel(latest)} tone={statusTone(latest)} />
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{config.description}</p>

            {latest?.number && <p className="mt-1 text-xs text-slate-500">Number: {latest.number}</p>}
            {latest?.expiry_date && <p className="text-xs text-slate-500">Expires: {latest.expiry_date}</p>}
            {latest?.not_applicable && latest.not_applicable_note && (
              <p className="mt-1 text-xs text-slate-500">Note: {latest.not_applicable_note}</p>
            )}
            {latest?.status === 'rejected' && latest.review_note && (
              <p className="mt-1 text-xs font-medium text-red-600">Reason: {latest.review_note}</p>
            )}
            {latest?.storage_path && (
              <button onClick={() => view(latest.storage_path!)} className="mt-1 text-xs font-semibold text-brand-600">
                View uploaded file
              </button>
            )}

            {needsAction && !latest?.not_applicable && (
              <div className="mt-2 space-y-2">
                {!state.showNa && (
                  <>
                    <input
                      ref={(el) => {
                        fileRefs.current[config.key] = el;
                      }}
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      className="block w-full text-xs"
                    />
                    {config.hasNumber && (
                      <input
                        type="text"
                        value={state.number}
                        onChange={(e) => patchRowState(config.key, { number: e.target.value })}
                        placeholder="Registration / document number"
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    )}
                    {config.hasExpiry && (
                      <input
                        type="date"
                        value={state.expiry}
                        onChange={(e) => patchRowState(config.key, { expiry: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => upload(config)}
                        disabled={state.saving}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        {state.saving ? 'Uploading...' : latest ? 'Re-upload' : 'Upload'}
                      </button>
                      {config.allowNotApplicable && (
                        <button
                          onClick={() => patchRowState(config.key, { showNa: true, error: null })}
                          className="text-xs font-semibold text-slate-500"
                        >
                          Mark not applicable instead
                        </button>
                      )}
                    </div>
                  </>
                )}

                {state.showNa && (
                  <div className="space-y-2 rounded-lg bg-slate-50 p-2.5">
                    <textarea
                      value={state.naNote}
                      onChange={(e) => patchRowState(config.key, { naNote: e.target.value })}
                      placeholder="Why doesn't this apply?"
                      rows={2}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveNotApplicable(config)}
                        disabled={state.saving}
                        className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                      >
                        {state.saving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => patchRowState(config.key, { showNa: false, error: null })}
                        className="text-xs font-semibold text-slate-500"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {state.error && <p className="text-xs text-red-600">{state.error}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
