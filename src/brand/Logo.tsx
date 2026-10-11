import { BRAND } from "./brand";

/** The app icon: a coral shuttle sliding along a thread between a phone end and a Mac end. */
export function AppIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="Droid Shuttle" className={className} style={{ flexShrink: 0, borderRadius: "22.3%", boxShadow: "0 0 0 1px rgb(127 140 170 / 0.28)" }}>
      <rect width="1024" height="1024" rx="228" fill={BRAND.ink} />
      <g transform="translate(512 512) rotate(-36)">
        <line x1="-352" y1="0" x2="352" y2="0" stroke={BRAND.thread} strokeWidth="38" strokeLinecap="round" />
        <circle cx="-352" cy="0" r="76" fill={BRAND.mist} />
        <circle cx="352" cy="0" r="76" fill={BRAND.blue} />
        <circle cx="352" cy="0" r="76" fill="none" stroke={BRAND.mist} strokeWidth="22" />
        <path d="M-196 0 A430 430 0 0 1 196 0 A430 430 0 0 1 -196 0 Z" fill={BRAND.coral} />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className ?? ""}`}>
      <AppIcon size={size} />
      <span>{BRAND.name}</span>
    </span>
  );
}

/** A small coral shuttle: rides at the head of progress bars to show something is moving. */
export function ShuttleHead({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg width="18" height="9" viewBox="0 0 36 18" aria-hidden className={className} style={style}>
      <path d="M0 9 Q18 -4 36 9 Q18 22 0 9Z" fill={BRAND.coral} />
    </svg>
  );
}
