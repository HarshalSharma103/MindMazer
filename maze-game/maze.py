"""
maze.py — Maze generation (DFS + recursive backtracking) and A* pathfinding.

Concepts:
  - The maze is an 11×11 grid of cells.
  - Between any two adjacent cells there is either a WALL (blocked) or a PASSAGE (open).
  - Walls are represented by a set of frozensets: walls = { frozenset({(r1,c1),(r2,c2)}), ... }
    If the frozenset is present → wall exists (blocked).
    If absent                  → open passage.
  - DFS with recursive backtracking carves passages by removing walls between cells.
"""

from random import randrange
import random
import heapq

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

ROWS = randrange(13,18)
COLS = randrange(13,18)

# Cardinal directions as (row-delta, col-delta)
DIRECTIONS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


# ──────────────────────────────────────────────────────────────────────────────
# Maze Generation — Depth-First Search with Recursive Backtracking
# ──────────────────────────────────────────────────────────────────────────────

def generate_maze():
    """
    Generate a random maze using DFS with recursive backtracking.

    Algorithm outline:
      1. Start with every cell walled off from every neighbour (full grid of walls).
      2. Pick a random starting cell on the left edge (column 0).
      3. Run iterative DFS:
           - Push the current cell onto the stack and mark it visited.
           - Shuffle the four cardinal neighbours.
           - For each unvisited neighbour within bounds:
               • Remove the wall between current and neighbour.
               • Push neighbour and continue DFS from there.
           - If no unvisited neighbours exist, backtrack (pop stack).
      4. Pick a random exit cell on the right edge (column 10).
      5. The DFS guarantees every cell is reachable from the start, so the
         start→exit path always exists.

    Returns
    -------
    dict with keys:
        walls  : set of frozensets, each encoding one blocked edge
        start  : (row, col) on the left edge
        exit   : (row, col) on the right edge
    """

    # Build full wall set: every adjacent pair starts blocked
    walls = set()
    for r in range(ROWS):
        for c in range(COLS):
            for dr, dc in DIRECTIONS:
                nr, nc = r + dr, c + dc
                if 0 <= nr < ROWS and 0 <= nc < COLS:
                    walls.add(frozenset({(r, c), (nr, nc)}))

    visited = [[False] * COLS for _ in range(ROWS)]

    # DFS using an explicit stack (avoids Python recursion-depth limits)
    start_row = random.randrange(ROWS)          # random row on left edge
    stack = [(start_row, 0)]
    visited[start_row][0] = True

    while stack:
        r, c = stack[-1]

        # Collect unvisited neighbours (shuffled for randomness)
        neighbours = []
        for dr, dc in DIRECTIONS:
            nr, nc = r + dr, c + dc
            if 0 <= nr < ROWS and 0 <= nc < COLS and not visited[nr][nc]:
                neighbours.append((nr, nc))

        if neighbours:
            # Pick a random unvisited neighbour
            nr, nc = random.choice(neighbours)
            # Carve a passage: remove the wall between (r,c) and (nr,nc)
            walls.discard(frozenset({(r, c), (nr, nc)}))
            visited[nr][nc] = True
            stack.append((nr, nc))
        else:
            # Dead-end: backtrack
            stack.pop()

    # Choose a random exit on the right edge
    exit_row = random.randrange(ROWS)

    # Ensure start != exit in (row,col) terms (they're on different columns, so
    # this is always true, but keep it explicit for clarity)
    start = (start_row, 0)
    exit_cell = (exit_row, COLS - 1)

    return {
        "walls": walls,
        "start": start,
        "exit": exit_cell,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Passage Helper
# ──────────────────────────────────────────────────────────────────────────────

def has_passage(walls, cell_a, cell_b):
    """
    Return True if there is an open passage between cell_a and cell_b
    (i.e. no wall separates them).
    """
    return frozenset({cell_a, cell_b}) not in walls


def get_open_neighbours(walls, row, col):
    """Return a list of (r, c) neighbours reachable from (row, col)."""
    neighbours = []
    for dr, dc in DIRECTIONS:
        nr, nc = row + dr, col + dc
        if 0 <= nr < ROWS and 0 <= nc < COLS:
            if has_passage(walls, (row, col), (nr, nc)):
                neighbours.append((nr, nc))
    return neighbours


# ──────────────────────────────────────────────────────────────────────────────
# A* Pathfinding
# ──────────────────────────────────────────────────────────────────────────────

def manhattan(a, b):
    """
    Manhattan distance heuristic.

    For a grid where each move costs 1 and only horizontal/vertical moves
    are allowed, Manhattan distance is both admissible and consistent, so
    A* is guaranteed to find an optimal (shortest) path.
    """
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def astar(walls, start, goal):
    """
    Find the shortest path from `start` to `goal` using A*.

    Algorithm:
      - g(n): actual cost from start to n (unit cost per move = 1).
      - h(n): Manhattan distance from n to goal (admissible heuristic).
      - f(n) = g(n) + h(n).
      - Use a min-heap (priority queue) ordered by f(n).
      - Track the best known g-value for each cell to skip outdated entries.
      - Reconstruct the path by following parent pointers from goal → start,
        then reverse the result.

    Returns
    -------
    list of (row, col) tuples from start to goal (inclusive),
    or an empty list if no path exists.
    """
    # Priority queue entries: (f_value, g_value, (row, col))
    open_heap = []
    heapq.heappush(open_heap, (manhattan(start, goal), 0, start))

    # g_cost[cell] = best known cost from start to cell
    g_cost = {start: 0}

    # parent[cell] = the cell we came from to reach cell
    parent = {start: None}

    while open_heap:
        f, g, current = heapq.heappop(open_heap)

        # Skip stale heap entries (a shorter path was already found)
        if g > g_cost.get(current, float("inf")):
            continue

        # Goal reached — reconstruct the path
        if current == goal:
            path = []
            node = goal
            while node is not None:
                path.append(node)
                node = parent[node]
            path.reverse()
            return path

        r, c = current
        for neighbour in get_open_neighbours(walls, r, c):
            tentative_g = g + 1                   # unit movement cost
            if tentative_g < g_cost.get(neighbour, float("inf")):
                g_cost[neighbour] = tentative_g
                parent[neighbour] = current
                f_new = tentative_g + manhattan(neighbour, goal)
                heapq.heappush(open_heap, (f_new, tentative_g, neighbour))

    # No path found (should not happen for a connected DFS maze)
    return []


# ──────────────────────────────────────────────────────────────────────────────
# Movement Validator
# ──────────────────────────────────────────────────────────────────────────────

def is_valid_move(walls, from_cell, to_cell):
    """
    Validate whether a player can move from `from_cell` to `to_cell`.

    Rules enforced here (additional rules like visited-cell checks are
    enforced at the game-state level in app.py):
      1. Both cells must be within the grid bounds.
      2. The cells must be exactly one step apart (adjacent).
      3. The passage between them must be open (no wall).
    """
    r1, c1 = from_cell
    r2, c2 = to_cell

    # Bounds check
    if not (0 <= r1 < ROWS and 0 <= c1 < COLS):
        return False
    if not (0 <= r2 < ROWS and 0 <= c2 < COLS):
        return False

    # Adjacency check (Manhattan distance == 1)
    if abs(r1 - r2) + abs(c1 - c2) != 1:
        return False

    # Passage check
    return has_passage(walls, from_cell, to_cell)


# ──────────────────────────────────────────────────────────────────────────────
# Serialisation helpers (walls can't be JSON-serialised directly)
# ──────────────────────────────────────────────────────────────────────────────

def walls_to_list(walls):
    """Convert a set of frozensets to a JSON-serialisable list of lists."""
    return [list(map(list, w)) for w in walls]


def list_to_walls(wall_list):
    """Restore a set of frozensets from the serialised form."""
    return {frozenset(map(tuple, pair)) for pair in wall_list}
