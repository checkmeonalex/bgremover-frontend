import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Cropper from 'react-cropper';
import 'cropperjs/dist/cropper.css';

const ASPECT_OPTIONS = [
  { id: 'free', label: 'Free crop', value: NaN },
  { id: 'original', label: 'Original' },
  { id: '1:1', label: 'Square 1:1', value: 1 },
  { id: '4:5', label: 'Portrait 4:5', value: 4 / 5 },
  { id: '3:4', label: 'Poster 3:4', value: 3 / 4 },
  { id: '16:9', label: 'Landscape 16:9', value: 16 / 9 },
  { id: '9:16', label: 'Vertical 9:16', value: 9 / 16 },
];

const getAspectRatioValue = (aspectRatio, imageMeta) => {
  if (aspectRatio === 'free') {
    return NaN;
  }

  if (aspectRatio === 'original') {
    if (!imageMeta.width || !imageMeta.height) {
      return NaN;
    }
    return imageMeta.width / imageMeta.height;
  }

  return ASPECT_OPTIONS.find((option) => option.id === aspectRatio)?.value ?? NaN;
};

const clampZoom = (value) => Math.max(0, Math.min(3, value));

const buildContainedCropBox = (bounds, aspectRatio) => {
  if (!bounds) return null;

  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : null;
  let width = bounds.width;
  let height = bounds.height;

  if (ratio) {
    width = bounds.width;
    height = width / ratio;

    if (height > bounds.height) {
      height = bounds.height;
      width = height * ratio;
    }
  }

  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  };
};

const hasFilterAdjustments = ({ brightness, contrast, saturation }) =>
  brightness !== 100 || contrast !== 100 || saturation !== 100;

const loadImageElement = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load the image for export.'));
    img.src = src;
  });

const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create image data from the crop.'));
      }
    }, 'image/png');
  });

