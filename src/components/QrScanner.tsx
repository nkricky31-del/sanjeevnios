import jsQR from 'jsqr';
import { CameraOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Called with the raw decoded text. The scanner pauses itself first, so
      the caller can await slow work without the same code firing again. */
  onScan: (text: string) => void;
  onClose: () => void;
  /** Shown under the viewfinder - e.g. the last scan's result. */
  hint?: string;
}

// Full-screen camera viewfinder that decodes QR codes from the video stream.
//
// jsQR over raw canvas pixels rather than a heavier scanning SDK: it's pure
// JS, works the same in every browser that can do getUserMedia, and the
// whole job here is one code type at close range on a reception desk.
export default function QrScanner({ onScan, onClose, hint }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  // Guards against firing onScan repeatedly for the same code while the
  // caller is still working (a check-in round trip takes a moment, and the
  // camera keeps producing frames throughout).
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!cancelled && video && canvas && video.readyState === video.HAVE_ENOUGH_DATA && !busyRef.current) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
          if (found?.data) {
            busyRef.current = true;
            onScan(found.data);
            // Re-arm shortly after, so the receptionist can scan the next
            // patient without closing and reopening the camera.
            setTimeout(() => {
              busyRef.current = false;
            }, 1500);
          }
        }
      }
      if (!cancelled) rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError('This browser cannot open the camera. Use the manual search instead.');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // Denied permission, no camera, or the device is already in use by
        // something else - all end the same way for the receptionist.
        setError('Could not open the camera. Check the browser permission, or use the manual search.');
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-4 text-white">
        <p className="text-base font-bold">Scan patient QR</p>
        <button onClick={onClose} aria-label="Close scanner" className="rounded-full p-2 hover:bg-white/10">
          <X size={22} />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-5">
        {error ? (
          <div className="flex flex-col items-center gap-3 text-center text-white">
            <CameraOff size={36} className="text-white/70" />
            <p className="max-w-xs text-sm">{error}</p>
          </div>
        ) : (
          <div className="relative w-full max-w-sm overflow-hidden rounded-3xl bg-black">
            <video ref={videoRef} playsInline muted className="h-auto w-full" />
            {/* Viewfinder frame */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-48 w-48 rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            {!ready && (
              <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
                Starting camera...
              </p>
            )}
          </div>
        )}

        <p className="mt-4 max-w-xs text-center text-sm text-white/70">
          {hint ?? "Point the camera at the QR code on the patient's booking screen."}
        </p>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
