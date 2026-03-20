import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import './App.css';
import ImageEditorModal from './components/ImageEditorModal';
import ToolsPage from './pages/ToolsPage';
import { formatBytes } from './utils/formatBytes';

const HEIC_SIGNATURES = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'];
const SUPPORTED_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'bmp',
  'gif',
  'avif',
];
const MAX_BATCH_FILES = 80;
const DEFAULT_QUALITY_PERCENT = 90;
const QUALITY_COOKIE_NAME = 'alxora_webp_quality';
const STATUS_STYLES = {
  pending: 'bg-stone-100 text-stone-700',
  processing: 'bg-amber-100 text-amber-800',
  done: 'bg-emerald-100 text-emerald-800',
  error: 'bg-rose-100 text-rose-700',
};

const createId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);

const readSliceAsArrayBuffer = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.error) {
        reject(reader.error);
      } else {
        resolve(reader.result);
      }
    };
    reader.readAsArrayBuffer(blob);
  });

const isLikelyHeic = async (file) => {
  if (!file) return false;
  const mime = file.type?.toLowerCase() ?? '';
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? '';
  if (mime.includes('heic') || mime.includes('heif')) return true;
  if (ext === 'heic' || ext === 'heif') return true;
  try {
    const slice = file.slice(4, 12);
    const buffer = await readSliceAsArrayBuffer(slice);
    if (!(buffer instanceof ArrayBuffer)) {
      return false;
    }
    const signature = new TextDecoder().decode(new Uint8Array(buffer));
    return HEIC_SIGNATURES.some((marker) => signature.includes(marker));
  } catch {
    return false;
  }
};

let heicConverter;
const loadHeicConverter = async () => {
  if (heicConverter) return heicConverter;
  const module = await import('heic2any');
  heicConverter = module.default ?? module;
  return heicConverter;
};

const convertHeicToPngBlob = async (file) => {
  const converter = await loadHeicConverter();
  const converted = await converter({
    blob: file,
    toType: 'image/png',
    quality: 0.92,
  });

  return converted instanceof Blob
    ? converted
    : new Blob([converted], { type: 'image/png' });
};

const createLocalProcessingBlob = async (file) => {
  const heicLike = await isLikelyHeic(file);
  if (heicLike) {
    return convertHeicToPngBlob(file);
  }
  return file;
};

const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Compression failed while generating the blob.'));
        }
      },
      type,
      quality
    );
  });

const renderImageToCanvas = async (blob) => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(bitmap, 0, 0);
      return canvas;
    } finally {
      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas);
    };
    img.onerror = (event) => {
      URL.revokeObjectURL(objectUrl);
      reject(
        event?.error || new Error('Failed to read processed image for compress')
      );
    };
    img.src = objectUrl;
  });
};

const sanitizeBaseName = (name, index) => {
  if (!name) return `image-${index + 1}`;
  const trimmed = name.trim();
  if (!trimmed) return `image-${index + 1}`;
  const safe = trimmed.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  return safe || `image-${index + 1}`;
};

const getDisplayName = (file) => {
  const relativePath = file?.webkitRelativePath?.trim();
  if (relativePath) {
    return relativePath.replace(/^\/+/, '');
  }
  return file?.name || 'image';
};

