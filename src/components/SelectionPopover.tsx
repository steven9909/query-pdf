/** Small floating "Explain" button shown above the current text selection. */
import type { ViewerSelection } from "../types";

interface Props {
  selection: ViewerSelection;
  onExplain: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** Renders the button centred above the selection's bounding box, flipping below near the top edge. */
export default function SelectionPopover({ selection, onExplain }: Props) {
  const { x, y, width, height } = selection.anchor;
  const top = y > 48 ? y - 40 : y + height + 8;
  const left = Math.max(8, Math.min(window.innerWidth - 140, x + width / 2 - 60));

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onExplain}
      style={{ top, left }}
      className="fixed z-40 flex items-center gap-2 rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      <span>Explain</span>
      <kbd className="rounded bg-white/15 px-1 text-[10px] dark:bg-black/10">{isMac ? "⌘E" : "Ctrl+E"}</kbd>
    </button>
  );
}
