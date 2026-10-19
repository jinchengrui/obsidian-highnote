export interface ScreenRect {left: number; right: number; top: number; bottom: number}
export const COMMENT_TOOLBAR_SIZE = {width: 60, height: 30};

export function toolbarPosition(anchor: ScreenRect, bounds: ScreenRect, width: number, height: number): {left: number; top: number} | null {
  const margin = 8;
  if (bounds.right - bounds.left < width + margin * 2 || bounds.bottom - bounds.top < height + margin * 2
    || anchor.bottom < bounds.top || anchor.top > bounds.bottom || anchor.right < bounds.left || anchor.left > bounds.right) return null;
  const left = Math.max(bounds.left + margin, Math.min((anchor.left + anchor.right - width) / 2, bounds.right - width - margin));
  const above = anchor.top - height - margin;
  const below = anchor.bottom + margin;
  const top = above >= bounds.top + margin ? above : below + height <= bounds.bottom - margin ? below : null;
  return top === null ? null : {left, top};
}
