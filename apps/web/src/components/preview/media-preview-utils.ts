export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function clampMediaTime(value: number, duration: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(value, 0), duration);
}

export function formatMediaTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function bufferedMediaTime(
  buffered: TimeRanges | null | undefined,
  currentTime: number,
  duration: number,
): number {
  if (buffered === null || buffered === undefined || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  for (let index = 0; index < buffered.length; index += 1) {
    const start = buffered.start(index);
    const end = buffered.end(index);
    if (currentTime >= start && currentTime <= end) return clampMediaTime(end, duration);
  }
  return 0;
}

export function mediaPercent(value: number, duration: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (value / duration) * 100));
}

export function mediaTimeFromKey(
  key: string,
  currentTime: number,
  duration: number,
  stepSeconds = 5,
): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return duration;
  if (key === 'ArrowLeft') return clampMediaTime(currentTime - stepSeconds, duration);
  if (key === 'ArrowRight') return clampMediaTime(currentTime + stepSeconds, duration);
  return null;
}

export function isPlaybackRate(value: number): value is PlaybackRate {
  return (PLAYBACK_RATES as readonly number[]).includes(value);
}
