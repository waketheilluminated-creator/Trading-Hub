import type { ReactNode } from "react";
/** TH-FEAT-17c: icon-only replay controls (TradingView-style glyphs, 18×18, currentColor). */

type IconProps = { "data-icon": string; children: ReactNode };
function Icon({ children, ...rest }: IconProps) {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>{children}</svg>;
}
/** Bar Replay: rewind arrow circling back around a play triangle. */
export const ReplayIcon = () => <Icon data-icon="replay"><path d="M3.2 9a5.8 5.8 0 1 0 1.7-4.1" /><path d="M3 2.6v3h3" /><path d="M7.6 6.6v4.8l3.8-2.4z" fill="currentColor" stroke="none" /></Icon>;
export const StepBackIcon = () => <Icon data-icon="step-back"><path d="M5 4.5v9" /><path d="M13 4.5v9L6.8 9z" fill="currentColor" stroke="none" /></Icon>;
export const StepForwardIcon = () => <Icon data-icon="step-forward"><path d="M13 4.5v9" /><path d="M5 4.5v9L11.2 9z" fill="currentColor" stroke="none" /></Icon>;
export const PlayIcon = () => <Icon data-icon="play"><path d="M6 4.2v9.6L13.4 9z" fill="currentColor" stroke="none" /></Icon>;
export const PauseIcon = () => <Icon data-icon="pause"><path d="M6.5 4.5v9M11.5 4.5v9" strokeWidth="2.2" /></Icon>;
/** Back to live: fast-forward to the right edge. */
export const ExitReplayIcon = () => <Icon data-icon="replay-exit"><path d="M3.5 5v8l4.8-4zM8.8 5v8l4.8-4z" fill="currentColor" stroke="none" /><path d="M15 4.5v9" /></Icon>;
