"use strict";

/* =====================================================================
   PIXELFORGE — script.js
   Vanilla JS pixel art editor. No frameworks, no build step.
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. CONFIG & STATE
   --------------------------------------------------------------------- */

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

const MAX_GRID_SIZE = 64;
const MIN_GRID_SIZE = 1;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;

const WHEEL_ZOOM_FACTOR = 1.1; 
const BUTTON_ZOOM_FACTOR = 1.2; 

const state = {
  cols: 16,
  rows: 16,
  data: [],
  cells: [],
  currentColor: "#7c5cff",
  currentTool: "pen", 
  isDrawing: false,

  scale: 1, 
  translateX: 0, 
  translateY: 0,

  isPanToolActive: false,
  isSpacebarHeld: false,
  isPanning: false,
};

// --- History State for Undo & Redo ---
const history = {
  past: [],
  future: [], // NEW: Stores undone states so we can redo them
  maxSteps: 30 
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
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn"); // NEW

let panDragOrigin = null;

/* ---------------------------------------------------------------------
   3. GRID GENERATION
   --------------------------------------------------------------------- */

function generateGrid(cols, rows) {
  cols = Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, cols));
  rows = Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, rows));

  if (hasAnyPaintedPixel() && !window.confirm("Generate a new grid? This clears your current artwork.")) {
    widthInput.value = state.cols;
    heightInput.value = state.rows;
    return;
  }

  state.cols = cols;
  state.rows = rows;
  state.data = [];
  state.cells = [];
  history.past = []; 
  history.future = []; // Clear redo stack on new grid

  canvasEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  canvasEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  canvasEl.style.aspectRatio = `${cols} / ${rows}`;

  canvasEl.innerHTML = "";

  for (let y = 0; y < rows; y++) {
    const dataRow = [];
    const cellRow = [];

    for (let x = 0; x < cols; x++) {
      dataRow.push(null); 

      const cell = document.createElement("div"); 
      cell.className = "pixel";
      cell.dataset.x = x; 
      cell.dataset.y = y;

      cell.addEventListener("mousedown", handlePixelMouseDown);
      cell.addEventListener("mouseenter", handlePixelMouseEnter);

      canvasEl.appendChild(cell); 
      cellRow.push(cell);
    }

    state.data.push(dataRow);
    state.cells.push(cellRow);
  }

  updateExportSizeHint();
  resetTransform();
}

function hasAnyPaintedPixel() {
  return state.data.some((row) => row.some((c) => c !== null));
}

/* ---------------------------------------------------------------------
   4. PAINTING PRIMITIVES & HISTORY
   --------------------------------------------------------------------- */

function saveSnapshot() {
  const snapshot = state.data.map(row => [...row]);
  history.past.push(snapshot);
  
  if (history.past.length > history.maxSteps) {
    history.past.shift(); 
  }

  // NEW: Any new drawing action invalidates the redo history
  history.future = [];
}

function undo() {
  if (history.past.length === 0) return;

  // NEW: Save current state to 'future' before going back
  const currentState = state.data.map(row => [...row]);
  history.future.push(currentState);

  const previousState = history.past.pop();

  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      setPixelColor(x, y, previousState[y][x]);
    }
  }
}

// --- NEW: Redo Function ---
function redo() {
  if (history.future.length === 0) return;

  // Save current state back to 'past' before moving forward
  const currentState = state.data.map(row => [...row]);
  history.past.push(currentState);

  const nextState = history.future.pop();

  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      setPixelColor(x, y, nextState[y][x]);
    }
  }
}

function setPixelColor(x, y, color) {
  state.data[y][x] = color;
  state.cells[y][x].style.backgroundColor = color || "transparent";
}

function paintWithCurrentTool(x, y) {
  if (state.currentTool === "pen") {
    setPixelColor(x, y, state.currentColor);
  } else if (state.currentTool === "eraser") {
    setPixelColor(x, y, null);
  }
}

function floodFill(startX, startY) {
  const targetColor = state.data[startY][startX];
  const fillColor = state.currentColor;

  if (targetColor === fillColor) return;

  const stack = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();

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
   5. DRAWING EVENT HANDLERS
   --------------------------------------------------------------------- */

function handlePixelMouseDown(event) {
  if (event.button !== 0) return;
  if (isPanModeActive()) return; 
  event.preventDefault();

  saveSnapshot();

  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);

  if (state.currentTool === "fill") {
    floodFill(x, y);
    return;
  }

  state.isDrawing = true;
  paintWithCurrentTool(x, y);
}

function handlePixelMouseEnter(event) {
  if (!state.isDrawing) return;
  if (state.currentTool === "fill") return; 

  const x = Number(event.currentTarget.dataset.x);
  const y = Number(event.currentTarget.dataset.y);
  paintWithCurrentTool(x, y);
}

