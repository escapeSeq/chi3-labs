from __future__ import annotations

import os
import tempfile
from pathlib import Path

_DIR = Path(tempfile.mkdtemp(prefix="handwriting-"))
os.environ["HANDWRITING_DATA"] = str(_DIR)
