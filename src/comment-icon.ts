/** A speech bubble with one horizontal stroke, matching the compact comment action. */
export function commentIcon(container: HTMLElement): void {
  const svg = container.createSvg('svg', {attr: {viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'}});
  svg.createSvg('path', {attr: {d: 'M5 3.75h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-4l-3 2.5-3-2.5H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z'}});
  svg.createSvg('path', {attr: {d: 'M8 10.75h8'}});
}
