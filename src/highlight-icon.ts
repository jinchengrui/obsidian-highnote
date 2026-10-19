/** An upright chisel-tip highlighter, sized to match the adjacent comment icon. */
export function highlightIcon(container: HTMLElement): void {
  const svg = container.createSvg('svg', {attr: {viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'}});
  svg.createSvg('path', {attr: {d: 'M7 3v6l2 3v6h6v-6l2-3V3M7 8h10M9 12h6M9 18l1 3 4-2v-1'}});
}
