"""The build's version, compared with the newest GitHub release by the updater.

Bump it in the same commit as the release tag. Nothing reads the tag at build
time, so a release whose version did not move here ships an exe that thinks it
is the previous one.
"""

from __future__ import annotations

VERSION = "0.4.1"
