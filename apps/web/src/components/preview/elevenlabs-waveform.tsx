/**
 * Adapted from the ElevenLabs UI Waveform component.
 * https://github.com/elevenlabs/ui/blob/main/apps/www/registry/elevenlabs-ui/ui/waveform.tsx
 *
 * MIT License
 * Copyright (c) 2025 Eleven Labs Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { type HTMLAttributes, useEffect, useRef } from 'react';

export type ElevenLabsWaveformProps = HTMLAttributes<HTMLDivElement> & {
  readonly data?: readonly number[] | undefined;
  readonly barWidth?: number | undefined;
  readonly barHeight?: number | undefined;
  readonly barGap?: number | undefined;
  readonly barRadius?: number | undefined;
  readonly barColor?: string | undefined;
  readonly fadeEdges?: boolean | undefined;
  readonly fadeWidth?: number | undefined;
  readonly height?: string | number | undefined;
};

export function ElevenLabsWaveform({
  data = [],
  barWidth = 3,
  barHeight: baseBarHeight = 4,
  barGap = 3,
  barRadius = 2,
  barColor,
  fadeEdges = true,
  fadeWidth = 24,
  height = 72,
  className,
  style,
  ...props
}: ElevenLabsWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const heightStyle = typeof height === 'number' ? `${height}px` : height;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;

    const renderWaveform = () => {
      const context = canvas.getContext('2d');
      if (context === null) return;

      const rect = container.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      const computedColor =
        barColor ?? getComputedStyle(container).getPropertyValue('--waveform-color').trim() ?? '';
      const resolvedColor = computedColor.length > 0 ? computedColor : '#737373';
      const barCount = Math.max(1, Math.floor(rect.width / (barWidth + barGap)));
      const centerY = rect.height / 2;

      for (let index = 0; index < barCount; index += 1) {
        const dataIndex = Math.floor((index / barCount) * data.length);
        const value = data[dataIndex] ?? 0;
        const currentBarHeight = Math.max(baseBarHeight, value * rect.height * 0.8);
        const x = index * (barWidth + barGap);
        const y = centerY - currentBarHeight / 2;

        context.fillStyle = resolvedColor;
        context.globalAlpha = 0.34 + value * 0.66;
        context.beginPath();
        context.roundRect(x, y, barWidth, currentBarHeight, barRadius);
        context.fill();
      }

      if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
        const gradient = context.createLinearGradient(0, 0, rect.width, 0);
        const fadePercent = Math.min(0.2, fadeWidth / rect.width);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(fadePercent, 'rgba(255,255,255,0)');
        gradient.addColorStop(1 - fadePercent, 'rgba(255,255,255,0)');
        gradient.addColorStop(1, 'rgba(255,255,255,1)');
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = gradient;
        context.fillRect(0, 0, rect.width, rect.height);
        context.globalCompositeOperation = 'source-over';
      }

      context.globalAlpha = 1;
    };

    renderWaveform();
    if (typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(renderWaveform);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [barColor, barGap, barRadius, barWidth, baseBarHeight, data, fadeEdges, fadeWidth]);

  return (
    <div
      {...props}
      aria-hidden="true"
      className={['elevenlabs-waveform', className].filter(Boolean).join(' ')}
      ref={containerRef}
      style={{ ...style, height: heightStyle }}
    >
      <canvas className="elevenlabs-waveform-canvas" ref={canvasRef} />
    </div>
  );
}
