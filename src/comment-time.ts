/** Always show a calendar date; include the year for older comments. Full precision is in the tooltip. */
export function commentTime(value: string, now = new Date()): {label: string; full: string} {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, '0');
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  const label = `${year}${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return {label, full: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`};
}
