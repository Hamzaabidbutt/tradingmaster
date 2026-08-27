/**
 * Drag geometry for the candle inspector.
 *
 * Pure functions over plain numbers, kept out of the component so they can be
 * tested without a DOM. Layout maths is exactly the kind of code that looks
 * obviously right and is quietly wrong at the edges — a card stranded off
 * screen, or snapped into a corner by a measurement taken a frame too early.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  width: number;
  height: number;
}

/**
 * Keep `pos` inside `container`, given a card of size `card`.
 *
 * Returns `pos` untouched when either box has no size yet. That case is not
 * hypothetical: `ResizeObserver` fires as soon as it starts observing, which
 * can be before the chart has been laid out, and clamping against a zero-width
 * container would compute a maximum of 0 and pin the card to the top-left
 * corner — permanently, since the position is persisted.
 */
export function clampPosition(pos: Point, card: Box, container: Box): Point {
  if (container.width <= 0 || container.height <= 0) return pos;
  if (card.width <= 0 || card.height <= 0) return pos;

  const maxX = Math.max(0, container.width - card.width);
  const maxY = Math.max(0, container.height - card.height);
  return {
    x: Math.round(Math.min(Math.max(0, pos.x), maxX)),
    y: Math.round(Math.min(Math.max(0, pos.y), maxY)),
  };
}

/**
 * Where the card should sit for a pointer at `pointer`.
 *
 * `grab` is the cursor's offset *within* the card when the drag started;
 * without it the card would jump so its corner met the cursor on the first
 * move, which feels like the card being snatched rather than dragged.
 * Coordinates are viewport-relative and converted against `containerOrigin`.
 */
export function nextPosition(
  pointer: Point,
  grab: Point,
  containerOrigin: Point,
  card: Box,
  container: Box
): Point {
  return clampPosition(
    { x: pointer.x - containerOrigin.x - grab.x, y: pointer.y - containerOrigin.y - grab.y },
    card,
    container
  );
}

/** True when two positions are the same to the pixel. */
export function samePosition(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}
