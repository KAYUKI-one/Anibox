import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { analyzePixels, coverCrop, type FocusPoint, type ImageAnalysis } from '../domain/appearance';
import type { PageAppearance } from '../domain/types';
import { useBackground } from '../services/useBackground';

export default function PageBackground({
  image,
  blur = 0,
  focus,
  focusMode,
}: {
  image?: string | null;
  blur?: number;
  focus?: FocusPoint;
  focusMode?: 'auto' | 'manual';
}) {
  const container = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ width: 1, height: 1 });
  const [metadata, setMetadata] = useState<{
    source: string;
    width: number;
    height: number;
    analysis?: ImageAnalysis;
  }>();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const current = metadata?.source === image ? metadata : undefined;
  const crop = coverCrop(
    current?.width ?? frame.width,
    current?.height ?? frame.height,
    frame.width,
    frame.height,
    focusMode === 'manual' ? (focus ?? { x: 0.5, y: 0.5 }) : undefined,
    current?.analysis,
  );
  const scale = 1 + (Math.max(0, blur) * 3) / Math.max(1, Math.min(frame.width, frame.height));
  return (
    <div className="page-background" ref={container} aria-hidden="true">
      {image && (
        <img
          key={image}
          src={image}
          alt=""
          draggable={false}
          className="page-background-image"
          data-focus-x={crop.focus.x.toFixed(3)}
          data-focus-y={crop.focus.y.toFixed(3)}
          style={{
            objectPosition: `${crop.positionX}% ${crop.positionY}%`,
            filter: blur ? `blur(${blur}px)` : undefined,
            transform: blur ? `scale(${scale})` : undefined,
          }}
          onLoad={(event) => {
            const img = event.currentTarget;
            let analysis: ImageAnalysis | undefined;
            try {
              const canvas = document.createElement('canvas');
              const ratio = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
              canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
              canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                analysis = analyzePixels(
                  ctx.getImageData(0, 0, canvas.width, canvas.height).data,
                  canvas.width,
                  canvas.height,
                );
              }
            } catch {
              /* A readable center crop remains available if analysis is unavailable. */
            }
            setMetadata({ source: image, width: img.naturalWidth, height: img.naturalHeight, analysis });
          }}
        />
      )}
    </div>
  );
}

export function AppearancePreview({
  appearance,
  directory,
}: {
  appearance: PageAppearance;
  directory?: string;
}) {
  const image = useBackground(appearance, directory);
  const [aspect, setAspect] = useState(1.6);
  useEffect(() => {
    const panel = document.querySelector('.main-panel');
    if (!panel) return;
    const observer = new ResizeObserver(([entry]) =>
      setAspect(entry.contentRect.width / Math.max(1, entry.contentRect.height)),
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="appearance-preview"
      aria-label="背景与卡片预览"
      style={{ aspectRatio: aspect, '--surface-opacity': appearance.opacity / 100 } as CSSProperties}
    >
      <PageBackground
        image={image}
        blur={appearance.blur}
        focus={appearance.focus}
        focusMode={appearance.focusMode}
      />
      <div className="glass preview-sample">
        <strong>文字预览</strong>
        <span>123.45 KB/s</span>
        <span className="preview-control">连接方式</span>
      </div>
    </div>
  );
}
