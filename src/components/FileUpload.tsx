import { CheckCircle2, FileUp, UploadCloud } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';

import { APPOINTMENT_FILES_BUCKET, openAppointmentFile } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import type { AppointmentFile, FileCategory } from '../lib/types';
import { checkUpload, safeFileName } from '../lib/fileSafety';

interface Props {
  appointmentId: string;
  memberId: string;
  /** Pre-select (and hide the chooser for) one kind of file. */
  fixedCategory?: FileCategory;
  /** Hide the list of files already on this appointment. */
  hideList?: boolean;
  onUploaded?: () => void;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB - matches the bucket's server-side limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

const CATEGORY_LABEL: Record<FileCategory, string> = {
  lab_report: 'Lab report',
  prescription: 'Prescription',
  xray: 'X-ray',
  photo: 'Photo',
};

export default function FileUpload({ appointmentId, memberId, fixedCategory, hideList, onUploaded }: Props) {
  const [files, setFiles] = useState<AppointmentFile[]>([]);
  const [category, setCategory] = useState<FileCategory>(fixedCategory ?? 'lab_report');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

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

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
  };

  // The same checks whether the file was chosen or dropped.
  const processFile = async (file: File) => {
    setError(null);
    setDone(false);
    setPicked(file.name);

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

    const unsafe = await checkUpload(file, ALLOWED_TYPES, MAX_BYTES);
    if (unsafe) {
      setError(unsafe);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setUploading(true);
    const path = `${appointmentId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
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
    setDone(true);
    onUploaded?.();
    window.setTimeout(() => setDone(false), 3500);
    loadFiles();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  const view = async (fileId: string) => {
    const result = await openAppointmentFile(fileId);
    if ('error' in result) setError(result.error);
  };

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 p-4">
      {!hideList && <p className="text-sm font-semibold text-slate-900">Files</p>}

      <div className={`mt-2 space-y-2 ${hideList ? 'hidden' : ''}`}>
        {files.length === 0 && <p className="text-sm text-slate-400">No files uploaded yet.</p>}
        <AnimatePresence initial={false}>
          {files.map((f) => (
            <motion.div
              layout
              key={f.id}
              initial={{ opacity: 0, x: -16, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ type: 'spring', stiffness: 300, damping: 26 }}
              className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2"
            >
              <span className="flex items-center gap-2 text-sm text-slate-700">
                <FileUp size={14} className="text-brand-600" />
                {f.type ? CATEGORY_LABEL[f.type] : 'File'} · {new Date(f.created_at).toLocaleDateString()}
              </span>
              <button onClick={() => view(f.id)} className="cursor-pointer text-sm font-medium text-brand-600 underline-offset-4 hover:underline">
                View
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className={`mt-3 flex items-center gap-2 ${fixedCategory ? 'hidden' : ''}`}>
        <label htmlFor={`${inputId}-type`} className="text-xs font-semibold text-slate-500">
          Type
        </label>
        <select
          id={`${inputId}-type`}
          value={category}
          onChange={(e) => setCategory(e.target.value as FileCategory)}
          className="rounded-2xl border border-slate-200 px-2 py-1.5 text-sm"
        >
          <option value="lab_report">Lab report</option>
          <option value="prescription">Prescription</option>
          <option value="xray">X-ray</option>
          <option value="photo">Photo</option>
        </select>
      </div>

      {/* the drop zone: a real <input type="file"> underneath, so keyboard and screen readers work */}
      <motion.label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        animate={{ scale: dragging ? 1.025 : 1 }}
        whileHover={{ scale: uploading ? 1 : 1.012 }}
        transition={{ type: 'spring', stiffness: 320, damping: 22 }}
        className={`relative mt-3 flex cursor-pointer flex-col items-center gap-1.5 overflow-hidden rounded-2xl border-2 border-dashed px-4 py-6 text-center outline-none transition-colors focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${
          dragging ? 'border-brand-600 bg-brand-50' : 'border-brand-200 bg-slate-50/60 hover:border-brand-400 hover:bg-brand-50/60'
        } ${uploading ? 'pointer-events-none' : ''}`}
      >
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          onChange={handlePick}
          disabled={uploading}
          className="peer sr-only"
        />
        {/* a band of light drifting across the zone */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/4 -skew-x-[20deg] bg-gradient-to-r from-transparent via-brand-100/70 to-transparent"
          animate={{ left: ['-30%', '130%'] }}
          transition={{ duration: 2.6, repeat: Infinity, repeatDelay: 1.8, ease: 'easeInOut' }}
        />
        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <motion.span key="done" initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 12 }} className="relative text-emerald-600">
              <CheckCircle2 size={30} />
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              className="relative text-brand-600"
              animate={dragging ? { y: -6, scale: 1.2 } : uploading ? { y: [0, -8, 0] } : { y: [0, -5, 0] }}
              transition={uploading ? { duration: 0.8, repeat: Infinity } : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <UploadCloud size={30} />
            </motion.span>
          )}
        </AnimatePresence>
        <span className="relative text-sm font-semibold text-slate-800">
          {done ? 'Uploaded' : uploading ? `Uploading ${picked ?? 'file'}...` : dragging ? 'Drop it here' : 'Drop a file here, or tap to choose'}
        </span>
        <span className="relative text-xs text-slate-400">JPG, PNG, or PDF - up to 10MB.</span>
        {uploading && (
          <span className="relative mt-1 block h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
            <motion.span
              className="absolute inset-y-0 w-1/3 rounded-full bg-brand-600"
              animate={{ left: ['-35%', '100%'] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            />
          </span>
        )}
      </motion.label>
      <AnimatePresence>
        {error && (
          <motion.p
            key="err"
            className="mt-2 text-xs text-red-600"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: [0, -6, 6, -4, 4, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
