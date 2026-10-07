// Categorical slots (fixed order, never cycled) and chart chrome, light + dark steps of the
// same hues. Validated set: dataviz reference palette (adjacent-pair CVD dE >= 8 both modes).
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Max runs overlaid in one chart: one slot each, no generated 9th hue. */
export const MAX_SERIES = LIGHT.length;

export const seriesColor = (slot: number, dark: boolean) => (dark ? DARK : LIGHT)[slot % LIGHT.length];

export const chrome = (dark: boolean) =>
  dark
    ? { text: "#c3c2b7", grid: "rgba(255,255,255,0.07)", axis: "rgba(255,255,255,0.18)" }
    : { text: "#52514e", grid: "rgba(0,0,0,0.06)", axis: "rgba(0,0,0,0.15)" };
