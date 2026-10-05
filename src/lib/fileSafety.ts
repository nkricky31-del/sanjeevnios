// Client-side upload checks. These are a first line only - the real limits
// (size, allowed MIME types, private bucket, signed-URL access) are enforced by
// Supabase Storage on the server. What this adds that the server's MIME check
// can't: a file's DECLARED type is just a header the sender chooses, so we also
// read the first bytes and require them to match, and refuse PDFs that carry
// active content.

export type SniffedType = 'image/jpeg' | 'image/png' | 'application/pdf';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

export async function sniffFileType(file: File): Promise<SniffedType | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  return null;
}

// PDF features that run code or launch things. Legitimate scans and
// prescriptions don't use them.
const ACTIVE_PDF_MARKERS = ['/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/RichMedia'];

async function pdfHasActiveContent(file: File): Promise<boolean> {
  const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
  return ACTIVE_PDF_MARKERS.some((m) => new RegExp(`${m.replace('/', '\\/')}(?![A-Za-z])`).test(text));
}

// Resolves to an error message, or null when the file is acceptable.
export async function checkUpload(file: File, allowed: readonly string[], maxBytes: number): Promise<string | null> {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > maxBytes) return `File must be under ${Math.round(maxBytes / 1024 / 1024)}MB.`;
  if (!allowed.includes(file.type)) return 'That file type is not allowed.';
  const real = await sniffFileType(file);
  if (!real || real !== file.type) return 'That file does not look like a real ' + file.type.split('/')[1].toUpperCase() + '.';
  if (real === 'application/pdf' && (await pdfHasActiveContent(file))) {
    return 'That PDF contains scripts or embedded files, which are not allowed. Re-save it as a plain PDF.';
  }
  return null;
}

// A storage path segment from a user-chosen file name: no directory parts, no
// control or exotic characters, bounded length, extension kept.
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80);
  return cleaned || 'file';
}
