/**
 * The mark.
 *
 * It used to be a generic arrows icon from a library, used as a logo. A borrowed
 * icon is not a mark: it says "there is a symbol here" and nothing more.
 *
 * This is two strokes starting together and parting — the two rates, BCV and
 * P2P, leaving from the same money and arriving at different figures. It is the
 * one idea planfly has that no other finance app does, so it is the one carrying
 * the symbol. Drawn SVG, not a Unicode glyph.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
      // A single stroke width across the whole mark, same as the navigation icons,
      // so it does not clash beside them.
      strokeWidth={2}
      strokeLinecap="round"
    >
      <path d="M4 12h5" stroke="currentColor" />
      <path d="M9 12c4 0 6-6 11-6" className="stroke-p2p" />
      <path d="M9 12c4 0 6 6 11 6" className="stroke-bcv" />
    </svg>
  );
}
