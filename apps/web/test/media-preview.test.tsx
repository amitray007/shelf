import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AudioPreview, VideoPreview } from '../src/components/preview/media-preview.js';
import {
  bufferedMediaTime,
  clampMediaTime,
  formatMediaTime,
  mediaPercent,
  mediaTimeFromKey,
} from '../src/components/preview/media-preview-utils.js';

describe('media preview helpers', () => {
  it('formats short and long media durations without fake precision', () => {
    expect(formatMediaTime(0)).toBe('0:00');
    expect(formatMediaTime(61.9)).toBe('1:01');
    expect(formatMediaTime(3661)).toBe('1:01:01');
    expect(formatMediaTime(Number.NaN)).toBe('0:00');
  });

  it('clamps seek values and reports truthful buffered progress', () => {
    expect(clampMediaTime(-3, 100)).toBe(0);
    expect(clampMediaTime(120, 100)).toBe(100);
    expect(mediaPercent(25, 100)).toBe(25);
    const ranges = {
      length: 2,
      start: (index: number) => [0, 60][index] ?? 0,
      end: (index: number) => [30, 90][index] ?? 0,
    } satisfies TimeRanges;
    expect(bufferedMediaTime(ranges, 20, 100)).toBe(30);
    expect(bufferedMediaTime(ranges, 45, 100)).toBe(0);
  });

  it('maps media keyboard shortcuts to bounded timeline positions', () => {
    expect(mediaTimeFromKey('ArrowLeft', 10, 20)).toBe(5);
    expect(mediaTimeFromKey('ArrowRight', 19, 20)).toBe(20);
    expect(mediaTimeFromKey('Home', 10, 20)).toBe(0);
    expect(mediaTimeFromKey('End', 10, 20)).toBe(20);
    expect(mediaTimeFromKey('PageDown', 10, 20)).toBeNull();
  });
});

describe('media preview semantics', () => {
  it('uses metadata-only audio and exposes custom accessible controls', () => {
    const html = renderToStaticMarkup(
      <AudioPreview src="https://cdn.example.test/track.mp3" title="Demo track" />,
    );
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain('autoplay');
    expect(html).toContain('aria-label="Demo track"');
    expect(html).toContain('aria-label="Play audio"');
    expect(html).toContain('aria-label="Back 10 seconds"');
    expect(html).toContain('aria-label="Forward 10 seconds"');
    expect(html).toContain('aria-label="Seek audio"');
    expect(html).toContain('aria-label="Demo track volume"');
    expect(html).toContain('aria-label="Demo track playback speed"');
    expect(html).toContain('elevenlabs-waveform');
    expect(html).toContain('Streaming');
    expect(html).toContain('Loading');
  });

  it('keeps video poster input and native fallback opt-in', () => {
    const html = renderToStaticMarkup(
      <VideoPreview
        nativeControls
        poster="https://cdn.example.test/poster.jpg"
        src="https://cdn.example.test/video.mp4"
        title="Demo video"
      />,
    );
    expect(html).toContain('poster="https://cdn.example.test/poster.jpg"');
    expect(html).toContain('controls=""');
    expect(html).toContain('playsInline=""');
    expect(html).toContain('aria-label="Picture in picture"');
    expect(html).toContain('aria-label="Enter fullscreen"');
    expect(html).not.toContain('autoplay');
  });
});
