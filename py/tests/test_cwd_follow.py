"""load_file 的 cwd 跟随语义（Jupyter 同款）：内核工作目录 = notebook 目录。"""

import os

from novakernel.runtime import Runtime


def test_load_file_chdir_to_notebook_dir(tmp_path):
    old = os.getcwd()
    try:
        nb = tmp_path / "nb.py"
        nb.write_text(
            "# %% [cell-id: aaaaaaaa]\nimport os\nprint(os.getcwd())\n",
            encoding="utf-8",
        )
        rt = Runtime(notify=lambda m, p: None)
        rt.load_file(str(nb))
        assert os.getcwd() == str(tmp_path)
        rep = rt.exec_cell("aaaaaaaa", cascade=False)
        assert rep["ok"]
    finally:
        os.chdir(old)


def test_load_file_relative_write_lands_in_notebook_dir(tmp_path):
    old = os.getcwd()
    try:
        nb = tmp_path / "nb.py"
        nb.write_text(
            "# %% [cell-id: bbbbbbbb]\nopen('out.txt', 'w').write('x')\n",
            encoding="utf-8",
        )
        rt = Runtime(notify=lambda m, p: None)
        rt.load_file(str(nb))
        rep = rt.exec_cell("bbbbbbbb", cascade=False)
        assert rep["ok"]
        assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "x"
    finally:
        os.chdir(old)
