interface Props {
  size?: number;
  className?: string;
}

// The SanjeevniOS mark: a heart that follows the screen's accent (indigo by default) with a white medical cross
// punched out of it. Inline SVG rather than an asset so it scales cleanly
// and picks up the accent at any size.
export default function BrandMark({ size = 64, className = '' }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" className={className} aria-label="SanjeevniOS">
      <defs>
        <linearGradient id="sanjeevni-heart" x1="12" y1="6" x2="52" y2="58" gradientUnits="userSpaceOnUse">
          <stop style={{ stopColor: 'var(--accent, #3b5bdb)' }} />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--accent, #3b5bdb) 78%, #111827)' }} />
        </linearGradient>
      </defs>
      <path
        d="M32 57S6 41.6 6 24.2C6 14.7 13.4 8 22 8c5.2 0 9.1 2.5 10 5.6C32.9 10.5 36.8 8 42 8c8.6 0 16 6.7 16 16.2C58 41.6 32 57 32 57Z"
        fill="url(#sanjeevni-heart)"
      />
      <path
        d="M28.4 17.6h7.2v7.2h7.2v7.2h-7.2v7.2h-7.2v-7.2h-7.2v-7.2h7.2v-7.2Z"
        fill="#fff"
        rx="2"
      />
    </svg>
  );
}
