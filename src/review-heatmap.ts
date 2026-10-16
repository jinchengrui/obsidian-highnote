/** Width is the grid itself, after subtracting the weekday axis and padding. */
export function heatmapWeeks(width: number, pitch = 22): number | null {
  if (!Number.isFinite(pitch) || pitch <= 0) throw new RangeError('列步长必须大于零');
  return Number.isFinite(width) && width > 0 ? Math.max(1, Math.floor(width / pitch)) : null;
}

/** Work on calendar keys at UTC noon, independent of local daylight-saving changes. */
export function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function monday(day: string): string {
  return shiftDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

/** Preserve the right-hand week during resize; latest is the current calendar week. */
export function heatmapRange(today: string, weeks: number, endWeek = ''): {start: string; end: string; lastWeek: string} {
  const current = monday(today), requested = endWeek ? monday(endWeek) : current;
  const lastWeek = requested > current ? current : requested;
  const lastDay = shiftDay(lastWeek, 6);
  return {start: shiftDay(lastWeek, -(Math.max(1, weeks) - 1) * 7), end: lastDay > today ? today : lastDay, lastWeek};
}
