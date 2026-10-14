// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable image previews must be keyboard reachable.

import { MagnifyingGlassMinusIcon } from '@phosphor-icons/react/MagnifyingGlassMinus';
import { MagnifyingGlassPlusIcon } from '@phosphor-icons/react/MagnifyingGlassPlus';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import './image-preview.css';

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const GUTTER = 24;

export function ImagePreview({ alt, src }: { readonly alt: string; readonly src: string }) {
  const viewport = useRef<HTMLElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const dragged = useRef(false);
  const anchor = useRef<{ x: number; y: number; u: number; v: number } | null>(null);
  const ready = size.width > 0 && size.height > 0 && !failed;
  const fit = ready
    ? Math.min(
        1,
        Math.max(1, area.width - GUTTER * 2) / size.width,
        Math.max(1, area.height - GUTTER * 2) / size.height,
      )
    : 1;
  const scale = zoom ?? fit;
  const enlarged = scale > fit + 0.001;

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setArea({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current;
    const bounds = image.current?.getBoundingClientRect();
    const point = anchor.current;
    if (element && bounds && point) {
      element.scrollLeft += bounds.left + bounds.width * point.u - point.x;
      element.scrollTop += bounds.top + bounds.height * point.v - point.y;
    } else if (element && zoom === null) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    }
    anchor.current = null;
  }, [zoom]);

  function changeZoom(next: number | null, point?: { x: number; y: number }) {
    if (!ready || next === zoom) return;
    anchor.current = null;
    const bounds = image.current?.getBoundingClientRect();
    const frame = viewport.current?.getBoundingClientRect();
    if (next !== null && bounds && frame) {
      const x = point?.x ?? frame.left + frame.width / 2;
      const y = point?.y ?? frame.top + frame.height / 2;
      anchor.current = {
        x,
        y,
        u: (x - bounds.left) / bounds.width,
        v: (y - bounds.top) / bounds.height,
      };
    }
    setZoom(next);
  }

  function stepZoom(direction: 1 | -1) {
    const next =
      direction === 1
        ? (ZOOM_STEPS.find((value) => value > scale + 0.001) ?? 4)
        : (ZOOM_STEPS.findLast((value) => value < scale - 0.001 && value > fit) ?? null);
    changeZoom(next);
  }

  function stopDrag() {
    drag.current = null;
    setDragging(false);
  }

  return (
    <section
      aria-label="Image preview"
      className="artifact-surface image-preview"
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          stepZoom(1);
        } else if (event.key === '-') {
          event.preventDefault();
          stepZoom(-1);
        } else if (event.key === '0' || event.key === 'Escape') {
          event.preventDefault();
          changeZoom(null);
        }
      }}
    >
      <fieldset aria-label="Image zoom controls" className="image-preview-toolbar">
        <button
          aria-label="Zoom out"
          disabled={!ready || scale <= fit + 0.001}
          onClick={() => stepZoom(-1)}
          title="Zoom out (-)"
          type="button"
        >
          <MagnifyingGlassMinusIcon aria-hidden="true" size={18} />
        </button>
        <output aria-label="Image zoom" aria-live="polite">
          {ready ? `${Math.round(scale * 100)}%` : '—'}
        </output>
        <button
          aria-label="Zoom in"
          disabled={!ready || scale >= 4}
          onClick={() => stepZoom(1)}
          title="Zoom in (+)"
          type="button"
        >
          <MagnifyingGlassPlusIcon aria-hidden="true" size={18} />
        </button>
        <span aria-hidden="true" className="image-preview-divider" />
        <button
          aria-label="Actual size"
          aria-pressed={zoom === 1}
          disabled={!ready}
          onClick={() => changeZoom(1)}
          title="Actual size"
          type="button"
        >
          1:1
        </button>
        <button
          aria-label="Fit image"
          aria-pressed={zoom === null}
          disabled={!ready}
          onClick={() => changeZoom(null)}
          title="Fit image (0 or Escape)"
          type="button"
        >
          Fit
        </button>
      </fieldset>
      <section
        aria-label="Image canvas"
        className="artifact-image image-preview-viewport"
        ref={viewport}
        tabIndex={0}
      >
        {failed ? (
          <p className="folder-preview-state">This image could not be loaded.</p>
        ) : (
          <div
            className="image-preview-canvas"
            style={{
              width: Math.max(area.width, size.width * scale + GUTTER * 2),
              height: Math.max(area.height, size.height * scale + GUTTER * 2),
            }}
          >
            <button
              aria-label={enlarged ? 'Zoom image out to fit' : 'Zoom image in'}
              className="image-preview-target"
              data-dragging={dragging || undefined}
              data-enlarged={enlarged || undefined}
              disabled={!ready}
              onClick={(event) => {
                if (dragged.current && event.detail !== 0) {
                  dragged.current = false;
                  return;
                }
                changeZoom(
                  enlarged ? null : Math.max(1, fit * 2),
                  event.detail === 0 ? undefined : { x: event.clientX, y: event.clientY },
                );
              }}
              onLostPointerCapture={stopDrag}
              onPointerCancel={stopDrag}
              onPointerDown={(event) => {
                dragged.current = false;
                if (
                  !enlarged ||
                  event.pointerType !== 'mouse' ||
                  event.button !== 0 ||
                  !viewport.current
                )
                  return;
                drag.current = {
                  id: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  left: viewport.current.scrollLeft,
                  top: viewport.current.scrollTop,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const start = drag.current;
                if (!start || start.id !== event.pointerId || !viewport.current) return;
                const dx = event.clientX - start.x;
                const dy = event.clientY - start.y;
                if (Math.hypot(dx, dy) < 4 && !dragged.current) return;
                dragged.current = true;
                setDragging(true);
                viewport.current.scrollLeft = start.left - dx;
                viewport.current.scrollTop = start.top - dy;
              }}
              onPointerUp={stopDrag}
              style={ready ? { width: size.width * scale, height: size.height * scale } : undefined}
              title={enlarged ? 'Click to fit · Drag to pan' : 'Click to zoom in'}
              type="button"
            >
              <img
                alt={alt}
                draggable={false}
                onError={() => setFailed(true)}
                onLoad={(event) =>
                  setSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                ref={image}
                referrerPolicy="no-referrer"
                src={src}
              />
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
