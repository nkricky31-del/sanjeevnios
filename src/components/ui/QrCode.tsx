import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface Props {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}

// Renders `value` as a QR image. Drawn to a data URL rather than a <canvas>
// so it survives re-renders, scales crisply, and can be long-pressed/saved
// like any other image on a phone.
export default function QrCode({ value, size = 180, className = '', alt = 'Booking QR code' }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      width: size * 2, // rendered at 2x so it stays sharp on dense screens
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1e1b3a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (failed) {
    return (
      <div
        className={`flex items-center justify-center rounded-2xl bg-slate-100 text-xs text-slate-400 ${className}`}
        style={{ width: size, height: size }}
      >
        QR unavailable
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-center overflow-hidden rounded-2xl bg-white ${className}`}
      style={{ width: size, height: size }}
    >
      {dataUrl && <img src={dataUrl} alt={alt} width={size} height={size} />}
    </div>
  );
}
