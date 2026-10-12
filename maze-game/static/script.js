/**
 * script.js — Maze Game Frontend Logic
 *
 * Responsibilities:
 *  - Communicating with the Flask backend (new_game, move, hint, solution).
 *  - Rendering the 11×11 maze grid from wall data returned by the backend.
 *  - Handling mouse-click and mouse-drag cell selection.
 *  - Enforcing movement rules locally (adjacency + no wall) as a fast pre-check
 *    before sending to the backend for authoritative validation.
 *  - Managing hint state, victory display, feedback cooldown, and button states.
 */

"use strict";

/* ────────────────────────────────────────────────────────────────────────────
   DOM References
   ────────────────────────────────────────────────────────────────────────── */
const homeScreen    = document.getElementById("home-screen");
const gameScreen    = document.getElementById("game-screen");
const playBtn       = document.getElementById("play-btn");
const newGameBtn    = document.getElementById("new-game-btn");
const hintBtn       = document.getElementById("hint-btn");
const showPathBtn   = document.getElementById("show-path-btn");
const mazeGrid      = document.getElementById("maze-grid");
const mazeLoading   = document.getElementById("maze-loading");
const feedbackEl    = document.getElementById("feedback");
const victoryBanner = document.getElementById("victory-banner");
const stepsCount    = document.getElementById("steps-count");
const hintsCount    = document.getElementById("hints-count");

/* ────────────────────────────────────────────────────────────────────────────
   Game State (client-side shadow)
   ────────────────────────────────────────────────────────────────────────── */
let gameState = {
  walls: new Set(),       // Set of "r1,c1|r2,c2" encoded wall strings
  start: null,            // [row, col]
  exit: null,             // [row, col]
  path: [],               // [[row, col], …] — player's current path
  hintCells: [],          // [[row, col], …] — currently active hint cells
  hintsUsed: 0,
  completed: false,
  showPath: false,
  rows: 11,               // updated from backend on each new game
  cols: 11,
};

/* ────────────────────────────────────────────────────────────────────────────
   Feedback Cooldown
   Spec: 4-second cooldown. First invalid move shows feedback immediately.
   Further invalid moves within 4 s are silently dropped (no restart).
   ────────────────────────────────────────────────────────────────────────── */
let feedbackCooldownActive = false;
let feedbackHideTimer = null;
let feedbackCooldownTimer = null;

/**
 * Display the "Invalid selection!" feedback banner with a 4-second cooldown.
 * The cooldown is started on first display and does NOT restart on repeat calls.
 */
function showInvalidFeedback() {
  if (feedbackCooldownActive) return;   // cooldown active → silent drop

  // Show the message
  feedbackEl.textContent = "Invalid selection!";
  feedbackEl.classList.add("visible");

  // Hide the visible text after 2.5 s (but cooldown stays for 4 s total)
  clearTimeout(feedbackHideTimer);
  feedbackHideTimer = setTimeout(() => {
    feedbackEl.classList.remove("visible");
  }, 2500);

  // Start the 4-second cooldown
  feedbackCooldownActive = true;
  clearTimeout(feedbackCooldownTimer);
  feedbackCooldownTimer = setTimeout(() => {
    feedbackCooldownActive = false;
  }, 4000);
}

/** Clear the feedback banner and reset the cooldown state. */
function clearFeedback() {
  clearTimeout(feedbackHideTimer);
  clearTimeout(feedbackCooldownTimer);
  feedbackCooldownActive = false;
  feedbackEl.textContent = "";
  feedbackEl.classList.remove("visible");
}

/* ────────────────────────────────────────────────────────────────────────────
   Wall Encoding Helpers
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Encode a wall edge as a canonical sorted string key so that
 * wall_between(A,B) === wall_between(B,A).
 */
function wallKey(r1, c1, r2, c2) {
  if (r1 > r2 || (r1 === r2 && c1 > c2)) {
    [r1, c1, r2, c2] = [r2, c2, r1, c1];
  }
  return `${r1},${c1}|${r2},${c2}`;
}

/** Build a Set of wall-key strings from the backend's walls array. */
function buildWallSet(wallsArray) {
  const s = new Set();
  for (const pair of wallsArray) {
    const [[r1, c1], [r2, c2]] = pair;
    s.add(wallKey(r1, c1, r2, c2));
  }
  return s;
}

/** Return true if there is a wall between (r1,c1) and (r2,c2). */
function hasWall(r1, c1, r2, c2) {
  return gameState.walls.has(wallKey(r1, c1, r2, c2));
}

