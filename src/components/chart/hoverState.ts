/**
 * When the candle inspector should let go of the bar it is showing.
 *
 * This looks trivial and is not, because the inspector floats *over* the
 * chart it reads from. Its header is a drag handle and its story panel
 * scrolls, so both take pointer events — and the moment the cursor crosses
 * onto either, two things fire at once:
 *
 *   * lightweight-charts emits a crosshair move with no `time`, because the
 *     pointer is no longer over the series;
 *   * the chart container emits `pointerleave`, because the pointer entered a
 *     different element.
 *
 * Both look exactly like "the user left the chart", so the inspector snapped
 * back to the live bar. Since the card can be parked anywhere — including in
 * the middle of the candles — this happened constantly and looked like the
 * inspector randomly refusing to track certain candles. It was tracking fine;
 * it was being told to stop.
 *
 * The rule: a pointer that has moved onto the card has not left the chart. It
 * has moved onto the thing displaying the reading, and the reading should
 * stay put.
 *
 * Kept as pure functions in their own module so the decision can be tested
 * without a chart, a DOM or a mouse.
 */

/**
 * The next hovered bar time, given a crosshair event.
 *
 * `null` from the chart means "not over a bar". That is only allowed to clear
 * the selection when the pointer is somewhere other than the card.
 */
export function nextHoveredTime(
  eventTime: number | null,
  current: number | null,
  overCard: boolean
): number | null {
  if (eventTime !== null) return eventTime;
  // Over the card: keep whatever bar is being read. Clearing here is what made
  // the panel jump to the live bar the instant the cursor touched its header.
  return overCard ? current : null;
}

/**
 * Whether a `pointerleave` on the chart container should clear the hover.
 *
 * `relatedTarget` is the element being entered — null when the pointer left
 * the window entirely, which *is* a genuine departure.
 */
export function shouldReleaseHover(
  relatedTarget: Node | null,
  cardRoot: Node | null,
  overCard: boolean
): boolean {
  if (overCard) return false;
  if (relatedTarget && cardRoot && cardRoot.contains(relatedTarget)) return false;
  return true;
}