const isSupportedImageFile = (file) => {
  if (!file) return false;
  if (file.type?.startsWith('image/')) return true;
  const extension = file.name?.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_IMAGE_EXTENSIONS.includes(extension);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const yieldToBrowser = () =>
  new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

const readQualityCookie = () => {
  if (typeof document === 'undefined') {
    return DEFAULT_QUALITY_PERCENT;
  }

  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${QUALITY_COOKIE_NAME}=`));

  if (!match) {
    return DEFAULT_QUALITY_PERCENT;
  }

  const value = Number(match.split('=')[1]);
  return Number.isFinite(value) && value >= 40 && value <= 100
    ? value
    : DEFAULT_QUALITY_PERCENT;
};

const persistQualityCookie = (value) => {
  if (typeof document === 'undefined') {
    return;
  }

  document.cookie = `${QUALITY_COOKIE_NAME}=${value}; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
};

const createItem = (file) => ({
  id: createId(),
  file,
  name: file.name || 'image',
  displayName: getDisplayName(file),
  previewUrl: '',
  previewLoading: true,
  status: 'pending',
  resultUrl: '',
  resultBlob: null,
  resultSize: 0,
  compressedUrl: '',
  compressedBlob: null,
  compressedSize: 0,
  isCompressing: false,
  error: '',
});

function BackgroundRemoverApp() {
  const [items, setItems] = useState([]);
  const [globalError, setGlobalError] = useState('');
  const [isCompressingBatch, setIsCompressingBatch] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [qualityPercent, setQualityPercent] = useState(readQualityCookie);
  const [batchMode, setBatchMode] = useState('webp');
  const [isDragActive, setIsDragActive] = useState(false);
  const [editorState, setEditorState] = useState({
    open: false,
    itemId: null,
    target: 'result',
  });
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    persistQualityCookie(qualityPercent);
  }, [qualityPercent]);

  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => {
        [item.previewUrl, item.resultUrl, item.compressedUrl].forEach((url) => {
          if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
        });
      });
    },
    []
  );

  const updateItem = useCallback((id, updater) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updates = typeof updater === 'function' ? updater(item) : updater;
        const next = { ...item, ...updates };
        const maybeRevoke = (url) => {
          if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
        };
        if (item.previewUrl && item.previewUrl !== next.previewUrl) {
          maybeRevoke(item.previewUrl);
        }
        if (item.resultUrl && item.resultUrl !== next.resultUrl) {
          maybeRevoke(item.resultUrl);
        }
        if (item.compressedUrl && item.compressedUrl !== next.compressedUrl) {
          maybeRevoke(item.compressedUrl);
        }
        return next;
      })
    );
  }, []);

  const removeItem = useCallback((id) => {
    setItems((prev) =>
      prev.filter((item) => {
        if (item.id === id) {
          [item.previewUrl, item.resultUrl, item.compressedUrl].forEach((url) => {
            if (url?.startsWith('blob:')) {
              URL.revokeObjectURL(url);
            }
          });
          return false;
        }
        return true;
      })
    );
  }, []);

  const resetAll = useCallback(() => {
    setItems((prev) => {
      prev.forEach((item) => {
        [item.previewUrl, item.resultUrl, item.compressedUrl].forEach((url) => {
          if (url?.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
        });
      });
      return [];
    });
    setGlobalError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
    }
  }, []);

  const generatePreview = useCallback(
    async (id, file) => {
      updateItem(id, { previewLoading: true, error: '' });
      try {
        const heicLike = await isLikelyHeic(file);
        if (heicLike) {
          const convertedBlob = await convertHeicToPngBlob(file);
          updateItem(id, {
            previewUrl: URL.createObjectURL(convertedBlob),
            previewLoading: false,
          });
        } else {
          updateItem(id, {
            previewUrl: URL.createObjectURL(file),
            previewLoading: false,
          });
        }
      } catch {
        updateItem(id, {
          previewUrl: '',
          previewLoading: false,
          error: 'Preview failed, but you can still process this image.',
        });
      }
    },
    [updateItem]
  );

  const ingestFiles = useCallback(
    (fileList) => {
      const selectedFiles = Array.from(fileList ?? []).filter(isSupportedImageFile);
      if (!selectedFiles.length) return;

      const remainingSlots = Math.max(MAX_BATCH_FILES - itemsRef.current.length, 0);
      if (!remainingSlots) {
        setGlobalError(`You can upload up to ${MAX_BATCH_FILES} images in one batch.`);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        if (folderInputRef.current) {
          folderInputRef.current.value = '';
        }
        return;
      }

      const acceptedFiles = selectedFiles.slice(0, remainingSlots);
      const nextItems = acceptedFiles.map((file) => createItem(file));
      setItems((prev) => [...prev, ...nextItems]);
      setGlobalError(
        selectedFiles.length > acceptedFiles.length
          ? `Only ${MAX_BATCH_FILES} images are allowed in one batch. Extra files were skipped.`
          : ''
      );

      nextItems.forEach((item) => {
        updateItem(item.id, { previewLoading: true });
      });

      void (async () => {
        for (const [index, item] of nextItems.entries()) {
          // eslint-disable-next-line no-await-in-loop
          await generatePreview(item.id, item.file);
          if ((index + 1) % 3 === 0) {
            // eslint-disable-next-line no-await-in-loop
            await yieldToBrowser();
          }
        }
      })();

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      if (folderInputRef.current) {
        folderInputRef.current.value = '';
      }
    },
    [generatePreview, updateItem]
  );

  const handleFileChange = useCallback(
    (event) => {
      ingestFiles(event.target.files);
    },
    [ingestFiles]
  );

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    setIsDragActive(true);
  }, []);

  const handleDragEnter = useCallback((event) => {
    event.preventDefault();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event) => {
    event.preventDefault();
    const relatedTarget = event.relatedTarget;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setIsDragActive(false);
      ingestFiles(event.dataTransfer?.files);
    },
    [ingestFiles]
  );

  const compressSingle = useCallback(
    async (item) => {
      if (!item.file) return;
      updateItem(item.id, { isCompressing: true, status: 'processing', error: '' });
      try {
        const sourceBlob = item.resultBlob ?? (await createLocalProcessingBlob(item.file));
        const canvas = await renderImageToCanvas(sourceBlob);
        const compressed = await canvasToBlob(
          canvas,
          'image/webp',
          qualityPercent / 100
        );
        updateItem(item.id, {
          isCompressing: false,
          status: 'done',
          resultBlob: sourceBlob,
          resultSize: sourceBlob.size,
          resultUrl: URL.createObjectURL(sourceBlob),
          compressedBlob: compressed,
          compressedSize: compressed.size,
          compressedUrl: URL.createObjectURL(compressed),
          error: '',
        });
      } catch (err) {
        updateItem(item.id, {
          isCompressing: false,
          status: 'error',
          error: `Compression failed: ${err?.message ?? 'try another image'}`,
        });
      }
    },
    [qualityPercent, updateItem]
  );

  const handleCompressAll = useCallback(async () => {
    if (!itemsRef.current.length) {
      setGlobalError('Add images before creating Alxora-ready WebP exports.');
      return;
    }
    setGlobalError('');
    setIsCompressingBatch(true);
    const itemsToProcess = [...itemsRef.current];
    for (const item of itemsToProcess) {
      // eslint-disable-next-line no-await-in-loop
      await compressSingle(item);
      // eslint-disable-next-line no-await-in-loop
      await yieldToBrowser();
    }
    setIsCompressingBatch(false);
  }, [compressSingle]);

  const handleDownloadAll = useCallback(async () => {
    const readyItems = items.filter((item) => item.compressedBlob);
    if (!readyItems.length) {
      setGlobalError('Create at least one WebP file before exporting.');
      return;
    }

    setGlobalError('');
    setIsZipping(true);
    try {
      for (const [index, item] of readyItems.entries()) {
        const baseName = sanitizeBaseName(item.name, index).replace(
          /\.[^.]+$/,
          ''
        );
        const displayName = baseName || `image-${index + 1}`;
        const primaryBlob = item.compressedBlob;
        if (primaryBlob) {
          const url = URL.createObjectURL(primaryBlob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${displayName}-alxora.webp`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          // Stagger downloads slightly so the browser handles the queue more reliably.
          // eslint-disable-next-line no-await-in-loop
          await wait(120);
        }
      }
    } catch (err) {
      setGlobalError(
        `Failed to download files: ${err?.message ?? 'Please try again.'}`
      );
    } finally {
      setIsZipping(false);
    }
  }, [items]);

  const convertedCount = useMemo(
    () => items.filter((item) => item.compressedBlob).length,
    [items]
  );

  const readyForZipCount = useMemo(
    () => items.filter((item) => item.compressedBlob).length,
    [items]
  );

  const disableCompress = !items.length || isCompressingBatch;
  const disableZip =
    !items.some((item) => item.compressedBlob) ||
    isZipping;

  const editorItem = useMemo(
    () => items.find((item) => item.id === editorState.itemId),
    [items, editorState.itemId]
  );

  const editorSourceBlob =
    editorState.target === 'result'
      ? editorItem?.resultBlob
      : editorItem?.file;

  const openEditor = useCallback((itemId, target) => {
    setEditorState({ open: true, itemId, target });
  }, []);

  const closeEditor = useCallback(() => {
    setEditorState({ open: false, itemId: null, target: 'result' });
  }, []);

  const handleEditorSave = useCallback(
    (blob) => {
      if (!blob || !editorItem) return;
      const objectUrl = URL.createObjectURL(blob);
      if (editorState.target === 'result') {
        updateItem(editorItem.id, {
          resultBlob: blob,
          resultSize: blob.size,
          resultUrl: objectUrl,
          compressedBlob: null,
          compressedUrl: '',
          compressedSize: 0,
        });
      } else {
        const nextName =
          editorItem.name?.replace(/\.[^.]+$/, '') || 'image-edited';
        const updatedFile = new File([blob], `${nextName}.png`, {
          type: 'image/png',
        });
        updateItem(editorItem.id, {
          file: updatedFile,
          name: `${nextName}.png`,
          previewUrl: objectUrl,
          previewLoading: false,
          status: 'pending',
          resultBlob: null,
          resultUrl: '',
          resultSize: 0,
          compressedBlob: null,
          compressedUrl: '',
          compressedSize: 0,
          error: '',
        });
      }
      closeEditor();
    },
    [closeEditor, editorItem, editorState.target, updateItem]
  );

  const batchModes = [
    {
      id: 'webp',
      label: 'WebP',
      eyebrow: 'WebP compression',
      title: 'Control compression without leaving this page',
      description: 'Adjust the WebP level here, then convert your uploaded files into lighter exports.',
      actionLabel: isCompressingBatch ? 'Compressing...' : 'Create WebP exports',
      onAction: handleCompressAll,
      disabled: disableCompress,
    },
    {
      id: 'export',
      label: 'Export',
      eyebrow: 'Download center',
      title: 'Export everything from the current batch',
      description: 'Download ready PNG or WebP files directly from this workspace without opening a separate tool page.',
      actionLabel: isZipping ? 'Starting downloads...' : 'Download all',
      onAction: handleDownloadAll,
      disabled: disableZip,
    },
  ];

  const activeBatchMode = batchModes.find((mode) => mode.id === batchMode) ?? batchModes[0];

  return (
    <div id="top" className="alxora-shell min-h-screen text-stone-900">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div>
            <p className="alxora-wordmark text-3xl leading-none">ALXORA</p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.3em] text-slate-400">
              Image Editor
            </p>
          </div>

          <nav className="flex items-center gap-3 text-sm font-semibold text-slate-700">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 transition hover:bg-slate-100"
            >
              Editor
            </Link>
            <Link
              to="/tools"
              className="rounded-md px-3 py-1.5 transition hover:bg-slate-100"
            >
              WebP Studio
            </Link>
          </nav>
        </div>
      </header>

      <main className="min-h-screen bg-[#f6f7fb]">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-400">
                  Alxora Image Editor
                </p>
                <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                  Batch product image editor
                </h1>
                <p className="mt-4 text-base leading-7 text-slate-500">
                  Upload your product images, edit them, compress them, and export
                  them from one clean batch workspace.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  to="/tools"
                  className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                >
                  WebP Studio
                </Link>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-slate-200 bg-[#f8f9fd] p-3">
                <p className="text-sm text-slate-500">Images in batch</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{items.length}</p>
              </div>
              <div className="rounded-md border border-slate-200 bg-[#f8f9fd] p-3">
                <p className="text-sm text-slate-500">WebP ready</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{convertedCount}</p>
              </div>
              <div className="rounded-md border border-slate-200 bg-[#f8f9fd] p-3">
                <p className="text-sm text-slate-500">Ready to export</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{readyForZipCount}</p>
              </div>
            </div>
          </section>

          <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div
              className={`rounded-md border border-dashed p-6 transition sm:p-8 ${
                isDragActive
                  ? 'border-[#4f46e5] bg-indigo-50'
                  : 'border-slate-300 bg-[#f8f9fd]'
              }`}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <div className="mb-6 flex items-center gap-2">
                  {[0, 1, 2].map((index) => (
                    <div
                      key={index}
                      className="flex h-10 w-10 items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-500"
                    >
                      {index + 1}
                    </div>
                  ))}
                </div>

                <h2 className="text-3xl font-semibold tracking-tight text-slate-950">
                  Import product images
                </h2>
                <p className="mt-3 max-w-xl text-base text-slate-500">
                  Drag and drop images here or click to browse your device.
                </p>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <label
                    htmlFor="file-input"
                    className="inline-flex cursor-pointer items-center justify-center rounded-md bg-[#4f46e5] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#4338ca]"
                  >
                    Upload images
                  </label>
                  <label
                    htmlFor="folder-input"
                    className="inline-flex cursor-pointer items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                  >
                    Upload folder
                  </label>
                </div>
                <input
                  ref={fileInputRef}
                  id="file-input"
                  name="files"
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={handleFileChange}
                />
                <input
                  ref={folderInputRef}
                  id="folder-input"
                  name="folder-files"
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={handleFileChange}
                  webkitdirectory=""
                  directory=""
                />

                <p className="mt-6 text-sm leading-7 text-slate-400">
                  PNG, JPG, JPEG, WEBP, or HEIC. Upload files or a folder with up to 80 images in one batch.
                </p>
              </div>
            </div>
          </section>

          <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-400">
                      {activeBatchMode.eyebrow}
                    </p>
                    <h2 className="mt-3 text-3xl font-semibold text-slate-900">
                      {activeBatchMode.title}
                    </h2>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-500">
                      {activeBatchMode.description}
                    </p>
                  </div>
                  <div className="flex flex-col gap-3 lg:items-end">
                    <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
                      {batchModes.map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                            batchMode === mode.id
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-600 hover:bg-white hover:text-slate-900'
                          }`}
                          onClick={() => setBatchMode(mode.id)}
                        >
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <p className="mt-4 text-sm text-slate-500">
                  {batchMode === 'webp' &&
                    (convertedCount > 0
                      ? `${convertedCount} WebP file(s) created with ${qualityPercent}% quality.`
                      : 'Upload images to start creating WebP exports.')}
                  {batchMode === 'export' &&
                    (readyForZipCount > 0
                      ? `${readyForZipCount} file(s) ready for download.`
                      : 'Create at least one WebP file to enable Download all.')}
                </p>

                <div className="mt-6 grid gap-6 lg:grid-cols-[0.9fr,1.1fr]">
                  <div className="rounded-md border border-slate-200 bg-[#fafbfd] p-4">
                    {batchMode === 'webp' && (
                      <div className="space-y-4">
                        <div className="rounded-md border border-slate-200 bg-white p-4">
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                            Compression quality
                          </p>
                          <div className="mt-3 flex items-center justify-between text-sm text-slate-700">
                            <span>Adjust WebP compression</span>
                            <span className="font-semibold">{qualityPercent}%</span>
                          </div>
                          <input
                            type="range"
                            min="40"
                            max="100"
                            step="1"
                            value={qualityPercent}
                            onChange={(event) => setQualityPercent(Number(event.target.value))}
                            className="mt-3 w-full accent-[#4f46e5]"
                          />
                          <p className="mt-3 text-sm text-slate-600">
                            Lower values compress harder. Higher values keep more detail.
                          </p>
                          <button
                            type="button"
                            className="mt-4 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={handleCompressAll}
                            disabled={disableCompress}
                          >
                            {isCompressingBatch ? 'Processing...' : 'Process WebP'}
                          </button>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Remembered setting</p>
                          <p className="mt-2 text-sm text-slate-700">
                            Your WebP quality is saved locally and reused the next time you return.
                          </p>
                        </div>
                      </div>
                    )}

                    {batchMode === 'export' && (
                      <div className="space-y-4">
                        <div className="rounded-md border border-slate-200 bg-white p-4">
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Download summary</p>
                          <p className="mt-2 text-2xl font-semibold text-slate-900">{readyForZipCount}</p>
                          <p className="mt-2 text-sm text-slate-600">
                            Files ready for direct download from this batch.
                          </p>
                        </div>
                        <div className="rounded-md border border-slate-200 bg-white p-3">
                          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Export mode</p>
                          <p className="mt-2 text-sm text-slate-700">
                            Downloads start individually in sequence, without creating a ZIP file.
                          </p>
                        </div>
                      </div>
                    )}

                    {globalError && (
                      <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                        {globalError}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <h3 className="text-xl font-semibold text-slate-900">Batch queue</h3>
                      <div className="flex items-center gap-2">
                        {readyForZipCount > 0 && (
                          <button
                            type="button"
                            className="rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={handleDownloadAll}
                            disabled={disableZip}
                          >
                            {isZipping ? 'Downloading...' : `Download all (${readyForZipCount})`}
                          </button>
                        )}
                        {!!items.length && (
                          <button
                            type="button"
                            className="rounded-md border border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600 transition hover:border-slate-300"
                            onClick={resetAll}
                          >
                            Clear all
                          </button>
                        )}
                      </div>
                    </div>

                    {items.length === 0 ? (
                      <div className="mt-4 flex min-h-[420px] items-center justify-center rounded-md border border-slate-200 bg-[#fafbfd] p-6 text-center text-slate-500">
                        No images in this batch yet.
                      </div>
                    ) : (
                      <div className="mt-4 grid gap-4 xl:grid-cols-2">
                        {items.map((item, index) => (
                          <article
                            key={item.id}
                            className="overflow-hidden rounded-md border border-slate-200 bg-white"
                          >
                            <div className="aspect-[4/3] bg-[#f4f6fb]">
                              {item.previewLoading ? (
                                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                                  Preparing preview...
                                </div>
                              ) : item.previewUrl ? (
                                <img
                                  src={item.previewUrl}
                                  alt={item.displayName}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                                  Preview unavailable
                                </div>
                              )}
                            </div>

                            <div className="p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="text-base font-semibold text-slate-900 break-all">
                                    {item.displayName}
                                  </p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.22em] text-slate-400">
                                    Slot {index + 1}
                                  </p>
                                </div>
                                <span
                                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[item.status]}`}
                                >
                                  {item.status}
                                </span>
                              </div>

                              <div className="mt-4 flex flex-wrap gap-2">
                                {item.resultBlob && (
                                  <button
                                    type="button"
                                    className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-700 transition hover:border-violet-300"
                                    onClick={() => openEditor(item.id, 'result')}
                                  >
                                    Edit output
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="rounded-md border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:border-rose-300"
                                  onClick={() => removeItem(item.id)}
                                >
                                  Remove
                                </button>
                              </div>

                              <div className="mt-4 space-y-1 text-sm text-slate-600">
                                {item.resultBlob ? (
                                  <p>Source image: {formatBytes(item.resultSize)}</p>
                                ) : (
                                  <p>Ready for WebP conversion</p>
                                )}
                                {item.compressedBlob && (
                                  <p>WebP export: {formatBytes(item.compressedSize)}</p>
                                )}
                              </div>

                              {item.error && (
                                <p className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
                                  {item.error}
                                </p>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>&copy; 2026 Alxora Image Editor</p>
          <div className="flex items-center gap-4">
            <span>Batch editing</span>
            <span>Local exports</span>
            <a href="#top" className="font-semibold text-slate-700">
              Back to top
            </a>
          </div>
        </div>
      </footer>

      <ImageEditorModal
        open={editorState.open}
        sourceBlob={editorSourceBlob}
        onClose={closeEditor}
        onSave={handleEditorSave}
      />
    </div>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<BackgroundRemoverApp />} />
      <Route path="/tools" element={<ToolsPage />} />
    </Routes>
  );
}

export default App;
