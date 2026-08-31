/**
 * Decorative brand graphic — not a photo of CollPro staff or completed jobs.
 */
export function PublicHeroVisual() {
  return (
    <div className="public-hero-visual" aria-hidden="true">
      <svg viewBox="0 0 640 520" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="470" cy="150" r="150" fill="#1e6cff" fillOpacity="0.22" />
        <circle cx="470" cy="150" r="88" fill="#1e6cff" fillOpacity="0.35" />
        <path
          d="M318 268 L470 148 L622 268 V412 H318 Z"
          fill="#f4f7fb"
          fillOpacity="0.08"
          stroke="#8fb6ff"
          strokeWidth="3"
        />
        <path d="M360 412 V318 H420 V412" fill="#0a1424" stroke="#8fb6ff" strokeWidth="3" />
        <rect x="500" y="214" width="54" height="42" fill="#1e6cff" fillOpacity="0.85" />
        <path
          d="M188 356 L248 292 H278 L208 372 H178 L148 336 H178 Z"
          fill="#c5d4e8"
        />
        <rect x="214" y="348" width="22" height="78" rx="4" fill="#9aa8bb" />
        <text
          x="64"
          y="460"
          fill="#8fb6ff"
          fontSize="18"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          letterSpacing="3"
        >
          COLLPRO RENO
        </text>
      </svg>
    </div>
  );
}
