type EscapeEvent = Pick<KeyboardEvent, "preventDefault" | "stopImmediatePropagation">;

type WorkspaceEscapeOptions = {
  searchOpen: boolean;
  sourcesOpen?: boolean;
  event: EscapeEvent;
  closeSources?(): void;
  closeSearch(): void;
  cancelDrawing(): void;
};

export function handleWorkspaceEscape({
  searchOpen,
  sourcesOpen = false,
  event,
  closeSources,
  closeSearch,
  cancelDrawing,
}: WorkspaceEscapeOptions): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  if (searchOpen && sourcesOpen) {
    (closeSources ?? closeSearch)();
    return;
  }
  if (searchOpen) {
    closeSearch();
    return;
  }
  cancelDrawing();
}
