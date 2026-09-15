from __future__ import annotations

import os
import tempfile
from pathlib import Path

_DIR = Path(tempfile.mkdtemp(prefix="swarm-memory-"))
os.environ["SWARM_DATA"] = str(_DIR)
