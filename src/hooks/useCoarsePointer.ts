"use client";

import { useEffect, useState } from "react";

/**
 * True when the primary input cannot hover — a touchscreen.
 *
 * Keyed on `(hover: none)` rather than on viewport width because the thing that
 * actually differs is the *interaction*, not the screen size. A hover-only
 * overlay has somewhere to go on a laptop of any width (move the mouse) and
 * nowhere to go on a tablet of any width, and a width breakpoint gets that
 * exactly backwards for a large tablet and a small laptop alike.
 *
 * Starts false and corrects after mount, so server and first client render
 * agree; a touch device shows the mouse layout for one frame rather than
 * throwing a hydration mismatch.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(hover: none)");
    const apply = () => setCoarse(mq.matches);
    apply();
    // A 2-in-1 can switch between tablet and laptop mode mid-session.
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return coarse;
}
