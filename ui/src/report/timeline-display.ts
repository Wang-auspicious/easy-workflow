import type { DisplayInterval, TimeSegment, TimeStrip } from './activity.ts';

export interface DisplaySegment extends TimeSegment { intervalCount: number; aggregated: boolean }

/** Bound DOM work to display resolution. Exact intervals and totals remain in the report. */
export function timelineDisplay(strip: TimeStrip, columns = 480): DisplaySegment[] {
  if (strip.segments.length <= columns) return strip.segments.map(segment => ({ ...segment, intervalCount: segment.intervals.length, aggregated: false }));
  const width = Math.max(1, strip.end - strip.start) / columns;
  const cells = Array.from({ length: columns }, (_, index) => ({ from: strip.start + index * width, to: Math.min(strip.end, strip.start + (index + 1) * width), keys: new Set<TimeSegment['keys'][number]>(), ids: new Set<string>(), intervals: [] as DisplayInterval[] }));
  for (const segment of strip.segments) {
    const first = Math.max(0, Math.floor((segment.from - strip.start) / width));
    const last = Math.min(columns - 1, Math.ceil((segment.to - strip.start) / width) - 1);
    for (let index = first; index <= last; index++) {
      const cell = cells[index];
      for (const key of segment.keys) cell.keys.add(key);
      for (const interval of segment.intervals) if (!cell.ids.has(interval.id)) {
        cell.ids.add(interval.id);
        if (cell.intervals.length < 6) cell.intervals.push(interval);
      }
    }
  }
  return cells.map(cell => ({ from: cell.from, to: cell.to, keys: [...cell.keys], intervals: cell.intervals, intervalCount: cell.ids.size, aggregated: true }));
}
