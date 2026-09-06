import { useEffect } from 'react';

// Per-page <title>/description for the marketing site's client-side routes.
// This only updates what the BROWSER TAB shows while navigating - it can't
// help a social-media link-preview scraper, since those fetch the raw HTML
// of index.html without running any JS. The actual shareable preview (title,
// description, og:image) is the static tags in index.html - see that file's
// own comment. This hook is just the SPA-navigation nicety on top.
export function useDocumentMeta(title: string, description: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;

    const meta = document.querySelector('meta[name="description"]');
    const previousDescription = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', description);

    return () => {
      document.title = previousTitle;
      if (previousDescription !== null) meta?.setAttribute('content', previousDescription);
    };
  }, [title, description]);
}
