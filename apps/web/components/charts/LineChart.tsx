"use client";
import { useEffect, useMemo, useRef } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { fmtValue } from "@/lib/format";
import { chrome } from "./palette";
import { ema, nearest } from "./smooth";

export type Line = { label: string; color: string; step: number[]; value: number[] };

type Prepared = { lines: (Line & { smooth: number[] })[]; data: uPlot.AlignedData };

/** Smooth each line on its own points, then join all lines on the union of steps. */
function prepare(lines: Line[], smoothing: number, log: boolean, U: typeof uPlot): Prepared {
  const fix = (v: number) => (log && v <= 0 ? null : v); // log scale: drop non-positive
  const withSmooth = lines.map((l) => ({ ...l, smooth: ema(l.value, smoothing) }));
  const tables = withSmooth.map(
    (l) => [l.step, l.value.map(fix), l.smooth.map(fix)] as unknown as uPlot.AlignedData,
  );
  const data = tables.length === 1 ? tables[0] : U.join(tables);
  return { lines: withSmooth, data };
}

/**
 * uPlot line chart over `step`. Each line draws raw (faint, only when smoothing > 0) and
 * smoothed. Drag to zoom x, double-click to reset; hover shows each line's nearest point.
 */
export function LineChart({ lines, smoothing, log, dark, height = 200 }: {
  lines: Line[];
  smoothing: number;
  log: boolean;
  dark: boolean;
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const U = useRef<typeof uPlot | null>(null);
  const prepared = useRef<Prepared | null>(null);
  const zoomed = useRef(false);
  const latest = useRef({ lines, smoothing });
  latest.current = { lines, smoothing };
  const showRaw = smoothing > 0;
  // Chart structure changes (recreate): line set/colors, scale type, theme. Raw visibility
  // toggles via setSeries below.
  const shape = useMemo(() => lines.map((l) => l.label + l.color).join("|"), [lines]);

  useEffect(() => {
    let dead = false;
    let ro: ResizeObserver | null = null;
    zoomed.current = false; // new plot starts unzoomed
    (async () => {
      U.current ??= (await import("uplot")).default;
      if (dead || !wrap.current) return;
      const P = U.current;
      const c = chrome(dark);
      prepared.current = prepare(latest.current.lines, latest.current.smoothing, log, P);
      const series: uPlot.Series[] = [{}];
      const raw = latest.current.smoothing > 0;
      for (const l of latest.current.lines) {
        series.push(
          { label: l.label, stroke: l.color + "40", width: 1, points: { show: false }, spanGaps: true, show: raw },
          { label: l.label, stroke: l.color, width: 2, points: { show: false }, spanGaps: true },
        );
      }
      const axis = (values?: uPlot.Axis["values"]): uPlot.Axis => ({
        stroke: c.text,
        font: "11px ui-sans-serif, system-ui, sans-serif",
        grid: { stroke: c.grid, width: 1 },
        ticks: { stroke: c.axis, width: 1, size: 4 },
        values,
      });
      const opts: uPlot.Options = {
        width: wrap.current.clientWidth,
        height,
        legend: { show: false },
        cursor: { drag: { x: true, y: false }, points: { size: 6 }, focus: { prox: -1 } },
        scales: {
          x: { time: false },
          // Log: pad the data range instead of snapping to whole decades (flat-looking curves).
          y: log ? { distr: 3, log: 10, range: (_u, min, max) => [min / 1.15, max * 1.15] } : {},
        },
        axes: [axis(), { ...axis((_u, vals) => vals.map((v) => fmtValue(v))), size: 52 }],
        series,
        hooks: {
          setSelect: [(u) => u.select.width > 0 && (zoomed.current = true)],
          setCursor: [(u) => renderTip(u)],
        },
      };
      plot.current = new P(opts, prepared.current.data, wrap.current);
      plot.current.over.addEventListener("dblclick", () => (zoomed.current = false));
      ro = new ResizeObserver(() => {
        const w = wrap.current?.clientWidth;
        if (w && plot.current && w !== plot.current.width) plot.current.setSize({ width: w, height });
      });
      ro.observe(wrap.current);
    })();
    return () => {
      dead = true;
      ro?.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // Data/smoothing updates go through setData below; only structural changes recreate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, log, dark, height]);

  // Raw (faint) series are the odd indices 1, 3, 5, ...; shown only while smoothing.
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    for (let i = 1; i < u.series.length; i += 2) if (u.series[i].show !== showRaw) u.setSeries(i, { show: showRaw });
  }, [showRaw]);

  useEffect(() => {
    if (!plot.current || !U.current) return;
    prepared.current = prepare(lines, smoothing, log, U.current);
    plot.current.setData(prepared.current.data, !zoomed.current);
  }, [lines, smoothing, log]);

  function renderTip(u: uPlot) {
    const el = tip.current;
    const p = prepared.current;
    const idx = u.cursor.idx;
    if (!el || !p || idx == null || u.cursor.left == null || u.cursor.left < 0) {
      if (el) el.style.display = "none";
      return;
    }
    const x = u.data[0][idx];
    const rows = p.lines
      .map((l) => {
        // Lines that do not cover this step (e.g. a shorter run) are left out.
        if (!l.step.length || x < l.step[0] || x > l.step[l.step.length - 1]) return "";
        const i = nearest(l.step, x);
        const raw = latest.current.smoothing > 0 ? ` <span class="text-zinc-400">${fmtValue(l.value[i])}</span>` : "";
        const name = p.lines.length > 1 ? `<span class="truncate text-zinc-500 dark:text-zinc-400">${esc(l.label)}</span>` : "";
        return `<div class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full" style="background:${l.color}"></span>${name}<span class="ml-auto pl-2 font-medium tabular-nums">${fmtValue(l.smooth[i])}</span>${raw}</div>`;
      })
      .join("");
    el.innerHTML = `<div class="mb-0.5 text-zinc-500 dark:text-zinc-400">step ${x}</div>${rows}`;
    el.style.display = "block";
    // Keep inside the plot: flip to the left of the cursor in the right half.
    const left = u.cursor.left + u.bbox.left / devicePixelRatio;
    const flip = u.cursor.left > u.over.clientWidth / 2;
    el.style.left = flip ? "" : `${left + 12}px`;
    el.style.right = flip ? `${u.over.clientWidth + u.bbox.left / devicePixelRatio - left + 12}px` : "";
  }

  return (
    <div className="relative" onMouseLeave={() => tip.current && (tip.current.style.display = "none")}>
      <div ref={wrap} style={{ height }} />
      <div
        ref={tip}
        className="pointer-events-none absolute top-1 z-10 hidden max-w-64 rounded-md border border-zinc-200 bg-white/95 px-2 py-1.5 text-xs text-zinc-900 shadow-md dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-100"
      />
    </div>
  );
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
