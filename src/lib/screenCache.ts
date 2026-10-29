// What each screen showed last, kept in memory for this browser tab: going
// back to a screen shows it at once while fresh data loads behind it, instead
// of a loading animation every time. Emptied when the person signs out or a
// different person signs in (AuthContext) - never shared between accounts,
// never written to disk.
const store = new Map<string, unknown>();

export const screenCache = {
  get<T>(key: string): T | undefined {
    return store.get(key) as T | undefined;
  },
  set<T>(key: string, value: T): void {
    store.set(key, value);
  },
  // Updates some of a screen's remembered values (screens that load in parts).
  patch<T extends object>(key: string, part: Partial<T>): void {
    store.set(key, { ...((store.get(key) as T | undefined) ?? {}), ...part });
  },
  clear(): void {
    store.clear();
  },
};