/** Return true if there is an open passage between (r1,c1) and (r2,c2). */
function hasPassage(r1, c1, r2, c2) {
  return !hasWall(r1, c1, r2, c2);
}

/* ────────────────────────────────────────────────────────────────────────────
   Maze Grid Rendering
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the CSS grid and populate it with cell <div> elements.
 * Each cell gets:
 *  - data attributes: data-row, data-col
 *  - CSS border classes for walls (wall-top, wall-right, wall-bottom, wall-left)
 *  - Event listeners for mouse interaction
 */
function renderMaze() {
  const ROWS = gameState.rows;
  const COLS = gameState.cols;
  mazeGrid.innerHTML = "";
  mazeGrid.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = r;
      cell.dataset.col = c;
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `Cell row ${r + 1} column ${c + 1}`);

      // Wall borders: a border is added on each side where a wall exists.
      // Outer grid edges are handled by the maze-grid border, but we still
      // add wall classes for cells on the outer edge so the border renders
      // correctly if inner DFS chose not to carve that edge.
      if (r === 0 || hasWall(r, c, r - 1, c))          cell.classList.add("wall-top");
      if (c === COLS - 1 || hasWall(r, c, r, c + 1))   cell.classList.add("wall-right");
      if (r === ROWS - 1 || hasWall(r, c, r + 1, c))   cell.classList.add("wall-bottom");
      if (c === 0 || hasWall(r, c, r, c - 1))           cell.classList.add("wall-left");

      // Interaction listeners (click + drag)
      cell.addEventListener("mousedown",  onCellMouseDown);
      cell.addEventListener("mouseenter", onCellMouseEnter);
      cell.addEventListener("touchstart", onCellTouchStart, { passive: false });
      cell.addEventListener("touchmove",  onCellTouchMove,  { passive: false });

      mazeGrid.appendChild(cell);
    }
  }

  // Apply initial cell highlighting (start cell)
  updateCellHighlights();
}

/**
 * Re-apply CSS classes to every cell based on the current game state.
 * This is the single source of truth for visual state.
 */
function updateCellHighlights() {
  const { path, hintCells, start, exit: exitCell, showPath } = gameState;

  const pathSet    = new Set(path.map(([r, c]) => `${r},${c}`));
  const hintSet    = new Set(hintCells.map(([r, c]) => `${r},${c}`));
  const startKey   = start  ? `${start[0]},${start[1]}`   : null;
  const exitKey    = exitCell ? `${exitCell[0]},${exitCell[1]}` : null;
  const currentKey = path.length ? `${path[path.length - 1][0]},${path[path.length - 1][1]}` : null;

  const cells = mazeGrid.querySelectorAll(".cell");
  cells.forEach(cell => {
    const r = +cell.dataset.row;
    const c = +cell.dataset.col;
    const key = `${r},${c}`;

    // Remove all state classes (preserve wall- classes)
    cell.classList.remove(
      "path", "current-pos", "start-cell", "exit-cell",
      "hint-cell", "solution-cell"
    );

    // Clear text content (will re-add for start/exit)
    cell.textContent = "";

    if (showPath) {
      // Show Path mode: entire solution in green
      if (cell.dataset.solutionCell === "true") {
        cell.classList.add("solution-cell");
      }
    }

    // Player path (yellow) — overrides solution green
    if (pathSet.has(key)) {
      cell.classList.add("path");
    }

    // Hint cell (green) — only if not in path
    if (hintSet.has(key) && !pathSet.has(key)) {
      cell.classList.add("hint-cell");
    }

    // Current position marker (brightest yellow)
    if (key === currentKey) {
      cell.classList.add("current-pos");
      cell.classList.remove("hint-cell"); // ensure priority
    }

    // Start marker
    if (key === startKey) {
      cell.classList.add("start-cell");
      cell.textContent = "S";
    }

    // Exit marker
    if (key === exitKey) {
      cell.classList.add("exit-cell");
      cell.textContent = "E";
    }
  });

  // Update stats
  stepsCount.textContent = path.length;
  hintsCount.textContent = `${gameState.hintsUsed} / 3`;
}

/* ────────────────────────────────────────────────────────────────────────────
   Move Validation (client-side fast-path)
   The backend always validates too; this is just for immediate UX feedback.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Determine if moving from the last cell in the path to (toRow, toCol) is
 * a valid forward move (adjacency + open passage + not already visited).
 * @returns {"forward"|"undo"|"invalid"}
 */
