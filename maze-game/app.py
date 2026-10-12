"""
app.py — Flask web server for the Maze Game.

Endpoints:
  GET  /                  → Serve the home page (index.html).
  POST /new_game          → Generate a new maze, run A*, return initial state.
  POST /move              → Validate and apply a player movement.
  POST /hint              → Return a hint cell from the A* solution.
  GET  /solution          → Return the full A* solution path.
  GET  /state             → Return the current game state for the session.

Session / State:
  Each browser session has its own isolated game state stored in Flask's
  signed-cookie session (server-side dict keyed by session['game_id']).
  game_states dict maps game_id → game state dict.

  Because this is a local, single-player app, a simple UUID-keyed in-memory
  dict is sufficient.  The walls set is serialised to a list for JSON storage.
"""

import uuid
import random
from flask import Flask, request, jsonify, session, render_template

from maze import (
    generate_maze,
    astar,
    is_valid_move,
    walls_to_list,
    list_to_walls,
    ROWS,
    COLS,
)

# ──────────────────────────────────────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)
# Secret key for signing the session cookie (random per process start is fine
# for a local single-player game; set a fixed key to survive server restarts)
app.secret_key = "maze-game-secret-key-change-in-production"

# In-memory game states: { game_id (str) : game_state (dict) }
game_states: dict[str, dict] = {}


# ──────────────────────────────────────────────────────────────────────────────
# Helper — build a fresh game state dict
# ──────────────────────────────────────────────────────────────────────────────

def build_game_state(maze_data: dict) -> dict:
    """
    Create a complete game-state dictionary from a freshly generated maze.

    Fields:
      walls_list   : serialised wall set (list of lists of lists)
      start        : [row, col]
      exit         : [row, col]
      solution     : [[row, col], …] — A* path, computed once
      path         : [[row, col], …] — player's current selected path
      visited_set  : [[row, col], …] — cells visited (for fast lookup)
      hints_used   : int (0–3)
      hint_cells   : [[row, col], …] — cells currently highlighted as hints
      completed    : bool — player reached the exit
      show_path    : bool — full solution revealed by button
    """
    walls = maze_data["walls"]
    start = maze_data["start"]
    exit_cell = maze_data["exit"]

    # Run A* once and store the result
    solution = astar(walls, start, exit_cell)

    return {
        "walls_list": walls_to_list(walls),
        "start": list(start),
        "exit": list(exit_cell),
        "solution": [list(cell) for cell in solution],
        "path": [list(start)],          # player starts at the start cell
        "visited_set": [list(start)],   # same as path at start
        "hints_used": 0,
        "hint_cells": [],               # [[row,col], ...]
        "completed": False,
        "show_path": False,
    }


def get_game_state() -> dict | None:
    """Retrieve the current game state for this session, or None."""
    game_id = session.get("game_id")
    if not game_id:
        return None
    return game_states.get(game_id)


def save_game_state(state: dict) -> None:
    """Persist the (mutated) game state back into the store."""
    game_id = session.get("game_id")
    if game_id:
        game_states[game_id] = state


# ──────────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Serve the main HTML page."""
    return render_template("index.html")


@app.route("/new_game", methods=["POST"])
def new_game():
    """
    Generate a new maze, compute the A* solution, and initialise game state.

    Response JSON:
      start   : [row, col]
      exit    : [row, col]
      walls   : [[row, col], [row, col]] pairs — list of blocked edges
      rows    : int
      cols    : int
    """
    # Create a fresh session game_id (each New Game gets its own id so that
    # state from an old game cannot leak into the new one)
    game_id = str(uuid.uuid4())
    session["game_id"] = game_id

    maze_data = generate_maze()
    state = build_game_state(maze_data)
    game_states[game_id] = state

    return jsonify({
        "start": state["start"],
        "exit": state["exit"],
        "walls": state["walls_list"],
        "rows": ROWS,
        "cols": COLS,
    })


