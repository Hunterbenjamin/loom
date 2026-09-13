import { useLayoutEffect, useRef } from "react";

export type RowAction = {
  label: string;
  run: () => void;
  disabled?: boolean;
  reason?: string;
};

/** A window-local menu; row actions never borrow the terminal-close shortcut. */
export function RowMenu({
  x,
  y,
  actions,
  dismiss,
  trigger,
}: {
  x: number;
  y: number;
  actions: RowAction[];
  dismiss: () => void;
  trigger: HTMLElement;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
    element.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", dismiss);
    };
  }, [x, y, dismiss]);
  return (
    <div
      ref={menu}
      className="wb-row-menu"
      role="menu"
      aria-label="Row actions"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
                  buttons.length;
          buttons[next]?.focus();
        } else if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          dismiss();
          trigger.focus();
        }
        event.stopPropagation();
      }}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          title={action.reason}
          onClick={() => {
            dismiss();
            trigger.focus();
            action.run();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
