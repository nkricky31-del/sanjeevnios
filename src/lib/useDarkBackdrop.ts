import { useEffect } from 'react';

// The app's body is a light lavender; on the dark label screens that colour
// would flash in the iOS rubber-band overscroll and behind the browser UI.
// Paint the page itself dark while one of those screens is mounted.
export function useDarkBackdrop() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = '#0a0c0e';
    return () => {
      root.style.backgroundColor = previous;
    };
  }, []);
}
