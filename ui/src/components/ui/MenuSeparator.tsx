/**
 * Hairline that splits a menu into groups of actions — playback above, things
 * that change the playlist below, for example.
 *
 * `h-px` with a background rather than a top border: a border draws on the
 * subpixel grid and can look doubled, while a 1px box stays crisp. It is inset
 * by the item padding so the line starts where the icons and labels do.
 */
export const MenuSeparator = () => (
  <div role="separator" aria-orientation="horizontal" className="mx-2.5 my-1.5 h-px shrink-0 bg-white/10" />
);
