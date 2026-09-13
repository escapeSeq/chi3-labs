from __future__ import annotations

import os
import tempfile
from pathlib import Path

# Isolate API tests from the real /data brains.
_DIR = Path(tempfile.mkdtemp(prefix="dogfight-brains-"))
os.environ["DOGFIGHT_DATA"] = str(_DIR)
