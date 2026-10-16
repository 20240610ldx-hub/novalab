"""Atomic-save regressions; every injected failure is confined to tmp_path."""

import builtins
import errno
import os
from pathlib import Path
import stat
import tempfile

import pytest

from novakernel import serialize


ORIGINAL = b"# original bytes\r\nvalue = '\xff'\r\n\x00"
TEXT = "# 科研 notebook\n城市 = '北京 🧪'\n"


class FailingWriter:
    def __init__(self, stream, stage):
        self.stream = stream
        self.stage = stage

    def __enter__(self):
        self.stream.__enter__()
        return self

    def __exit__(self, *exc):
        result = self.stream.__exit__(*exc)
        if self.stage == "close" and exc[0] is None:
            raise OSError(errno.EIO, "injected close failure")
        return result

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def write(self, text):
        if self.stage == "write":
            self.stream.write(text[:8])
            self.stream.flush()
            raise OSError(errno.EIO, "injected write failure")
        return self.stream.write(text)

    def flush(self):
        if self.stage == "flush":
            raise OSError(errno.EIO, "injected flush failure")
        return self.stream.flush()


@pytest.mark.parametrize("existing", [True, False], ids=["existing", "new"])
@pytest.mark.parametrize("stage", ["create", "fdopen", "write", "flush", "fsync", "close", "replace"])
def test_failure_preserves_original_and_cleans_own_temp(tmp_path, monkeypatch, stage, existing):
    target = tmp_path / "notebook.py"
    if existing:
        target.write_bytes(ORIGINAL)
    unrelated = tmp_path / ".novalab-unrelated.tmp"
    unrelated.write_bytes(b"belongs to another save")
    expected = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    created = {}
    real_mkstemp = tempfile.mkstemp
    real_fdopen = os.fdopen
    real_fsync = os.fsync
    real_replace = os.replace

    def mkstemp(*args, **kwargs):
        assert Path(kwargs["dir"]) == tmp_path
        if stage == "create":
            raise OSError(errno.ENOSPC, "injected create failure")
        fd, name = real_mkstemp(*args, **kwargs)
        created[fd] = Path(name)
        return fd, name

    def legacy_open(path, *args, **kwargs):
        assert Path(path) == target
        return FailingWriter(builtins.open(path, *args, **kwargs), stage)

    def fdopen(fd, *args, **kwargs):
        if fd not in created:
            return real_fdopen(fd, *args, **kwargs)
        if stage == "fdopen":
            raise OSError(errno.EIO, "injected fdopen failure")
        return FailingWriter(real_fdopen(fd, *args, **kwargs), stage)

    def fsync(fd):
        if fd in created and stage == "fsync":
            raise OSError(errno.EIO, "injected fsync failure")
        return real_fsync(fd)

    def replace(source, destination):
        if Path(destination) == target and stage == "replace":
            assert Path(source) in created.values()
            raise OSError(errno.EACCES, "injected replace failure")
        return real_replace(source, destination)

    monkeypatch.setattr(tempfile, "mkstemp", mkstemp)
    # Exercise the truncating implementation too, so its data loss is a real red regression.
    monkeypatch.setattr(serialize, "open", legacy_open, raising=False)
    monkeypatch.setattr(os, "fdopen", fdopen)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)

    with pytest.raises(OSError, match=f"injected {stage} failure"):
        serialize.write_file(str(target), TEXT)

    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == expected
    for fd in created:
        with pytest.raises(OSError) as exc:
            os.fstat(fd)
        assert exc.value.errno == errno.EBADF


