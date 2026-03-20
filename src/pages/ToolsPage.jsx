import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ImageEditorModal from '../components/ImageEditorModal';
import { formatBytes } from '../utils/formatBytes';

const DEFAULT_WEBP_QUALITY = 0.9;
const DEFAULT_QUALITY_PERCENT = 90;
const QUALITY_COOKIE_NAME = 'alxora_webp_quality';

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

const createId = () =>
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);

const canvasToBlob = (canvas, type = 'image/webp', quality = DEFAULT_WEBP_QUALITY) =>
  new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Unable to create a WebP file from the canvas.'));
          }
        },
        type,
        quality
      );
      return;
    }

    reject(new Error('WebP export is not supported in this browser.'));
  });

const renderFileToCanvas = async (file) => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { alpha: false });
      context.drawImage(bitmap, 0, 0);
      return canvas;
    } finally {
      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (event) =>
        reject(event?.error || new Error('Unsupported image format. Please try another file.'));
      img.src = objectUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(image, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const yieldToBrowser = () =>
  new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });

const convertFileToWebpBlob = async (file, quality) => {
  const canvas = await renderFileToCanvas(file);
  const blob = await canvasToBlob(canvas, 'image/webp', quality);
  return { blob, originalPreview: URL.createObjectURL(file) };
};

const revokeBlobUrl = (url) => {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
};

const cleanupJobResources = (job) => {
  if (!job) return;
  revokeBlobUrl(job.originalPreview);
  revokeBlobUrl(job.convertedPreview);
};

const buildConvertedFileName = (jobId) => {
  const fragment = jobId.replace(/^tool-/, '');
  return `alxora-webp-${fragment}.webp`;
};

