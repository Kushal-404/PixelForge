"use strict";

/* =====================================================================
   PIXELFORGE — script.js
   Vanilla JS pixel art editor. No frameworks, no build step.

   File map:
     1. Config & state
     2. DOM references
     3. Grid generation
     4. Painting primitives (setPixelColor, flood fill)
     5. Drawing event handlers (mousedown / mouseenter / mouseup)
     6. Tool + color UI wiring
     7. Clear canvas
     8. PNG export
     9. Init
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. CONFIG & STATE
   --------------------------------------------------------------------- */

// The default quick-select palette. Each entry is [hex, accessible name].
const PALETTE_COLORS = [
  ["#ff5470", "Coral"],
  ["#ff9f1c", "Amber"],
  ["#ffe66d", "Sunflower"],
  ["#6bcb77", "Leaf"],
  ["#22e0c9", "Teal"],
  ["#4d9de0", "Sky"],
  ["#7c5cff", "Violet"],
  ["#c86bfa", "Orchid"],
  ["#2b2d42", "Ink"],
  ["#ffffff", "Snow"],
];

// Hard ceiling on grid dimensions. Keeps DOM node count (and thus
// listener count) sane — 64 * 64 = 4096 cells, which is still instant
// to build and paint on.
const MAX_GRID_SIZE = 64;
const MIN_GRID_SIZE = 1;

// `state` is the single source of truth for the artwork. The DOM is a
// *rendering* of state, never the other way around — every mutation
// goes through setPixelColor() so the two never drift apart.
const state = {
  cols: 16,
  rows: 16,
  // 2D array, data[row][col] = CSS color string, or null if empty/erased.
  data: [],
  // 2D array of the actual <div> elements, same shape as `data`, so we
  // can update a cell's on-screen color in O(1) without querySelector.
  cells: [],
  currentColor: "#7c5cff",
  currentTool: "pen", // "pen" | "eraser" | "fill"
  isDrawing: false,
};

/* ---------------------------------------------------------------------
   2. DOM REFERENCES
   --------------------------------------------------------------------- */

const canvasEl = document.getElementById("pixel-canvas");
const widthInput = document.getElementById("width-input");
const heightInput = document.getElementById("height-input");
const generateBtn = document.getElementById("generate-btn");
const presetButtons = document.querySelectorAll("[data-preset]");
const toolButtons = document.querySelectorAll(".tool-btn[data-tool]");
const clearBtn = document.getElementById("clear-btn");
const colorPicker = document.getElementById("color-picker");
const currentColorSwatch = document.getElementById("current-color-swatch");
const paletteEl = document.getElementById("palette");
const exportBtn = document.getElementById("export-btn");
const exportSizeHint = document.getElementById("export-size-hint");

/* ---------------------------------------------------------------------
   3. GRID GENERATION
   --------------------------------------------------------------------- */

/**
 * Builds a brand new cols x rows grid: resets state.data/state.cells,
 * clears and repopulates the DOM, and wires up drawing listeners on
 * every cell.
 *
 * This is the "grid generation loop" — a plain nested for-loop that
 * walks row by row, column by column. For each (x, y) coordinate it:
 *   a) pushes a `null` placeholder into the data model (empty pixel)
 *   b) creates a <div class="pixel"> for that coordinate
 *   c) stores the coordinate as data-x / data-y attributes on the div,
 *      so event handlers can read "which pixel was this?" directly
 *      off the event target without any extra lookup
 *   d) attaches the mousedown / mouseenter listeners that drive drawing
 *   e) appends the div to the grid container
 */
function generateGrid(cols, rows) {
  // Clamp to sane bounds so a stray huge number can't wreck performance.
  cols = Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, cols));
  rows = Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, rows));

  // If there's existing artwork, confirm before nuking it.
  if (hasAnyPaintedPixel() && !window.confirm("Generate a new grid? This clears your current artwork.")) {
    // Reset the number inputs back to the current grid so the UI
    // doesn't show a size that was never actually applied.
    widthInput.value = state.cols;
    heightInput.value = state.rows;
    return;
  }

  state.cols = cols;
  state.rows = rows;
  state.data = [];
  state.cells = [];

  // Tell the CSS grid how many tracks to lay out, and give the
  // container the right aspect ratio so square art doesn't stretch.
  canvasEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  canvasEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  canvasEl.style.aspectRatio = `${cols} / ${rows}`;

  // Wipe any previously rendered cells.
  canvasEl.innerHTML = "";

  // --- the grid generation loop -------------------------------------
  for (let y = 0; y < rows; y++) {
    const dataRow = [];
    const cellRow = [];

    for (let x = 0; x < cols; x++) {
      dataRow.push(null); // (a) empty pixel in the data model

      const cell = document.createElement("div"); // (b)
      cell.className = "pixel";
      cell.dataset.x = x; // (c)
      cell.dataset.y = y;

      // (d) Drawing is driven entirely by these two listeners:
      cell.addEventListener("mousedown", handlePixelMouseDown);
      cell.addEventListener("mouseenter", handlePixelMouseEnter);

      canvasEl.appendChild(cell); // (e)
      cellRow.push(cell);
    }

    state.data.push(dataRow);
    state.cells.push(cellRow);
  }

  updateExportSizeHint();
}

