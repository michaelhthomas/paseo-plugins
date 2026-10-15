/** Where an overlay scrollbar's thumb sits for a scroll position, the way Paseo sizes its own. */

const MIN_THUMB_SIZE = 36;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type ScrollMetrics = { offset: number; viewportSize: number; contentSize: number };

export type ThumbGeometry = { visible: boolean; maxScrollOffset: number; thumbSize: number; thumbOffset: number; maxThumbOffset: number };

export function thumbGeometry({ offset, viewportSize, contentSize }: ScrollMetrics): ThumbGeometry {
  const viewport = Math.max(0, viewportSize || 0);
  const content = Math.max(0, contentSize || 0);
  const maxScrollOffset = Math.max(0, content - viewport);
  if (maxScrollOffset <= 0 || viewport <= 0) return { visible: false, maxScrollOffset: 0, thumbSize: 0, thumbOffset: 0, maxThumbOffset: 0 };
  const thumbSize = clamp((viewport * viewport) / content, MIN_THUMB_SIZE, viewport);
  const maxThumbOffset = Math.max(0, viewport - thumbSize);
  const thumbOffset = (clamp(offset, 0, maxScrollOffset) / maxScrollOffset) * maxThumbOffset;
  return { visible: true, maxScrollOffset, thumbSize, thumbOffset, maxThumbOffset };
}

/** The scroll offset for dragging the thumb `dragDelta` pixels from where a drag started. */
export function offsetForDrag(startOffset: number, dragDelta: number, geometry: ThumbGeometry) {
  if (geometry.maxScrollOffset <= 0 || geometry.maxThumbOffset <= 0) return clamp(startOffset, 0, geometry.maxScrollOffset);
  return clamp(startOffset + dragDelta * (geometry.maxScrollOffset / geometry.maxThumbOffset), 0, geometry.maxScrollOffset);
}
