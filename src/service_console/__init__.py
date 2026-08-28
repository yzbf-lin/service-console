"""Service Console package."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("service-console")
except PackageNotFoundError:
    __version__ = "0.0.0"
