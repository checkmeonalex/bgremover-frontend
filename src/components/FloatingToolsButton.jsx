function FloatingToolsButton({ label = 'Tools', onClick, tooltip }) {
  return (
    <button
      type="button"
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/30 transition hover:translate-y-0.5 hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200"
      onClick={onClick}
      aria-label={label}
      title={tooltip ?? label}
    >
      <span aria-hidden="true">🛠️</span>
      {label}
    </button>
  );
}

export default FloatingToolsButton;