def test_encoding_failure_keeps_original_bytes(tmp_path):
    target = tmp_path / "notebook.py"
    target.write_bytes(ORIGINAL)

    with pytest.raises(UnicodeEncodeError):
        serialize.write_file(str(target), "valid prefix\n\ud800")

    assert target.read_bytes() == ORIGINAL
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.parametrize("existing", [True, False], ids=["existing", "new"])
def test_success_replaces_only_after_fsync_and_close(tmp_path, monkeypatch, existing):
    target = tmp_path / "notebook.py"
    if existing:
        target.write_bytes(ORIGINAL)
    real_mkstemp = tempfile.mkstemp
    real_fsync = os.fsync
    real_replace = os.replace
    staged = {}
    synced = []
    replaced = []

    def mkstemp(*args, **kwargs):
        assert Path(kwargs["dir"]) == tmp_path
        fd, name = real_mkstemp(*args, **kwargs)
        staged[fd] = Path(name)
        return fd, name

    def fsync(fd):
        assert fd in staged
        assert staged[fd].read_bytes() == TEXT.encode("utf-8")
        if existing:
            assert target.read_bytes() == ORIGINAL
        else:
            assert not target.exists()
        result = real_fsync(fd)
        synced.append(fd)
        return result

    def replace(source, destination):
        assert Path(destination) == target
        assert Path(source).parent == tmp_path
        assert Path(source) != target
        assert len(synced) == 1
        assert staged[synced[0]] == Path(source)
        with pytest.raises(OSError) as exc:
            os.fstat(synced[0])
        assert exc.value.errno == errno.EBADF
        assert Path(source).read_bytes() == TEXT.encode("utf-8")
        replaced.append(Path(source))
        return real_replace(source, destination)

    monkeypatch.setattr(tempfile, "mkstemp", mkstemp)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)

    serialize.write_file(str(target), TEXT)

    assert len(replaced) == 1
    assert target.read_bytes() == TEXT.encode("utf-8")
    assert b"\r" not in target.read_bytes()
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits are not supported on this platform")
@pytest.mark.parametrize("mode", [0o600, 0o640, 0o751])
def test_existing_posix_permission_mode_is_preserved(tmp_path, mode):
    target = tmp_path / "notebook.py"
    target.write_bytes(ORIGINAL)
    target.chmod(mode)

    serialize.write_file(str(target), TEXT)

    assert target.read_bytes() == TEXT.encode("utf-8")
    assert stat.S_IMODE(target.stat().st_mode) == mode


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits are not supported on this platform")
def test_new_file_permissions_are_private(tmp_path):
    target = tmp_path / "notebook.py"
    previous_umask = os.umask(0)
    try:
        serialize.write_file(str(target), TEXT)
    finally:
        os.umask(previous_umask)

    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert target.read_bytes() == TEXT.encode("utf-8")


@pytest.mark.parametrize("existing", [True, False], ids=["existing", "dangling"])
def test_symlink_keeps_link_and_saves_to_resolved_target(tmp_path, monkeypatch, existing):
    target_dir = tmp_path / "data"
    target_dir.mkdir()
    target = target_dir / "notebook.py"
    if existing:
        target.write_bytes(ORIGINAL)
    link = tmp_path / "notebook-link.py"
    try:
        link.symlink_to(Path("data") / "notebook.py")
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"File symlink creation unavailable: {type(exc).__name__}: {exc}")
    link_value = os.readlink(link)
    real_replace = os.replace
    destinations = []

    def replace(source, destination):
        assert Path(source).parent == target_dir
        assert Path(destination) == target
        destinations.append(Path(destination))
        return real_replace(source, destination)

    monkeypatch.setattr(os, "replace", replace)

    serialize.write_file(str(link), TEXT)

    assert destinations == [target]
    assert link.is_symlink()
    assert os.readlink(link) == link_value
    assert target.read_bytes() == TEXT.encode("utf-8")
    assert link.read_bytes() == TEXT.encode("utf-8")
    assert set(tmp_path.iterdir()) == {target_dir, link}
    assert list(target_dir.iterdir()) == [target]


def test_missing_parent_is_not_created(tmp_path):
    parent = tmp_path / "missing"

    with pytest.raises(FileNotFoundError):
        serialize.write_file(str(parent / "notebook.py"), TEXT)

    assert not parent.exists()
    assert list(tmp_path.iterdir()) == []
