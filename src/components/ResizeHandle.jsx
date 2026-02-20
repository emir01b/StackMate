import React, { useRef, useEffect } from 'react';
import './ResizeHandle.css';

const ResizeHandle = ({ direction, onResize, onResizeStart, onResizeEnd }) => {
  const handleRef = useRef(null);
  const isDraggingRef = useRef(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const onMouseDown = (e) => {
      e.preventDefault();
      isDraggingRef.current = true;
      startPosRef.current = direction === 'vertical' ? e.clientY : e.clientX;
      startSizeRef.current = onResizeStart?.() || 0;
      document.body.style.cursor = direction === 'vertical' ? 'ns-resize' : 'ew-resize';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e) => {
      if (!isDraggingRef.current) return;
      e.preventDefault();
      const currentPos = direction === 'vertical' ? e.clientY : e.clientX;
      const delta = currentPos - startPosRef.current;
      onResize?.(startSizeRef.current + delta);
    };

    const onMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        onResizeEnd?.();
      }
    };

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      handle.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [direction, onResize, onResizeStart, onResizeEnd]);

  const className = `resize-handle resize-handle-${direction}`;
  return <div ref={handleRef} className={className} />;
};

export default ResizeHandle;
