import { createContext, useContext } from 'react';

// Live updates for the admin console (migration 90). When something an admin
// acts on changes, the database sends a data-free signal on the private,
// admins-only channel "admin:events", naming only the area that changed.
// AdminLiveProvider (components/shell) listens and counts the signals per
// area; a screen puts useAdminLive([...its areas]) in its load effect's
// dependencies and so reloads within a couple of seconds of a change. A
// refresh every minute while the console is on screen (`tick`) catches the
// busy figures that send no signal (bookings, payments, counts) and covers a
// dropped connection.
export const ADMIN_AREAS = [
  'clinics',
  'doctors',
  'documents',
  'name_changes',
  'reviews',
  'subscriptions',
  'payments',
  'settlements',
  'breakglass',
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

export interface AdminLiveState {
  versions: Partial<Record<AdminArea, number>>;
  tick: number;
}

export const AdminLiveContext = createContext<AdminLiveState>({ versions: {}, tick: 0 });

// A number that changes whenever one of `areas` changes - and, unless
// `periodic` is false, on the once-a-minute refresh too.
export function useAdminLive(areas: readonly AdminArea[] = [], periodic = true): number {
  const { versions, tick } = useContext(AdminLiveContext);
  let n = periodic ? tick : 0;
  for (const a of areas) n += versions[a] ?? 0;
  return n;
}
