# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: f1a2b3c4]
from novakernel import ui

threshold = ui.slider(0, 100, value=42, label="阈值")
normalize = ui.checkbox(True)

# %% [cell-id: f5e6f7a8]
scores = [12, 37, 45, 58, 63, 71, 88, 94]
passed = [x for x in scores if x <= threshold.value]
total = sum(passed)
mode = "normalize" if normalize.value else "raw"
print(f"threshold={threshold.value} mode={mode} passed_n={len(passed)} total={total}")
