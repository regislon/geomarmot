"""Hatch build hook: ship the built front-end inside the package, as ``geomarmot/static``.

From a checkout of the repository, the wheel and sdist take the Vite build in ``../dist`` (run
``npm ci && npm run build`` first, or set ``GEOMARMOT_BUILD_FRONTEND=1`` to have the hook run it).
From an sdist, ``geomarmot/static`` is already there. Editable installs (``uv sync`` for the server's
own tests) need no front-end and skip the hook. A wheel without the app is refused rather than
built empty.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class FrontendBuildHook(BuildHookInterface):
    PLUGIN_NAME = "frontend"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        if version == "editable" or os.environ.get("GEOMARMOT_SKIP_FRONTEND") == "1":
            return
        root = Path(self.root)
        static = root / "geomarmot" / "static"
        repo = root.parent
        dist = repo / "dist"
        if (repo / "package.json").is_file():
            if os.environ.get("GEOMARMOT_BUILD_FRONTEND") == "1":
                subprocess.run(["npm", "run", "build"], cwd=repo, check=True)  # noqa: S603, S607
            if (dist / "index.html").is_file():
                if static.exists():
                    shutil.rmtree(static)
                shutil.copytree(dist, static)
        if not (static / "index.html").is_file():
            raise RuntimeError(
                "No built front-end to package. Run `npm ci && npm run build` at the repository root "
                "(or set GEOMARMOT_BUILD_FRONTEND=1), or build from an sdist that contains geomarmot/static."
            )