function handleMouseUp() {
  state.isDrawing = false;
}

window.addEventListener("mouseup", handleMouseUp);
window.addEventListener("blur", handleMouseUp);

/* ---------------------------------------------------------------------
   6. ZOOM & PAN
   --------------------------------------------------------------------- */

function applyTransform() {
  canvasEl.style.transform =
    `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`;

  zoomLevelDisplay.textContent = `${Math.round(state.scale * 100)}%`;
  zoomInBtn.disabled = state.scale >= ZOOM_MAX;
  zoomOutBtn.disabled = state.scale <= ZOOM_MIN;
}

function resetTransform() {
  state.scale = 1;
  state.translateX = 0;
  state.translateY = 0;
  applyTransform();
}

function zoomAtPoint(nextScale, anchorX, anchorY) {
  const clampedScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));
  const canvasPointX = (anchorX - state.translateX) / state.scale;
  const canvasPointY = (anchorY - state.translateY) / state.scale;

  state.translateX = anchorX - canvasPointX * clampedScale;
  state.translateY = anchorY - canvasPointY * clampedScale;
  state.scale = clampedScale;

  applyTransform();
}

function handleWheelZoom(event) {
  event.preventDefault();
  const viewportRect = canvasViewport.getBoundingClientRect();
  const mouseX = event.clientX - viewportRect.left;
  const mouseY = event.clientY - viewportRect.top;
  const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
  zoomAtPoint(state.scale * factor, mouseX, mouseY);
}

function zoomInViaButton() {
  const rect = canvasViewport.getBoundingClientRect();
  zoomAtPoint(state.scale * BUTTON_ZOOM_FACTOR, rect.width / 2, rect.height / 2);
}

function zoomOutViaButton() {
  const rect = canvasViewport.getBoundingClientRect();
  zoomAtPoint(state.scale / BUTTON_ZOOM_FACTOR, rect.width / 2, rect.height / 2);
}

function isPanModeActive() {
  return state.isPanToolActive || state.isSpacebarHeld;
}

function handleViewportMouseDown(event) {
  if (event.button !== 0) return;
  if (!isPanModeActive()) return;
  event.preventDefault();

  state.isPanning = true;
  panDragOrigin = {
    mouseX: event.clientX,
    mouseY: event.clientY,
    translateX: state.translateX,
    translateY: state.translateY,
  };
  canvasViewport.classList.add("is-panning");
}

function handleWindowMouseMoveForPan(event) {
  if (!state.isPanning || !panDragOrigin) return;
  const deltaX = event.clientX - panDragOrigin.mouseX;
  const deltaY = event.clientY - panDragOrigin.mouseY;
  state.translateX = panDragOrigin.translateX + deltaX;
  state.translateY = panDragOrigin.translateY + deltaY;
  applyTransform();
}

function handleWindowMouseUpForPan() {
  state.isPanning = false;
  panDragOrigin = null;
  canvasViewport.classList.remove("is-panning");
}

function updatePanCursor() {
  canvasViewport.classList.toggle("is-pan-mode", isPanModeActive());
}

function handleKeyDown(event) {
  // NEW: Ctrl/Cmd + Keyboard Shortcuts for Undo/Redo
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase();
    
    // Redo: Ctrl+Y OR Ctrl+Shift+Z
    if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
      return;
    }
    
    // Undo: Ctrl+Z (without shift)
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
  }

  if (event.code !== "Space") return;
  if (event.repeat) return;
  if (["INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;

  event.preventDefault(); 
  state.isSpacebarHeld = true;
  updatePanCursor();
}

function handleKeyUp(event) {
  if (event.code !== "Space") return;
  state.isSpacebarHeld = false;
  updatePanCursor();
}

function togglePanTool() {
  state.isPanToolActive = !state.isPanToolActive;
  panToolBtn.classList.toggle("is-active", state.isPanToolActive);
  panToolBtn.setAttribute("aria-pressed", String(state.isPanToolActive));
  updatePanCursor();
}

function initZoomControls() {
  zoomInBtn.addEventListener("click", zoomInViaButton);
  zoomOutBtn.addEventListener("click", zoomOutViaButton);
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

function initHistoryControls() {
  if (undoBtn) undoBtn.addEventListener("click", undo);
  if (redoBtn) redoBtn.addEventListener("click", redo); // NEW
}

/* ---------------------------------------------------------------------
   8. CLEAR CANVAS
   --------------------------------------------------------------------- */

function clearCanvas() {
  if (!hasAnyPaintedPixel()) return;
  if (!window.confirm("Clear the entire canvas?")) return;

  saveSnapshot();

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
      if (!color) continue; 
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
  initHistoryControls(); 

  generateGrid(state.cols, state.rows);
  setTool("pen");
  setColor(state.currentColor);
}

document.addEventListener("DOMContentLoaded", init);