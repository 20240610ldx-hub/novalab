# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: a1b2c3d4]
import pandas as pd

df = pd.DataFrame(
    {
        "county": ["沈阳", "大连", "沈阳", "鞍山"],
        "pop": [9.1, 7.5, 0.9, 3.4],
        "year": [2024, 2024, 2025, 2025],
    }
)
df

# %% [cell-id: b2c3d4e5]
total = df.groupby("county")["pop"].sum()
total

# %% [cell-id: c3d4e5f6]
print(f"counties={len(total)} max={total.max()}")