const ImageEditorModal = ({
  open,
  sourceBlob,
  onClose,
  onSave,
  title = 'Alxora Image Editor',
}) => {
  const cropperRef = useRef(null);
  const objectUrlRef = useRef('');
  const isApplyingZoomRef = useRef(false);
  const baseZoomRatioRef = useRef(1);
  const hasInitializedCropperZoomRef = useRef(false);

  const [imageSrc, setImageSrc] = useState('');
  const [imageMeta, setImageMeta] = useState({ width: 0, height: 0 });
  const [isReady, setIsReady] = useState(false);
  const [mobileTab, setMobileTab] = useState('crop');
  const [cropActive, setCropActive] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('free');
  const [zoomLevel, setZoomLevel] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(1);
  const [flipY, setFlipY] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);

  useEffect(() => {
    if (!open) {
      setIsReady(false);
      setImageSrc('');
      setImageMeta({ width: 0, height: 0 });
      setMobileTab('crop');
      setCropActive(false);
      setAspectRatio('free');
      setZoomLevel(0);
      setRotation(0);
      setFlipX(1);
      setFlipY(1);
      setBrightness(100);
      setContrast(100);
      setSaturation(100);
      hasInitializedCropperZoomRef.current = false;

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = '';
      }
      return;
    }

    if (!sourceBlob) {
      setImageSrc('');
      setImageMeta({ width: 0, height: 0 });
      hasInitializedCropperZoomRef.current = false;
      return;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(sourceBlob);
    objectUrlRef.current = nextUrl;
    setImageSrc(nextUrl);
    setIsReady(false);
    hasInitializedCropperZoomRef.current = false;

    const img = new Image();
    img.onload = () => {
      setImageMeta({
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.src = nextUrl;
  }, [open, sourceBlob]);

  useEffect(() => () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = '';
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const activeAspectRatio = useMemo(
    () => getAspectRatioValue(aspectRatio, imageMeta),
    [aspectRatio, imageMeta]
  );

  const previewFilter = useMemo(
    () => ({
      '--editor-brightness': `${brightness}%`,
      '--editor-contrast': `${contrast}%`,
      '--editor-saturation': `${saturation}%`,
    }),
    [brightness, contrast, saturation]
  );

  const replaceWorkingImage = useCallback((blob, meta) => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
    }
    const nextUrl = URL.createObjectURL(blob);
    objectUrlRef.current = nextUrl;
    setImageSrc(nextUrl);
    setImageMeta(meta);
    setIsReady(false);
  }, []);

  const syncCanvasAndCropToContain = useCallback(
    (cropperInstance, ratioOverride = activeAspectRatio) => {
      if (!cropperInstance) return;

      const containerData = cropperInstance.getContainerData?.();
      const imageData = cropperInstance.getImageData?.();

      if (!containerData || !imageData?.naturalWidth || !imageData?.naturalHeight) {
        return;
      }

      const fittedScale = Math.min(
        containerData.width / imageData.naturalWidth,
        containerData.height / imageData.naturalHeight
      );

      const canvasWidth = imageData.naturalWidth * fittedScale;
      const canvasHeight = imageData.naturalHeight * fittedScale;
      const canvasData = {
        left: (containerData.width - canvasWidth) / 2,
        top: (containerData.height - canvasHeight) / 2,
        width: canvasWidth,
        height: canvasHeight,
      };

      cropperInstance.setCanvasData(canvasData);

      const cropBox = buildContainedCropBox(canvasData, ratioOverride);
      if (!cropBox) return;
      cropperInstance.setCropBoxData(cropBox);
    },
    [activeAspectRatio]
  );

  useEffect(() => {
    if (!isReady) return;
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    cropper.setAspectRatio(activeAspectRatio);
    if (cropActive) {
      syncCanvasAndCropToContain(cropper, activeAspectRatio);
    }
  }, [activeAspectRatio, cropActive, isReady, syncCanvasAndCropToContain]);

  useEffect(() => {
    if (!isReady) return;
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    cropper.rotateTo(rotation);
  }, [isReady, rotation]);

  useEffect(() => {
    if (!isReady) return;
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    cropper.scaleX(flipX);
    cropper.scaleY(flipY);
  }, [flipX, flipY, isReady]);

  useEffect(() => {
    if (!isReady) return;
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    if (!hasInitializedCropperZoomRef.current) {
      hasInitializedCropperZoomRef.current = true;
      return;
    }
    isApplyingZoomRef.current = true;
    cropper.zoomTo(baseZoomRatioRef.current * (1 + zoomLevel));
    window.requestAnimationFrame(() => {
      isApplyingZoomRef.current = false;
    });
  }, [isReady, zoomLevel]);

  const handleZoomEvent = (event) => {
    if (isApplyingZoomRef.current) return;
    const ratio = event.detail?.ratio ?? baseZoomRatioRef.current;
    const nextZoom = clampZoom(ratio / baseZoomRatioRef.current - 1);
    setZoomLevel((current) => (Math.abs(current - nextZoom) < 0.01 ? current : nextZoom));
  };

  const resetAll = () => {
    const cropper = cropperRef.current?.cropper;
    setAspectRatio('free');
    setZoomLevel(0);
    setCropActive(false);
    setRotation(0);
    setFlipX(1);
    setFlipY(1);
    setBrightness(100);
    setContrast(100);
    setSaturation(100);
    if (cropper) {
      cropper.reset();
      cropper.clear();
      cropper.setAspectRatio(NaN);
      cropper.scaleX(1);
      cropper.scaleY(1);
      cropper.rotateTo(0);
      cropper.zoomTo(baseZoomRatioRef.current);
    }
  };

  const startCrop = () => {
    const cropper = cropperRef.current?.cropper;
    if (!cropActive) {
      setIsReady(false);
      hasInitializedCropperZoomRef.current = false;
      setCropActive(true);
      return;
    }
    if (!cropper) return;
    cropper.crop();
    cropper.setAspectRatio(activeAspectRatio);
    syncCanvasAndCropToContain(cropper, activeAspectRatio);
  };

  const resetCrop = () => {
    const cropper = cropperRef.current?.cropper;
    if (!cropper) return;
    if (!cropActive) {
      startCrop();
      return;
    }
    cropper.clear();
    cropper.crop();
    cropper.setAspectRatio(activeAspectRatio);
    syncCanvasAndCropToContain(cropper, activeAspectRatio);
  };

  const applyCrop = async () => {
    const cropper = cropperRef.current?.cropper;
    if (!cropper || !cropActive) return;

    const croppedCanvas = cropper.getCroppedCanvas({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });

    if (!croppedCanvas) return;

    const blob = await canvasToBlob(croppedCanvas);
    replaceWorkingImage(blob, {
      width: croppedCanvas.width,
      height: croppedCanvas.height,
    });
    setCropActive(false);
    hasInitializedCropperZoomRef.current = false;
    setZoomLevel(0);
    setRotation(0);
    setFlipX(1);
    setFlipY(1);
    setAspectRatio('free');
  };

  const handleSave = async () => {
    const cropper = cropperRef.current?.cropper;
    if (!cropActive) {
      if (!imageSrc || !imageMeta.width || !imageMeta.height) return;
      const image = await loadImageElement(imageSrc);
      const radians = (rotation * Math.PI) / 180;
      const sin = Math.abs(Math.sin(radians));
      const cos = Math.abs(Math.cos(radians));
      const outputWidth = Math.round(imageMeta.width * cos + imageMeta.height * sin);
      const outputHeight = Math.round(imageMeta.width * sin + imageMeta.height * cos);
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = outputWidth;
      outputCanvas.height = outputHeight;
      const context = outputCanvas.getContext('2d');
      if (!context) return;

      context.save();
      context.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
      context.translate(outputWidth / 2, outputHeight / 2);
      context.scale(flipX, flipY);
      context.rotate(radians);
      context.drawImage(image, -imageMeta.width / 2, -imageMeta.height / 2, imageMeta.width, imageMeta.height);
      context.restore();

      outputCanvas.toBlob((blob) => {
        if (blob) {
          onSave(blob);
        }
      }, 'image/png');
      return;
    }

    if (!cropper) return;

    const croppedCanvas = cropper.getCroppedCanvas({
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    });

    if (!croppedCanvas) return;

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = croppedCanvas.width;
    outputCanvas.height = croppedCanvas.height;
    const context = outputCanvas.getContext('2d');
    if (!context) return;

    context.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    context.drawImage(croppedCanvas, 0, 0, outputCanvas.width, outputCanvas.height);

    const targetCanvas = hasFilterAdjustments({ brightness, contrast, saturation })
      ? outputCanvas
      : croppedCanvas;

    targetCanvas.toBlob((blob) => {
      if (blob) {
        onSave(blob);
      }
    }, 'image/png');
  };

  if (!open || !sourceBlob) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80">
      <style>{`
        .alxora-cropper-shell .cropper-container {
          width: 100% !important;
          height: 100% !important;
          max-height: 100%;
        }

        .alxora-cropper-shell .cropper-wrap-box {
          background: transparent;
        }

        .alxora-cropper-shell .cropper-bg {
          background-image:
            linear-gradient(45deg, rgba(15,23,42,0.04) 25%, transparent 25%),
            linear-gradient(-45deg, rgba(15,23,42,0.04) 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, rgba(15,23,42,0.04) 75%),
            linear-gradient(-45deg, transparent 75%, rgba(15,23,42,0.04) 75%);
          background-position: 0 0, 0 10px, 10px -10px, -10px 0;
          background-size: 20px 20px;
          background-color: #f3f5fb;
        }

        .alxora-cropper-shell .cropper-canvas img,
        .alxora-cropper-shell .cropper-view-box img {
          filter: brightness(var(--editor-brightness)) contrast(var(--editor-contrast))
            saturate(var(--editor-saturation));
        }

        .alxora-cropper-shell .cropper-view-box {
          outline: 2px solid rgba(255, 255, 255, 0.95);
          outline-offset: 0;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
          border-radius: 6px;
        }

        .alxora-cropper-shell .cropper-face {
          background-color: rgba(255, 255, 255, 0.04);
        }

        .alxora-cropper-shell .cropper-line,
        .alxora-cropper-shell .cropper-point {
          background-color: #f5be18;
        }

        .alxora-cropper-shell .cropper-dashed {
          border-color: rgba(255, 255, 255, 0.4);
        }

        .alxora-cropper-shell .cropper-center::before,
        .alxora-cropper-shell .cropper-center::after {
          background-color: rgba(255, 255, 255, 0.8);
        }
      `}</style>

      <div className="flex min-h-full w-full flex-col bg-[#f5f6fb] text-slate-900 lg:h-full">
        <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                {title}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                onClick={onClose}
              >
                Close
              </button>
              <button
                type="button"
                className="rounded-md bg-[#f5be18] px-3 py-2 text-sm font-semibold text-black transition hover:bg-[#e8b110]"
                onClick={handleSave}
              >
                Save edits
              </button>
            </div>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 p-3 sm:p-4 lg:h-full lg:flex-row lg:overflow-hidden lg:p-4">
          <section className="alxora-cropper-shell flex min-h-[360px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white lg:flex-1">
            <div
              className="min-h-[320px] bg-[#eef1f8] p-2 lg:min-h-0 lg:flex-1 lg:p-3"
              style={previewFilter}
            >
              {imageSrc && cropActive ? (
                <div className="h-[320px] w-full lg:h-full">
                  <Cropper
                    src={imageSrc}
                    className="h-full w-full"
                    style={{ height: '100%', width: '100%' }}
                    guides
                    center
                    highlight={false}
                    background={false}
                    responsive
                    autoCrop={false}
                    autoCropArea={0.9}
                    viewMode={1}
                    dragMode="move"
                    cropBoxMovable
                    cropBoxResizable
                    movable
                    zoomable
                    scalable
                    rotatable
                    toggleDragModeOnDblclick={false}
                    checkOrientation={false}
                  aspectRatio={activeAspectRatio}
                  zoom={handleZoomEvent}
                  ready={() => {
                    const cropper = cropperRef.current?.cropper;
                    if (cropper) {
                      cropper.crop();
                      syncCanvasAndCropToContain(cropper, activeAspectRatio);
                    }
                    const fittedRatio = cropper?.getImageData?.().ratio;
                    baseZoomRatioRef.current = fittedRatio && fittedRatio > 0 ? fittedRatio : 1;
                    setZoomLevel(0);
                    setIsReady(true);
                  }}
                  ref={cropperRef}
                />
                </div>
              ) : null}
              {imageSrc && !cropActive ? (
                <div className="flex h-full w-full items-center justify-center overflow-hidden">
                  <img
                    src={imageSrc}
                    alt="Editor preview"
                    className="max-h-full max-w-full object-contain"
                    style={{
                      filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`,
                      transform: `rotate(${rotation}deg) scaleX(${flipX}) scaleY(${flipY})`,
                      transformOrigin: 'center center',
                    }}
                  />
                </div>
              ) : null}
            </div>
          </section>

          <aside className="w-full rounded-lg border border-slate-200 bg-white p-3 text-slate-900 lg:max-w-[360px]">
            <div className="mb-3 flex gap-2 lg:hidden">
              {[
                { id: 'crop', label: 'Crop' },
                { id: 'adjust', label: 'Adjust' },
                { id: 'export', label: 'Export' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition ${
                    mobileTab === tab.id ? 'bg-[#f5be18] text-black' : 'border border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                  onClick={() => setMobileTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="grid gap-3 lg:max-h-[calc(100vh-190px)] lg:overflow-y-auto lg:pr-1">
              <section className={`${mobileTab !== 'crop' ? 'hidden lg:block' : ''}`}>
                <div className="rounded-md border border-slate-200 bg-[#fafbff] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Crop controls
                  </p>

                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                        onClick={cropActive ? applyCrop : startCrop}
                      >
                        {cropActive ? 'Apply crop' : 'Start crop'}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                        onClick={() => {
                          const cropper = cropperRef.current?.cropper;
                          if (cropper) {
                            cropper.clear();
                          }
                          setIsReady(false);
                          hasInitializedCropperZoomRef.current = false;
                          setCropActive(false);
                        }}
                      >
                        {cropActive ? 'Cancel crop' : 'Clear crop'}
                      </button>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500">
                        Aspect ratio
                      </label>
                      <select
                        className="mt-2 w-full rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-slate-400 focus:outline-none"
                        value={aspectRatio}
                        onChange={(event) => setAspectRatio(event.target.value)}
                      >
                        {ASPECT_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500">
                        Rotation {rotation}°
                      </label>
                      <input
                        className="mt-2 w-full accent-[#4f46e5]"
                        type="range"
                        min="-180"
                        max="180"
                        step="1"
                        value={rotation}
                        onChange={(event) => setRotation(Number(event.target.value))}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                        onClick={() => setFlipX((current) => current * -1)}
                      >
                        Flip horizontal
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                        onClick={() => setFlipY((current) => current * -1)}
                      >
                        Flip vertical
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className={`${mobileTab !== 'adjust' ? 'hidden lg:block' : ''}`}>
                <div className="rounded-md border border-slate-200 bg-[#fafbff] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Adjustments
                  </p>

                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="block text-xs text-slate-500">
                        Brightness {brightness}%
                      </label>
                      <input
                        className="mt-2 w-full accent-[#4f46e5]"
                        type="range"
                        min="50"
                        max="200"
                        step="1"
                        value={brightness}
                        onChange={(event) => setBrightness(Number(event.target.value))}
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500">
                        Contrast {contrast}%
                      </label>
                      <input
                        className="mt-2 w-full accent-[#4f46e5]"
                        type="range"
                        min="50"
                        max="200"
                        step="1"
                        value={contrast}
                        onChange={(event) => setContrast(Number(event.target.value))}
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-slate-500">
                        Saturation {saturation}%
                      </label>
                      <input
                        className="mt-2 w-full accent-[#4f46e5]"
                        type="range"
                        min="0"
                        max="200"
                        step="1"
                        value={saturation}
                        onChange={(event) => setSaturation(Number(event.target.value))}
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className={`${mobileTab !== 'export' ? 'hidden lg:block' : ''}`}>
                <div className="rounded-md border border-slate-200 bg-[#fafbff] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Export
                  </p>

                  <div className="mt-4 space-y-4">
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-600">
                      {cropActive
                        ? 'Saved as PNG using your manual crop selection'
                        : 'Saved as full image PNG without cropping'}
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                      <button
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                        onClick={resetCrop}
                      >
                        {cropActive ? 'Reset crop box' : 'Start crop'}
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                        onClick={resetAll}
                      >
                        Reset all
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default ImageEditorModal;
