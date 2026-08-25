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
     6. Zoom & pan (view transform — never touches artwork data)
     7. Tool + color UI wiring
     8. Clear canvas
     9. PNG export
     10. Init
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

// Zoom bounds, expressed as raw CSS scale factors (1 = actual size),
// matching the 0.5x–5x range professional design tools typically use.
// Kept as plain constants rather than buried in the zoom functions so
// the limits are easy to find and tune in one place.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;

// Multiplicative step per interaction, rather than a fixed +/- amount.
// Multiplying keeps each step feeling proportional at any zoom level —
// a flat "+0.2" would feel huge at 0.5x and barely noticeable at 4x.
const WHEEL_ZOOM_FACTOR = 1.1; // ~10% per wheel tick
const BUTTON_ZOOM_FACTOR = 1.2; // 20% per button click

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

  // --- view transform (pan/zoom) state ---
  // These three describe the exact CSS transform currently applied to
  // #pixel-canvas: `translate(translateX, translateY) scale(scale)`.
  // Together they're the single source of truth for the view — DOM
  // reads (getBoundingClientRect, etc.) are never trusted as state,
  // only ever used to compute NEW values for these three numbers.
  scale: 1, // 1 = actual size. Clamped to [ZOOM_MIN, ZOOM_MAX].
  translateX: 0, // px offset of the canvas's origin from its normal position
  translateY: 0,

  // --- pan MODE vs. pan ACTION ---
  // "Mode" = pan is available on left-click right now (either the Pan
  // tool is toggled on, or Space is currently held). "Panning" = the
  // mouse button is actually down and a drag is in progress. These are
  // deliberately separate flags: you can be in pan mode without
  // currently dragging (cursor: grab), and you're only ever "panning"
  // (cursor: grabbing) while the left button is held in that mode.
  isPanToolActive: false,
  isSpacebarHeld: false,
  isPanning: false,
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
const canvasViewport = document.getElementById("canvas-viewport");
const panToolBtn = document.getElementById("pan-tool-btn");
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomLevelDisplay = document.getElementById("zoom-level");

// Not part of `state` on purpose: this only exists transiently while a
// pan drag is actually happening, and is always null the rest of the
// time. It's "working memory" for a single gesture, not app state.
let panDragOrigin = null;

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

  // A new grid always starts at actual size, un-panned — an old
  // transform from a different-sized grid wouldn't line up on this one.
  resetTransform();
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
 * - If pan mode is active (Pan tool on, or Space held), left-click is
 *   reserved for panning instead of drawing: this handler returns
 *   immediately WITHOUT calling preventDefault(), so the mousedown
 *   keeps bubbling up from this pixel to #canvas-viewport, where
 *   handleViewportMouseDown (section 6) picks it up and starts a pan.
 */
