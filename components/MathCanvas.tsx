
import React, { useRef, useEffect } from 'react';

interface MathCanvasProps {
  onCanvasRef: (canvas: HTMLCanvasElement | null) => void;
}

const MathCanvas: React.FC<MathCanvasProps> = ({ onCanvasRef }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  const prepareCtx = (ctx: CanvasRenderingContext2D) => {
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const parent = canvas.parentElement;
      if (!parent) return;

      const newWidth = parent.clientWidth;
      const newHeight = parent.clientHeight;

      if (canvas.width !== newWidth || canvas.height !== newHeight) {
        // Save existing content before resize (which clears the canvas)
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx && canvas.width > 0 && canvas.height > 0) {
          tempCtx.drawImage(canvas, 0, 0);
        }

        canvas.width = newWidth;
        canvas.height = newHeight;

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, newWidth, newHeight);
          if (tempCanvas.width > 0 && tempCanvas.height > 0) {
            ctx.drawImage(tempCanvas, 0, 0);
          }
          prepareCtx(ctx);
        }
        
        onCanvasRef(canvas);
      }
    };

    window.addEventListener('resize', handleResize);
    // Use a small timeout to ensure parent has laid out
    const timeoutId = setTimeout(handleResize, 0);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, [onCanvasRef]);

  const getPointerPos = (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    
    let clientX, clientY;
    if ('touches' in e) {
      if (e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        return lastPosRef.current;
      }
    } else {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    }

    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    // Prevent default to stop scrolling while drawing on mobile
    if (e.cancelable) e.preventDefault();
    drawingRef.current = true;
    lastPosRef.current = getPointerPos(e);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingRef.current) return;
    if (e.cancelable) e.preventDefault();

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const pos = getPointerPos(e);
    
    ctx.beginPath();
    prepareCtx(ctx); // Re-apply styles to be absolutely sure
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    
    lastPosRef.current = pos;
  };

  const endDrawing = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      prepareCtx(ctx);
    }
  };

  return (
    <div className="relative w-full h-full bg-white rounded-xl shadow-inner border border-slate-200 overflow-hidden cursor-crosshair">
      <canvas
        ref={canvasRef}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={endDrawing}
        onMouseLeave={endDrawing}
        onTouchStart={startDrawing}
        onTouchMove={draw}
        onTouchEnd={endDrawing}
        className="w-full h-full block"
      />
      <div className="absolute top-4 right-4 flex gap-2">
        <button
          onClick={clearCanvas}
          className="bg-white/90 hover:bg-white text-slate-600 px-3 py-1.5 rounded-md border border-slate-300 text-sm font-semibold shadow-sm transition-colors backdrop-blur-sm"
        >
          Clear Board
        </button>
      </div>
    </div>
  );
};

export default MathCanvas;
