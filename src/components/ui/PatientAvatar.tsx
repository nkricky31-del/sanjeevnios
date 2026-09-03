import { useEffect, useState } from 'react';

import { patientPhotoUrl } from '../../lib/storage';

interface Props {
  photoPath: string | null;
  name: string;
  size?: number;
  className?: string;
}

const TONES = ['bg-brand-500', 'bg-coral-500', 'bg-emerald-500', 'bg-amber-500'];

function toneFor(name: string): string {
  return TONES[name.charCodeAt(0) % TONES.length];
}

// A patient's photo when there is one and the viewer is allowed to see it
// (storage RLS decides that, not this component - see schema.sql section
// 35.1), otherwise the same initials-avatar look used everywhere else in the
// app. The signed URL is fetched fresh on mount since it's short-lived.
export default function PatientAvatar({ photoPath, name, size = 56, className = '' }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (photoPath) {
      patientPhotoUrl(photoPath).then((signed) => {
        if (!cancelled) setUrl(signed);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [photoPath]);

  const style = { width: size, height: size };

  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={style}
        className={`shrink-0 rounded-2xl object-cover ${className}`}
      />
    );
  }

  return (
    <span
      style={{ ...style, fontSize: size * 0.4 }}
      className={`flex shrink-0 items-center justify-center rounded-2xl font-extrabold text-white ${toneFor(name)} ${className}`}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