function classifyMove(toRow, toCol) {
  const path = gameState.path;
  if (!path.length) return "invalid";

  const [curRow, curCol] = path[path.length - 1];

  // Undo: player clicked the cell just before the current one
  if (path.length >= 2) {
    const [prevRow, prevCol] = path[path.length - 2];
    if (toRow === prevRow && toCol === prevCol) return "undo";
  }

  // Must be exactly 1 step away
  const dist = Math.abs(toRow - curRow) + Math.abs(toCol - curCol);
  if (dist !== 1) return "invalid";

  // Must have a passage
  if (!hasPassage(curRow, curCol, toRow, toCol)) return "invalid";

  // Must not already be visited
  const visited = new Set(path.map(([r, c]) => `${r},${c}`));
  if (visited.has(`${toRow},${toCol}`)) return "invalid";

  return "forward";
}

/* ────────────────────────────────────────────────────────────────────────────
   API Calls
   ────────────────────────────────────────────────────────────────────────── */

async function apiPost(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}

/* ────────────────────────────────────────────────────────────────────────────
   New Game
   ────────────────────────────────────────────────────────────────────────── */

async function startNewGame() {
  // Reset UI
  clearFeedback();
  victoryBanner.classList.add("hidden");
  mazeGrid.innerHTML = "";
  mazeLoading.classList.remove("hidden");
  setControlsDisabled(true);

  try {
    const data = await apiPost("/new_game");

    // Populate client game state
    gameState.walls      = buildWallSet(data.walls);
    gameState.start      = data.start;
    gameState.exit       = data.exit;
    gameState.path       = [data.start];
    gameState.hintCells  = [];
    gameState.hintsUsed  = 0;
    gameState.completed  = false;
    gameState.showPath   = false;
    gameState.rows       = data.rows || ROWS;
    gameState.cols       = data.cols || COLS;

    mazeLoading.classList.add("hidden");
    renderMaze();
    setControlsDisabled(false);
    updateHintButton();

  } catch (err) {
    mazeLoading.classList.add("hidden");
    feedbackEl.textContent = "Failed to load maze. Please refresh.";
    feedbackEl.classList.add("visible");
    console.error("new_game error:", err);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Cell Interaction — move to a cell
   ────────────────────────────────────────────────────────────────────────── */

/** Track drag state */
let isDragging = false;
let lastDragCell = null;   // "r,c" string of last cell entered during drag

document.addEventListener("mouseup",  () => { isDragging = false; lastDragCell = null; });
document.addEventListener("mouseleave", () => { isDragging = false; lastDragCell = null; });

function onCellMouseDown(e) {
  if (e.button !== 0) return;   // left button only
  isDragging = true;
  lastDragCell = null;
  handleCellSelect(+this.dataset.row, +this.dataset.col);
}

function onCellMouseEnter() {
  if (!isDragging) return;
  const key = `${this.dataset.row},${this.dataset.col}`;
  if (key === lastDragCell) return;   // already processed this cell in this drag
  lastDragCell = key;
  handleCellSelect(+this.dataset.row, +this.dataset.col);
}

/* ── Touch support (drag through cells on mobile) ──────────────────────── */
function onCellTouchStart(e) {
  e.preventDefault();
  isDragging = true;
  lastDragCell = null;
  handleCellSelect(+this.dataset.row, +this.dataset.col);
}

function onCellTouchMove(e) {
  e.preventDefault();
  if (!isDragging) return;
  const touch = e.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  if (el && el.classList.contains("cell")) {
    const key = `${el.dataset.row},${el.dataset.col}`;
    if (key === lastDragCell) return;
    lastDragCell = key;
    handleCellSelect(+el.dataset.row, +el.dataset.col);
  }
}

/**
 * Core handler: attempt to select a cell.
 * Fast client-side validation first, then confirm with backend.
 */
async function handleCellSelect(toRow, toCol) {
  if (gameState.completed || gameState.showPath) return;
  if (!gameState.path.length) return;

  const moveType = classifyMove(toRow, toCol);

  if (moveType === "invalid") {
    // Trigger bump animation on the current cell
    const [curRow, curCol] = gameState.path[gameState.path.length - 1];
    const curCell = getCellEl(curRow, curCol);
    if (curCell) {
      curCell.classList.remove("bump");
      // Force reflow to re-trigger animation
      void curCell.offsetWidth;
      curCell.classList.add("bump");
      curCell.addEventListener("animationend", () => curCell.classList.remove("bump"), { once: true });
    }
    showInvalidFeedback();
    return;
  }

  // Optimistic local update for responsiveness
  if (moveType === "undo") {
    gameState.path.pop();
  } else {
    gameState.path.push([toRow, toCol]);
  }
  updateCellHighlights();

  // Confirm with backend
  try {
    const data = await apiPost("/move", { to_row: toRow, to_col: toCol });
    if (!data.ok) {
      // Backend rejected it — roll back
      if (moveType === "undo") {
        gameState.path.push([toRow, toCol]);
      } else {
        gameState.path.pop();
      }
      updateCellHighlights();
      showInvalidFeedback();
    } else {
      // Sync path from backend (authoritative)
      gameState.path = data.path;
      updateCellHighlights();

      // Check victory
      if (data.completed && !gameState.completed) {
        gameState.completed = true;
        onVictory();
      }
    }
  } catch (err) {
    console.error("move error:", err);
    // On network error, roll back optimistic update
    if (moveType === "undo") {
      gameState.path.push([toRow, toCol]);
    } else {
      gameState.path.pop();
    }
    updateCellHighlights();
  }
}

function getCellEl(r, c) {
  return mazeGrid.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
}

/* ────────────────────────────────────────────────────────────────────────────
   Hint
   ────────────────────────────────────────────────────────────────────────── */

async function requestHint() {
  if (gameState.hintsUsed >= 3) return;
  if (gameState.completed || gameState.showPath) return;

  hintBtn.disabled = true;   // prevent double-click while fetching

  try {
    const data = await apiPost("/hint");
    if (data.ok) {
      gameState.hintCells.push(data.hint_cell);
      gameState.hintsUsed = data.hints_used;
      updateCellHighlights();
      updateHintButton();
    } else {
      // No eligible hint cells
      feedbackEl.textContent = data.reason || "No hints available.";
      feedbackEl.classList.add("visible");
      clearTimeout(feedbackHideTimer);
      feedbackHideTimer = setTimeout(() => feedbackEl.classList.remove("visible"), 2500);
    }
  } catch (err) {
    console.error("hint error:", err);
  } finally {
    // Re-enable only if hints remain and game is active
    updateHintButton();
  }
}

function updateHintButton() {
  const used = gameState.hintsUsed;
  const active = !gameState.completed && !gameState.showPath;
  if (used >= 3 || !active) {
    hintBtn.textContent = used >= 3 ? "💡 No hints left" : "💡 Hint " + (used + 1);
    hintBtn.disabled = used >= 3 || !active;
  } else {
    hintBtn.textContent = `💡 Hint ${used + 1}`;
    hintBtn.disabled = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Show Path
   ────────────────────────────────────────────────────────────────────────── */

async function requestShowPath() {
  if (gameState.completed || gameState.showPath) return;

  showPathBtn.disabled = true;
  hintBtn.disabled     = true;

  try {
    const data = await apiGet("/solution");
    if (data.ok) {
      gameState.showPath = true;

      // Mark solution cells on the DOM (data attribute for CSS class lookup)
      for (const [r, c] of data.solution) {
        const el = getCellEl(r, c);
        if (el) el.dataset.solutionCell = "true";
      }

      updateCellHighlights();
      // Disable movement
      setControlsDisabled(true);
      newGameBtn.disabled = false;   // always allow new game
      // Show Path must not trigger victory
    } else {
      showPathBtn.disabled = false;
    }
  } catch (err) {
    console.error("solution error:", err);
    showPathBtn.disabled = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Victory
   ────────────────────────────────────────────────────────────────────────── */

function onVictory() {
  victoryBanner.classList.remove("hidden");
  setControlsDisabled(true);
  newGameBtn.disabled = false;   // allow starting a new game after win
}

/* ────────────────────────────────────────────────────────────────────────────
   Button Enable / Disable
   ────────────────────────────────────────────────────────────────────────── */

function setControlsDisabled(disabled) {
  hintBtn.disabled     = disabled;
  showPathBtn.disabled = disabled;
  if (!disabled) {
    updateHintButton();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Screen Transitions
   ────────────────────────────────────────────────────────────────────────── */

function showGameScreen() {
  homeScreen.classList.remove("active");
  gameScreen.classList.add("active");
}

/* ────────────────────────────────────────────────────────────────────────────
   Event Bindings
   ────────────────────────────────────────────────────────────────────────── */

playBtn.addEventListener("click", () => {
  showGameScreen();
  startNewGame();
});

newGameBtn.addEventListener("click", startNewGame);

hintBtn.addEventListener("click", requestHint);

showPathBtn.addEventListener("click", requestShowPath);

// Prevent the default drag-select behaviour on the grid
mazeGrid.addEventListener("dragstart", e => e.preventDefault());