function ToolsPage() {
  const fileInputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [qualityPercent, setQualityPercent] = useState(readQualityCookie);
  const [editorState, setEditorState] = useState({ open: false, jobId: null });
  const jobsRef = useRef([]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    persistQualityCookie(qualityPercent);
  }, [qualityPercent]);

  useEffect(
    () => () => {
      jobsRef.current.forEach(cleanupJobResources);
    },
    []
  );

  const webpQuality = useMemo(() => qualityPercent / 100, [qualityPercent]);

  const updateJob = useCallback((id, updater) => {
    setJobs((prev) =>
      prev.map((job) => {
        if (job.id !== id) return job;
        const updates = typeof updater === 'function' ? updater(job) : updater;
        if (
          Object.prototype.hasOwnProperty.call(updates, 'convertedPreview') &&
          job.convertedPreview &&
          job.convertedPreview !== updates.convertedPreview
        ) {
          revokeBlobUrl(job.convertedPreview);
        }
        return { ...job, ...updates };
      })
    );
  }, []);

  const convertSingleJob = useCallback(
    async (jobId, file) => {
      if (!file?.type?.startsWith('image/')) {
        updateJob(jobId, {
          status: 'error',
          error: 'Only image files can be converted.',
        });
        return;
      }

      updateJob(jobId, { status: 'converting', error: '' });

      try {
        const { blob, originalPreview } = await convertFileToWebpBlob(
          file,
          webpQuality
        );
        const convertedName = buildConvertedFileName(jobId);
        const convertedFile = new File([blob], convertedName, {
          type: 'image/webp',
        });
        const convertedPreview = URL.createObjectURL(convertedFile);
        updateJob(jobId, {
          status: 'done',
          convertedFile,
          convertedSize: blob.size,
          error: '',
          originalPreview,
          convertedPreview,
        });
      } catch (error) {
        updateJob(jobId, {
          status: 'error',
          error: error?.message ?? 'Conversion failed. Please try again.',
        });
      }
    },
    [updateJob, webpQuality]
  );

  const handleFiles = useCallback(
    async (fileList) => {
      const incomingFiles = Array.from(fileList ?? []).filter((file) => file.size);
      if (!incomingFiles.length) return;

      const preparedJobs = incomingFiles.map((file) => ({
        id: createId(),
        file,
        originalName: file.name,
        originalSize: file.size,
        originalType: file.type,
        status: 'pending',
        convertedFile: null,
        convertedSize: 0,
        error: '',
        originalPreview: '',
        convertedPreview: '',
      }));

      setJobs((prev) => [...preparedJobs, ...prev]);

      for (const [index, job] of preparedJobs.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await convertSingleJob(job.id, job.file).catch(() => {
          /* handled in convertSingleJob */
        });
        if ((index + 1) % 2 === 0) {
          // eslint-disable-next-line no-await-in-loop
          await yieldToBrowser();
        }
      }
    },
    [convertSingleJob]
  );

  const handleInputChange = useCallback(
    async (event) => {
      await handleFiles(event.target.files);
      event.target.value = '';
    },
    [handleFiles]
  );

  const handleDrop = useCallback(
    async (event) => {
      event.preventDefault();
      await handleFiles(event.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
  }, []);

  const handleDownload = useCallback((job) => {
    if (!job?.convertedFile) return;
    const url = URL.createObjectURL(job.convertedFile);
    const link = document.createElement('a');
    link.href = url;
    link.download = job.convertedFile.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }, []);

  const handleRemoveJob = useCallback((id) => {
    setJobs((prev) => {
      const target = prev.find((job) => job.id === id);
      if (!target) return prev;
      cleanupJobResources(target);
      return prev.filter((job) => job.id !== id);
    });
  }, []);

  const clearAllJobs = useCallback(() => {
    setJobs((prev) => {
      if (!prev.length) return prev;
      prev.forEach(cleanupJobResources);
      return [];
    });
  }, []);

  const convertedJobs = useMemo(
    () => jobs.filter((job) => job.status === 'done' && job.convertedFile),
    [jobs]
  );

  const editorJob = useMemo(
    () => jobs.find((job) => job.id === editorState.jobId),
    [editorState.jobId, jobs]
  );

  const openEditor = useCallback((jobId) => {
    setEditorState({ open: true, jobId });
  }, []);

  const closeEditor = useCallback(() => {
    setEditorState({ open: false, jobId: null });
  }, []);

  const handleEditorSave = useCallback(
    async (blob) => {
      if (!blob || !editorJob) return;
      const baseName =
        editorJob.originalName?.replace(/\.[^.]+$/, '') || 'image';
      const editedFile = new File([blob], `${baseName}-edited.png`, {
        type: 'image/png',
      });

      updateJob(editorJob.id, {
        file: editedFile,
        originalName: editedFile.name,
        originalSize: editedFile.size,
        originalType: editedFile.type,
        status: 'pending',
        convertedFile: null,
        convertedSize: 0,
        error: '',
        originalPreview: '',
        convertedPreview: '',
      });

      closeEditor();
      await convertSingleJob(editorJob.id, editedFile);
    },
    [closeEditor, convertSingleJob, editorJob, updateJob]
  );

  return (
    <div className="min-h-screen bg-[#f5f6fb] text-slate-900">
      <div className="mx-auto max-w-7xl px-4 py-6 lg:px-8">
        <header className="mb-6 flex flex-col gap-4 rounded-lg border border-slate-200 bg-white px-5 py-5 shadow-sm sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">
                Alxora Studio
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
                WebP Converter
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-slate-500">
                Convert product images into clean, lightweight WebP files and download them locally.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                to="/"
                className="rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
              >
                Back to batch
              </Link>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-[#f7f7fb] p-3">
              <p className="text-sm text-slate-500">Files in queue</p>
              <p className="mt-2 text-3xl font-semibold">{jobs.length}</p>
            </div>
            <div className="rounded-md border border-slate-200 bg-[#f7f7fb] p-3">
              <p className="text-sm text-slate-500">Ready to download</p>
              <p className="mt-2 text-3xl font-semibold">{convertedJobs.length}</p>
            </div>
              <div className="rounded-md border border-slate-200 bg-[#f7f7fb] p-3">
                <p className="text-sm text-slate-500">Compression quality</p>
                <p className="mt-2 text-lg font-semibold">{qualityPercent}%</p>
              </div>
          </div>
        </header>

        <section className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div
              className="rounded-md border border-dashed border-slate-300 bg-[#f8f9fd] p-6 text-center transition hover:border-slate-400"
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  fileInputRef.current?.click();
                }
              }}
            >
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-slate-200 bg-white text-2xl">
                +
              </div>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight text-slate-950">
                Drop images here
              </h2>
              <p className="mt-3 text-base text-slate-500">
                or click to browse. JPG, PNG, WEBP, HEIC, TIFF and more.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <span className="rounded-md bg-[#4f46e5] px-4 py-2.5 text-sm font-semibold text-white">
                  Import images
                </span>
                <span className="rounded-md border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700">
                  Local conversion only
                </span>
              </div>
              <p className="mt-6 text-sm leading-7 text-slate-400">
                Files remain on your device. Converted WebP versions are generated in the browser.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={handleInputChange}
              />
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-[#fafbff] p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Quality
                </p>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-sm text-slate-700">
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
                  <p className="mt-3 text-sm text-slate-700">
                    Lower values compress harder and reduce file size more. Higher values keep more image detail.
                  </p>
                  <p className="mt-2 text-sm text-slate-500">
                    Exports are re-encoded without camera metadata to keep WebP files smaller.
                  </p>
                </div>
              </div>
              <div className="rounded-md border border-slate-200 bg-[#fafbff] p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Output
                </p>
                <p className="mt-2 text-sm text-slate-700">
                  Current setting: WebP quality {qualityPercent}%. New imports will use this value during conversion.
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  Metadata is stripped during export.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
                  Converted files
                </h2>
                <p className="mt-2 text-sm text-slate-500">
                  {convertedJobs.length} ready out of {jobs.length} files
                </p>
              </div>
              {!!jobs.length && (
                <button
                  type="button"
                  className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                  onClick={clearAllJobs}
                >
                  Clear list
                </button>
              )}
            </div>

            {jobs.length === 0 ? (
              <div className="mt-5 flex min-h-[520px] items-center justify-center rounded-md border border-slate-200 bg-[#f8f9fd] p-6 text-center text-slate-400">
                No conversions yet. Import images to start a new batch.
              </div>
            ) : (
              <div className="mt-5 grid gap-3">
                {jobs.map((job) => (
                  <article
                    key={job.id}
                    className="rounded-md border border-slate-200 bg-[#fcfcfe] p-3"
                  >
                    <div className="grid gap-4 lg:grid-cols-[160px,1fr]">
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
                        {job.originalPreview ? (
                          <div className="rounded-md border border-slate-200 bg-white p-2">
                            <img
                              src={job.originalPreview}
                              alt={`Original preview for ${job.originalName}`}
                              className="h-28 w-full rounded-sm object-contain"
                              loading="lazy"
                            />
                          </div>
                        ) : (
                          <div className="flex h-32 items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-400">
                            Original
                          </div>
                        )}

                        {job.convertedPreview ? (
                          <div className="rounded-md border border-violet-200 bg-violet-50 p-2">
                            <img
                              src={job.convertedPreview}
                              alt={`WebP preview for ${job.originalName}`}
                              className="h-28 w-full rounded-sm object-contain"
                              loading="lazy"
                            />
                          </div>
                        ) : (
                          <div className="flex h-32 items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-400">
                            WebP
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-lg font-semibold text-slate-950">
                              {job.originalName}
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                              Original: {formatBytes(job.originalSize)}
                            </p>
                            {job.convertedFile && (
                              <p className="mt-1 text-sm text-violet-700">
                                WebP: {formatBytes(job.convertedSize)}
                              </p>
                            )}
                          </div>

                          <span
                            className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${
                              job.status === 'done'
                                ? 'bg-emerald-100 text-emerald-700'
                                : job.status === 'converting'
                                  ? 'bg-amber-100 text-amber-700'
                                  : job.status === 'error'
                                    ? 'bg-rose-100 text-rose-700'
                                    : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {job.status}
                          </span>
                        </div>

                        <div className="mt-4 text-sm text-slate-500">
                          {job.status === 'pending' && 'Queued for conversion.'}
                          {job.status === 'converting' && 'Converting image to WebP...'}
                          {job.status === 'done' && 'Ready to download.'}
                          {job.status === 'error' && (
                            <span className="text-rose-600">
                              {job.error || 'Unable to convert this file.'}
                            </span>
                          )}
                        </div>

                        <div className="mt-5 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="rounded-md border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                            onClick={() => openEditor(job.id)}
                          >
                            Edit image
                          </button>
                          {job.convertedFile && (
                            <button
                              type="button"
                              className="rounded-md bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                              onClick={() => handleDownload(job)}
                            >
                              Download WebP
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-md border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-slate-300"
                            onClick={() => handleRemoveJob(job.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <ImageEditorModal
        open={editorState.open}
        sourceBlob={editorJob?.file ?? null}
        onClose={closeEditor}
        onSave={handleEditorSave}
        title="Image Editor"
      />
    </div>
  );
}

export default ToolsPage;
