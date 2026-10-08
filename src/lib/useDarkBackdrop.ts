import { useEffect } from 'react';

// Paint the page itself the off-white ground while the website / sign-in screens
// are mounted, so no other colour shows in the overscroll or behind the browser UI.
export function useDarkBackdrop() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = '#fafbfc';
    return () => {
      root.style.backgroundColor = previous;
    };
  }, []);
}
