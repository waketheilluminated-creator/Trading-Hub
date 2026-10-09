export type ThemeName = "dark" | "light";

export const THEME_STORAGE_KEY = "th-theme";
export const THEME_LIGHT_CLASS = "theme-light";
const THEME_EVENT = "th-theme-change";

type ThemeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** Only the exact string "light" selects the light theme; anything else (missing, forged, garbage) is dark. */
export function parseTheme(value: unknown): ThemeName {
  return value === "light" ? "light" : "dark";
}

export function readStoredTheme(storage: ThemeStorage | null | undefined): ThemeName {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function writeStoredTheme(storage: ThemeStorage | null | undefined, theme: ThemeName): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, parseTheme(theme));
  } catch {
    // Private mode / quota: theme still applies for this page view.
  }
}

/**
 * Inline <head> script that applies the saved theme class before first paint so
 * a light-theme reload never flashes the dark UI. Static string, no user input.
 */
export const THEME_BOOTSTRAP_SCRIPT =
  `(function(){try{if(window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})===${JSON.stringify("light")}){document.documentElement.classList.add(${JSON.stringify(THEME_LIGHT_CLASS)});document.documentElement.style.colorScheme="light";}}catch(e){}})();`;

export function currentDocumentTheme(): ThemeName {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains(THEME_LIGHT_CLASS) ? "light" : "dark";
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  const light = parseTheme(theme) === "light";
  document.documentElement.classList.toggle(THEME_LIGHT_CLASS, light);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  writeStoredTheme(window.localStorage, light ? "light" : "dark");
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeTheme(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    const next = parseTheme(event.newValue);
    document.documentElement.classList.toggle(THEME_LIGHT_CLASS, next === "light");
    onChange();
  };
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
