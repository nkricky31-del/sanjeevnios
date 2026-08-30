import { useEffect, useRef, useState } from 'react';

import { APPOINTMENT_FILES_BUCKET, openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, FileCategory } from '../lib/types';

interface Props {
  appointmentId: string;
  memberId: string;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const CATEGORY_LABEL: Record<FileCategory, string> = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  xray: 'X-ray',
  photo: 'Photo',
};

export default function FileUpload({ appointmentId, memberId }: Props) {
  const [files, setFiles] = useState<AppointmentFile[]>([]);
  const [category, setCategory] = useState<FileCategory>('lab_report');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFiles = async () => {
    const { data } = await supabase
      .from('files')
      .select('*')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: false });
    setFiles(data ?? []);
  };

  useEffect(() => {
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId]);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only JPG, PNG, or PDF files are allowed.');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10MB.');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setUploading(true);
    const path = `${appointmentId}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from(APPOINTMENT_FILES_BUCKET).upload(path, file, {
      contentType: file.type,
    });

    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    const { error: insertError } = await supabase.from('files').insert({
      member_id: memberId,
      appointment_id: appointmentId,
      type: category,
      storage_path: path,
    });

    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';

    if (insertError) {
      setError(insertError.message);
      return;
    }
    loadFiles();
  };

  const view = async (path: string) => {
    const url = await openAppointmentFile(path);
    if (!url) setError('Could not open file.');
  };

  return (
    <div className="mt-4 rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-semibold text-slate-900">Files</p>

      <div className="mt-2 space-y-2">
        {files.length === 0 && <p className="text-sm text-slate-400">No files uploaded yet.</p>}
        {files.map((f) => (
          <div key={f.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span className="text-sm text-slate-700">
              {f.type ? CATEGORY_LABEL[f.type] : 'File'} · {new Date(f.created_at).toLocaleDateString()}
            </span>
            <button onClick={() => view(f.storage_path)} className="text-sm font-medium text-brand-600">
              View
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as FileCategory)}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="lab_report">Lab report</option>
          <option value="prescription">Prescription</option>
          <option value="xray">X-ray</option>
          <option value="photo">Photo</option>
        </select>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          onChange={handlePick}
          disabled={uploading}
          className="text-sm"
        />
      </div>
      {uploading && <p className="mt-1 text-xs text-slate-400">Uploading...</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-1 text-xs text-slate-400">JPG, PNG, or PDF - up to 10MB.</p>
    </div>
  );
}
