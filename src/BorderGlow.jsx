import { useCallback, useRef } from 'react';
import './BorderGlow.css';

export default function BorderGlow({
  children,
  edgeSensitivity = 30,
  backgroundColor = '#000000',
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1,
  coneSpread = 25,
  animated = false,
  className = '',
}) {
  const rootRef = useRef(null);

  const getCenter = useCallback((element) => {
    const { width, height } = element.getBoundingClientRect();
    return [width / 2, height / 2];
  }, []);

  const getEdgeProximity = useCallback(
    (element, x, y) => {
      const [centerX, centerY] = getCenter(element);
      const deltaX = x - centerX;
      const deltaY = y - centerY;
      const scaleX = deltaX === 0 ? Infinity : centerX / Math.abs(deltaX);
      const scaleY = deltaY === 0 ? Infinity : centerY / Math.abs(deltaY);
      return Math.min(Math.max(1 / Math.min(scaleX, scaleY), 0), 1);
    },
    [getCenter],
  );

  const getCursorAngle = useCallback(
    (element, x, y) => {
      const [centerX, centerY] = getCenter(element);
      const deltaX = x - centerX;
      const deltaY = y - centerY;
      if (deltaX === 0 && deltaY === 0) return 0;

      const degrees = Math.atan2(deltaY, deltaX) * (180 / Math.PI) + 90;
      return degrees < 0 ? degrees + 360 : degrees;
    },
    [getCenter],
  );

  const handlePointerMove = useCallback(
    (event) => {
      const root = rootRef.current;
      if (!root) return;

      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const edge = getEdgeProximity(root, x, y);
      const angle = getCursorAngle(root, x, y);

      root.style.setProperty('--edge-proximity', (edge * 100).toFixed(3));
      root.style.setProperty('--cursor-angle', `${angle.toFixed(3)}deg`);
    },
    [getCursorAngle, getEdgeProximity],
  );

  const handlePointerLeave = useCallback(() => {
    rootRef.current?.style.setProperty('--edge-proximity', '0');
  }, []);

  return (
    <div
      ref={rootRef}
      className={`border-glow${className ? ` ${className}` : ''}`}
      data-animated={animated || undefined}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{
        '--border-glow-background': backgroundColor,
        '--border-glow-radius': `${borderRadius}px`,
        '--border-glow-padding': `${glowRadius}px`,
        '--border-glow-sensitivity': edgeSensitivity,
        '--border-glow-intensity': glowIntensity,
        '--border-glow-cone': coneSpread,
      }}
    >
      <span className="border-glow-edge" aria-hidden="true" />
      <div className="border-glow-content">{children}</div>
    </div>
  );
}