function hasAnyPaintedPixel() {
  return state.data.some((row) => row.some((c) => c !== null));
}

/* ---------------------------------------------------------------------
   4. PAINTING PRIMITIVES
   --------------------------------------------------------------------- */

/**
 * The single choke point for changing a pixel's color. Updates the
 * data model AND the on-screen cell together, so they can never
 * disagree with each other.
 */
function setPixelColor(x, y, color) {
  state.data[y][x] = color;
  state.cells[y][x].style.backgroundColor = color || "transparent";
}

/**
 * Applies the currently selected tool to one pixel. Called from both
 * the mousedown (first click) and mouseenter (drag-over) handlers, so
 * "click" and "click-and-drag" always produce identical results.
 */
function paintWithCurrentTool(x, y) {
  if (state.currentTool === "pen") {
    setPixelColor(x, y, state.currentColor);
  } else if (state.currentTool === "eraser") {
    setPixelColor(x, y, null);
  }
  // "fill" is intentionally NOT handled here — it's a one-shot flood
  // fill triggered only on mousedown, never repeated while dragging.
}

/**
 * Flood fill (a.k.a. "paint bucket"). Iterative breadth-first search
 * using an explicit array-as-stack, so it can't blow the call stack
 * even on the largest (64x64) grid.
 *
 * Algorithm:
 *   1. Read the color at the clicked pixel — that's the "target" color
 *      we're replacing.
 *   2. If the target already equals the fill color, there's nothing
 *      to do (avoids an infinite loop and wasted work).
 *   3. Push the starting coordinate onto a stack.
 *   4. Pop a coordinate, and if it's still target-colored, recolor it
 *      and push its 4-directional neighbors (up/down/left/right).
 *   5. Repeat until the stack is empty — every same-colored region
 *      connected to the start point has now been repainted.
 */
function floodFill(startX, startY) {
  const targetColor = state.data[startY][startX];
  const fillColor = state.currentColor;

  if (targetColor === fillColor) return;

  const stack = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();

    // Bounds check + "is this still the color we're replacing?" check.
    if (x < 0 || x >= state.cols || y < 0 || y >= state.rows) continue;
    if (state.data[y][x] !== targetColor) continue;

    setPixelColor(x, y, fillColor);

    stack.push([x + 1, y]);
    stack.push([x - 1, y]);
    stack.push([x, y + 1]);
    stack.push([x, y - 1]);
  }
}

/* ---------------------------------------------------------------------
   5. DRAWING EVENT HANDLERS (the click-and-drag mechanic)
   --------------------------------------------------------------------- */

/**
 * Fires when the mouse button goes down on a pixel. This is the start
 * of every stroke, including a plain single click.
 *
 * - preventDefault() stops the browser from starting a native "text
 *   selection drag", which is what causes the jerky/laggy feeling if
 *   you skip it — the browser fights your drawing for control of the
 *   mouse gesture.
 * - We ignore anything other than the primary (left) mouse button, so
 *   right-click / middle-click don't accidentally paint.
 * - The Fill tool is a single, immediate action — it does NOT set
 *   isDrawing, so dragging afterwards won't re-trigger it.
 */
function handlePixelMouseDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();

  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);

  if (state.currentTool === "fill") {
    floodFill(x, y);
    return;
  }

  state.isDrawing = true;
  paintWithCurrentTool(x, y);
}

/**
 * Fires every time the cursor enters a NEW pixel while the mouse
 * button is held down. `mouseenter` (rather than `mouseover`) is used
 * deliberately: it does not bubble and fires only once per element on
 * entry, so each pixel gets painted exactly once per pass of the
 * cursor over it — no duplicate work, no flicker.
 *
 * Because painting only happens while `state.isDrawing` is true, just
 * moving the mouse across the grid (button up) does nothing — you
 * have to be mid-stroke for drag-painting to kick in. This is what
 * makes continuous drag-drawing feel smooth: there's no debounce, no
 * timers, just "is the button down right now?"
 */