@app.route("/move", methods=["POST"])
def move():
    """
    Validate and apply a player move.

    Request JSON:
      to_row : int
      to_col : int

    Response JSON (success):
      ok        : true
      path      : [[row, col], …]
      completed : bool

    Response JSON (failure):
      ok      : false
      reason  : str
    """
    state = get_game_state()
    if state is None:
        return jsonify({"ok": False, "reason": "No active game."}), 400

    if state["completed"] or state["show_path"]:
        return jsonify({"ok": False, "reason": "Game is over."}), 400

    data = request.get_json(silent=True) or {}
    try:
        to_row = int(data["to_row"])
        to_col = int(data["to_col"])
    except (KeyError, ValueError, TypeError):
        return jsonify({"ok": False, "reason": "Invalid request body."}), 400

    # Reconstruct the walls set from the serialised form
    walls = list_to_walls(state["walls_list"])

    current = tuple(state["path"][-1])
    destination = (to_row, to_col)

    # ── Undo move: player clicked the cell immediately before the current one ─
    if len(state["path"]) >= 2 and list(destination) == state["path"][-2]:
        # Remove the last cell from path and visited_set
        state["path"].pop()
        # Remove from visited_set (keep it in sync)
        if list(destination) in state["visited_set"]:
            state["visited_set"] = [
                c for c in state["visited_set"] if c != list(current)
            ]
        save_game_state(state)
        return jsonify({"ok": True, "path": state["path"], "completed": False, "undo": True})

    # ── Normal forward move ────────────────────────────────────────────────────

    # 1. Basic geometry + wall check
    if not is_valid_move(walls, current, destination):
        return jsonify({"ok": False, "reason": "Invalid move: wall or not adjacent."})

    # 2. Prevent revisiting cells (except undo, handled above)
    if list(destination) in state["visited_set"]:
        return jsonify({"ok": False, "reason": "Cell already visited."})

    # Apply the move
    state["path"].append(list(destination))
    state["visited_set"].append(list(destination))

    # If the destination was a hinted cell, it's now "visited" so it'll render
    # as yellow; no need to remove it from hint_cells explicitly — the frontend
    # uses path membership to decide colour.

    # Check for victory
    completed = (list(destination) == state["exit"])
    state["completed"] = completed

    save_game_state(state)
    return jsonify({
        "ok": True,
        "path": state["path"],
        "completed": completed,
        "undo": False,
    })


@app.route("/hint", methods=["POST"])
def hint():
    """
    Return one hint cell from the A* solution that the player has not yet
    visited and that has not been previously hinted.

    Maximum 3 hints per game.

    Response JSON (success):
      ok         : true
      hint_cell  : [row, col]
      hints_used : int

    Response JSON (failure):
      ok     : false
      reason : str
    """
    state = get_game_state()
    if state is None:
        return jsonify({"ok": False, "reason": "No active game."}), 400

    if state["completed"] or state["show_path"]:
        return jsonify({"ok": False, "reason": "Game is over."}), 400

    MAX_HINTS = 3
    if state["hints_used"] >= MAX_HINTS:
        return jsonify({"ok": False, "reason": "No hints left."})

    solution = state["solution"]             # list of [row, col]
    visited = state["visited_set"]           # list of [row, col]
    previous_hints = state["hint_cells"]     # list of [row, col]
    start = state["start"]
    exit_cell = state["exit"]

    # Eligible cells: on the solution path, not visited, not start/exit,
    # and not previously hinted
    eligible = [
        cell for cell in solution
        if cell not in visited
        and cell != start
        and cell != exit_cell
        and cell not in previous_hints
    ]

    if not eligible:
        return jsonify({"ok": False, "reason": "No eligible hint cells remain."})

    hint_cell = random.choice(eligible)
    state["hint_cells"].append(hint_cell)
    state["hints_used"] += 1

    save_game_state(state)
    return jsonify({
        "ok": True,
        "hint_cell": hint_cell,
        "hints_used": state["hints_used"],
    })


@app.route("/solution", methods=["GET"])
def solution():
    """
    Return the full A* solution path and mark the game as solution-revealed.

    Response JSON:
      ok       : bool
      solution : [[row, col], …]
    """
    state = get_game_state()
    if state is None:
        return jsonify({"ok": False, "reason": "No active game."}), 400

    # Mark as revealed (not a player victory)
    state["show_path"] = True
    save_game_state(state)

    return jsonify({"ok": True, "solution": state["solution"]})


@app.route("/state", methods=["GET"])
def game_state_route():
    """
    Return the full current game state for the session.
    Useful for debugging or reconnecting after a page refresh.
    """
    state = get_game_state()
    if state is None:
        return jsonify({"ok": False, "reason": "No active game."}), 404

    # Return a safe subset (solution omitted until requested)
    return jsonify({
        "ok": True,
        "start": state["start"],
        "exit": state["exit"],
        "walls": state["walls_list"],
        "path": state["path"],
        "hints_used": state["hints_used"],
        "hint_cells": state["hint_cells"],
        "completed": state["completed"],
        "show_path": state["show_path"],
        "rows": ROWS,
        "cols": COLS,
    })


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(debug=True, port=5000)