function handlePixelMouseDown(event) {
  if (event.button !== 0) return;
  if (isPanModeActive()) return; // let the pan handler on the viewport take it
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
   6. ZOOM & PAN
   ---------------------------------------------------------------------
   How the view is tracked:
     Three numbers in `state` — scale, translateX, translateY — fully
     describe the view. Nothing about the grid itself (column/row
     count, individual cell size, the data model) is touched by either
     zooming or panning; this section only ever changes those three
     numbers and the transform on #pixel-canvas.

   How the view is applied to the DOM:
     applyTransform() (below) is the ONLY place that writes the
     transform:

       canvasEl.style.transform =
         `translate(${translateX}px, ${translateY}px) scale(${scale})`

     Order matters: CSS applies translate() first, then scale(), which
     is what lets translateX/translateY be expressed in plain screen
     pixels (not scaled ones) — exactly what mouse coordinates are
     measured in. Everything below is math to solve for the right
     translateX/translateY given a scale change or a drag.

   Why cursor-anchored zoom needs `transform-origin: 0 0`:
     With the origin at the element's own top-left (set in style.css),
     a point P that lives at position P in the canvas's own *unscaled*
     coordinate space (i.e. "P pixels from the canvas's top-left at
     100% zoom") ends up on screen at:
         screenPos = translate + P * scale
     That's the entire model. Every formula below is just this
     equation solved for a different unknown.
   --------------------------------------------------------------------- */

/**
 * Writes state.scale/translateX/translateY to the DOM and refreshes
 * the dependent UI (percentage readout, disabled zoom buttons). This
 * is the single choke point for rendering the view — every other
 * function in this section computes new numbers and then calls this,
 * the same pattern setPixelColor() uses for pixel colors.
 */
function applyTransform() {
  canvasEl.style.transform =
    `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;

  zoomLevelDisplay.textContent = `${Math.round(state.scale * 100)}%`;
  zoomInBtn.disabled = state.scale >= ZOOM_MAX;
  zoomOutBtn.disabled = state.scale <= ZOOM_MIN;
}

/** Zoom and pan both reset to a clean, un-transformed view. */
function resetTransform() {
  state.scale = 1;
  state.translateX = 0;
  state.translateY = 0;
  applyTransform();
}

/**
 * The zoom-at-a-point math. `anchorX`/`anchorY` are the point to keep
 * fixed on screen, measured in pixels from #canvas-viewport's
 * top-left (the same frame getBoundingClientRect() gives us) — for
 * wheel-zoom that's the mouse position; for the +/- buttons it's the
 * viewport's own center.
 *
 * Derivation, using the model above (screenPos = translate + P*scale):
 *
 *   1. Figure out what canvas-space point P is CURRENTLY under the
 *      anchor, using the OLD scale/translate — solve the model for P:
 *        anchor = translate_old + P * scale_old
 *        =>  P = (anchor - translate_old) / scale_old
 *
 *   2. We want that exact same P to still be under the anchor after
 *      the scale changes. Plug P back into the model, this time
 *      solving for the NEW translate at the NEW scale:
 *        anchor = translate_new + P * scale_new
 *        =>  translate_new = anchor - P * scale_new
 *
 *   That's it — two substitutions of the same equation. Step 1 finds
 *   "where on the art was the cursor pointing", step 2 finds "what
 *   offset puts that same spot back under the cursor at the new size".
 */
function zoomAtPoint(nextScale, anchorX, anchorY) {
  const clampedScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));

  // Step 1: anchor point in canvas-local (unscaled) coordinates.
  const canvasPointX = (anchorX - state.translateX) / state.scale;
  const canvasPointY = (anchorY - state.translateY) / state.scale;

  // Step 2: solve for the translate that keeps that point under the
  // anchor at the new scale.
  state.translateX = anchorX - canvasPointX * clampedScale;
  state.translateY = anchorY - canvasPointY * clampedScale;
  state.scale = clampedScale;

  applyTransform();
}

/**
 * Mouse-wheel zoom. Attached to #canvas-viewport (not the canvas or
 * the window) so it only fires "while the cursor is hovering over the
 * canvas/wrapper", per spec — scrolling anywhere else on the page
 * behaves normally.
 */
function handleWheelZoom(event) {
  // Wheel listeners default to passive (for scroll performance), which
  // means preventDefault() is silently ignored unless we opt out via
  // { passive: false } on the listener itself (see initZoomControls).
  // Without this, the page would scroll AND the canvas would zoom.
  event.preventDefault();

  const viewportRect = canvasViewport.getBoundingClientRect();
  const mouseX = event.clientX - viewportRect.left;
  const mouseY = event.clientY - viewportRect.top;

  // deltaY < 0 means the wheel scrolled "up/away from the user", which
  // by convention means zoom IN. Multiplying (rather than adding) the
  // current scale keeps each tick feeling like the same proportional
  // step no matter how zoomed in/out you currently are.
  const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
  zoomAtPoint(state.scale * factor, mouseX, mouseY);
}

/**
 * The +/- toolbar buttons reuse the exact same zoomAtPoint() math as
 * the wheel — there's no separate "zoom from center" code path. A
 * button click has no cursor position to anchor to, so it anchors to
 * the viewport's own center instead, which is the intuitive fallback.
 */
function zoomInViaButton() {
  const rect = canvasViewport.getBoundingClientRect();
  zoomAtPoint(state.scale * BUTTON_ZOOM_FACTOR, rect.width / 2, rect.height / 2);
}

function zoomOutViaButton() {
  const rect = canvasViewport.getBoundingClientRect();
  zoomAtPoint(state.scale / BUTTON_ZOOM_FACTOR, rect.width / 2, rect.height / 2);
}

/**
 * True whenever a left-click-drag should pan instead of draw: either
 * the Pan tool is toggled on, or Space is currently being held down.
 * This is the single function both the drawing handlers (section 5)
 * and the pan handlers below consult, so the two code paths can never
 * disagree about whose turn it is to handle left-click.
 */
function isPanModeActive() {
  return state.isPanToolActive || state.isSpacebarHeld;
}

/**
 * Starts a pan gesture. Only reached when isPanModeActive() is true —
 * handlePixelMouseDown (section 5) already bailed out and let this
 * mousedown bubble up from the clicked .pixel to #canvas-viewport.
 */
function handleViewportMouseDown(event) {
  if (event.button !== 0) return;
  if (!isPanModeActive()) return;
  event.preventDefault();

  state.isPanning = true;
  // Snapshot where the drag started AND what translate was at that
  // moment, so every subsequent mousemove can compute an absolute new
  // translate from the total drag distance so far — simpler and more
  // robust than accumulating small per-event deltas.
  panDragOrigin = {
    mouseX: event.clientX,
    mouseY: event.clientY,
    translateX: state.translateX,
    translateY: state.translateY,
  };
  canvasViewport.classList.add("is-panning");
}

/**
 * Drags the canvas by exactly the distance the mouse has moved since
 * the pan started. Attached to `window` (see initPanControls) so, like
 * the drawing stroke in section 5, the pan keeps tracking correctly
 * even if the cursor briefly leaves #canvas-viewport mid-drag.
 */
function handleWindowMouseMoveForPan(event) {
  if (!state.isPanning || !panDragOrigin) return;

  const deltaX = event.clientX - panDragOrigin.mouseX;
  const deltaY = event.clientY - panDragOrigin.mouseY;

  state.translateX = panDragOrigin.translateX + deltaX;
  state.translateY = panDragOrigin.translateY + deltaY;
  applyTransform();
}

/** Ends the current pan gesture, wherever the mouse happens to be. */
function handleWindowMouseUpForPan() {
  state.isPanning = false;
  panDragOrigin = null;
  canvasViewport.classList.remove("is-panning");
}

/**
 * Keeps the CSS "grab" cursor class in sync with isPanModeActive().
 * Called any time something that feeds into that function changes:
 * the Pan tool being toggled, or Space being pressed/released.
 */
function updatePanCursor() {
  canvasViewport.classList.toggle("is-pan-mode", isPanModeActive());
}

/**
 * Space-to-pan, the same convention used by Photoshop/Figma: holding
 * Space temporarily enables pan mode no matter which drawing tool is
 * selected, without changing state.currentTool at all — release Space
 * and you're right back to whatever you were doing.
 */
function handleKeyDown(event) {
  if (event.code !== "Space") return;
  // event.repeat is true for the auto-repeated keydown events a held
  // key fires; without this guard we'd re-run this on every repeat.
  if (event.repeat) return;
  // Don't hijack Space when it's being used for its normal job, e.g.
  // activating a focused button via the keyboard, or (if one's ever
  // added) typing into a text field.
  if (["INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;

  event.preventDefault(); // stop the page itself from scrolling
  state.isSpacebarHeld = true;
  updatePanCursor();
}

function handleKeyUp(event) {
  if (event.code !== "Space") return;
  state.isSpacebarHeld = false;
  updatePanCursor();
}

/** Toggles the dedicated Pan tool button on/off. */
function togglePanTool() {
  state.isPanToolActive = !state.isPanToolActive;
  panToolBtn.classList.toggle("is-active", state.isPanToolActive);
  panToolBtn.setAttribute("aria-pressed", String(state.isPanToolActive));
  updatePanCursor();
}

function initZoomControls() {
  zoomInBtn.addEventListener("click", zoomInViaButton);
  zoomOutBtn.addEventListener("click", zoomOutViaButton);

  // { passive: false } is required so event.preventDefault() inside
  // handleWheelZoom actually stops the page from scrolling too.
  canvasViewport.addEventListener("wheel", handleWheelZoom, { passive: false });
}

function initPanControls() {
  panToolBtn.addEventListener("click", togglePanTool);

  canvasViewport.addEventListener("mousedown", handleViewportMouseDown);
  window.addEventListener("mousemove", handleWindowMouseMoveForPan);
  window.addEventListener("mouseup", handleWindowMouseUpForPan);
  window.addEventListener("blur", handleWindowMouseUpForPan);

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
}

/* ---------------------------------------------------------------------
   7. TOOL + COLOR UI WIRING
   --------------------------------------------------------------------- */

function setTool(tool) {
  state.currentTool = tool;

  // Picking a drawing tool always exits pan mode — mirrors the mental
  // model of Photoshop/Figma, where tools are mutually exclusive even
  // though Pan isn't tracked in state.currentTool itself (see section 6).
  state.isPanToolActive = false;
  panToolBtn.classList.remove("is-active");
  panToolBtn.setAttribute("aria-pressed", "false");
  updatePanCursor();

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
   8. CLEAR CANVAS
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
   9. PNG EXPORT
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
   10. INIT
   --------------------------------------------------------------------- */

function init() {
  initPalette();
  initToolButtons();
  initColorPicker();
  initSizeControls();
  initClearButton();
  initExportButton();
  initZoomControls();
  initPanControls();

  generateGrid(state.cols, state.rows);
  setTool("pen");
  setColor(state.currentColor);
}

document.addEventListener("DOMContentLoaded", init);