function handlePixelMouseEnter(event) {
  if (!state.isDrawing) return;
  if (state.currentTool === "fill") return; // fill never drags

  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);
  paintWithCurrentTool(x, y);
}

/**
 * Ends the current stroke. Attached to `window` — not the canvas —
 * and mirrored on `blur`, so releasing the mouse button outside the
 * grid (or even outside the browser window) still correctly stops
 * drawing. Without this, a stroke that ends off-canvas would leave
 * `isDrawing` stuck `true`, and the very next mouseenter anywhere
 * would start painting unexpectedly.
 */
function handleMouseUp() {
  state.isDrawing = false;
}

window.addEventListener("mouseup", handleMouseUp);
window.addEventListener("blur", handleMouseUp);

/* ---------------------------------------------------------------------
   6. TOOL + COLOR UI WIRING
   --------------------------------------------------------------------- */

function setTool(tool) {
  state.currentTool = tool;

  toolButtons.forEach((btn) => {
    const isActive = btn.dataset.tool === tool;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function setColor(hexColor) {
  state.currentColor = hexColor;
  currentColorSwatch.style.backgroundColor = hexColor;
  colorPicker.value = hexColor;

  // Highlight the matching palette swatch, if any, and clear the rest.
  paletteEl.querySelectorAll(".palette-swatch").forEach((swatch) => {
    swatch.classList.toggle(
      "is-selected",
      swatch.dataset.color.toLowerCase() === hexColor.toLowerCase()
    );
  });
}

function initPalette() {
  paletteEl.innerHTML = "";

  PALETTE_COLORS.forEach(([hex, name]) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "palette-swatch";
    swatch.style.backgroundColor = hex;
    swatch.dataset.color = hex;
    swatch.setAttribute("aria-label", name);
    swatch.title = name;

    swatch.addEventListener("click", () => setColor(hex));

    paletteEl.appendChild(swatch);
  });
}

function initToolButtons() {
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });
}

function initColorPicker() {
  colorPicker.addEventListener("input", (event) => setColor(event.target.value));
}

function initSizeControls() {
  generateBtn.addEventListener("click", () => {
    const cols = parseInt(widthInput.value, 10) || state.cols;
    const rows = parseInt(heightInput.value, 10) || state.rows;
    generateGrid(cols, rows);
  });

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const size = Number(btn.dataset.preset);
      widthInput.value = size;
      heightInput.value = size;
      generateGrid(size, size);
    });
  });
}

/* ---------------------------------------------------------------------
   7. CLEAR CANVAS
   --------------------------------------------------------------------- */

function clearCanvas() {
  if (!hasAnyPaintedPixel()) return;
  if (!window.confirm("Clear the entire canvas?")) return;

  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      setPixelColor(x, y, null);
    }
  }
}

function initClearButton() {
  clearBtn.addEventListener("click", clearCanvas);
}

/* ---------------------------------------------------------------------
   8. PNG EXPORT
   --------------------------------------------------------------------- */

/**
 * Each art pixel is drawn as a solid block of `scale` x `scale` real
 * pixels onto an off-screen <canvas>, then that canvas is serialized
 * to a PNG blob and downloaded. Scale is chosen so the exported image
 * lands in a comfortable ~512-1024px range regardless of grid size —
 * a tiny 8x8 grid still exports as a crisp, viewable image instead of
 * an 8x8-pixel speck.
 */
function getExportScale(cols, rows) {
  const targetLongEdge = 1024;
  const longEdge = Math.max(cols, rows);
  return Math.max(4, Math.floor(targetLongEdge / longEdge));
}

function updateExportSizeHint() {
  const scale = getExportScale(state.cols, state.rows);
  exportSizeHint.textContent = `Export size: ${state.cols * scale} × ${state.rows * scale} px`;
}

function exportPNG() {
  const scale = getExportScale(state.cols, state.rows);

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = state.cols * scale;
  exportCanvas.height = state.rows * scale;

  const ctx = exportCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      const color = state.data[y][x];
      if (!color) continue; // leave transparent pixels untouched
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  exportCanvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pixel-art-${state.cols}x${state.rows}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, "image/png");
}

function initExportButton() {
  exportBtn.addEventListener("click", exportPNG);
}

/* ---------------------------------------------------------------------
   9. INIT
   --------------------------------------------------------------------- */

function init() {
  initPalette();
  initToolButtons();
  initColorPicker();
  initSizeControls();
  initClearButton();
  initExportButton();

  generateGrid(state.cols, state.rows);
  setTool("pen");
  setColor(state.currentColor);
}

document.addEventListener("DOMContentLoaded", init);
