// Shared by PatientLogin/ClinicLogin/AdminLogin. App.tsx sends a signed-out
// visitor to a role's login as ?next=<path> whenever they opened a PRIVATE
// url directly - this is the other half of that redirect, sending them back
// once they're signed in. Only ever treated as an in-app path: rejects
// anything that isn't a leading "/" (so a missing/garbled param just falls
// back to home) and anything starting with "//" (a protocol-relative URL -
// //evil.com would otherwise be handed straight to react-router's
// navigate() as if it were a same-origin path).
export function safeNext(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}
