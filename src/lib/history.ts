// Whether this tab has an earlier screen of the app to go back to. React
// Router numbers this tab's history entries (idx), so 0 means this screen was
// the first one opened here - browser "back" would leave the app or do nothing
// (a link opened in a new tab, a reloaded page, the installed app's first
// screen).
export function canGoBack(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx > 0 : false;
}
