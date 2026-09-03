import { Camera } from 'lucide-react';
import { useRef, useState } from 'react';

import { PATIENT_PHOTOS_BUCKET } from '../lib/storage';
import { supabase } from '../lib/supabaseClient';
import PatientAvatar from './ui/PatientAvatar';

interface Props {
  memberId: string;
  name: string;
  photoPath: string | null;
  onUploaded: () => void;
}

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png'];

// The avatar in "My Family" doubles as the upload control - tap it, pick a
// photo, done. This is the ONLY place a photo gets attached to a family
// member; the check-in scan card (schema.sql section 35) only ever displays
// what's uploaded here.
export default function FamilyMemberPhoto({ memberId, name, photoPath, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only JPG or PNG photos are allowed.');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Photo must be under 5MB.');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setUploading(true);
    const path = `${memberId}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from(PATIENT_PHOTOS_BUCKET).upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setUploading(false);
      setError(uploadError.message);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    const { error: updateError } = await supabase
      .from('family_members')
      .update({ photo_path: path })
      .eq('id', memberId);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';

    if (updateError) {
      setError(updateError.message);
      return;
    }
    onUploaded();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="relative block"
        aria-label={`Change ${name}'s photo`}
      >
        <PatientAvatar photoPath={photoPath} name={name} size={56} />
        <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-brand-600 text-white">
          <Camera size={11} />
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        onChange={handlePick}
        disabled={uploading}
        className="hidden"
      />
      {uploading && <p className="mt-1 text-[10px] text-slate-400">Uploading...</p>}
      {error && <p className="mt-1 max-w-[80px] text-[10px] text-red-600">{error}</p>}
    </div>
  );
}
