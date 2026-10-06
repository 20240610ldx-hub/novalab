# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas", "matplotlib"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: d1e2f3a4]
import pandas as pd

temps = pd.DataFrame(
    {
        "day": [1, 2, 3, 4, 5],
        "celsius": [18.2, 19.4, 17.8, 20.1, 21.3],
    }
)
temps

# %% [cell-id: d5e6f7a8]
import os
import tempfile

out_csv = os.path.join(tempfile.gettempdir(), "novalab-gallery-temps.csv")
temps.to_csv(out_csv, index=False)
print(f"rows={len(temps)}")

# %% [cell-id: d9e0f1a2]
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.plot(temps["day"], temps["celsius"], marker="o")
plt.title("daily temperature (gallery fixture)")
plt.xlabel("day")
plt.ylabel("celsius")
