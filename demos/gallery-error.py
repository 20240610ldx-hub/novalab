# /// script
# requires-python = ">=3.11"
# dependencies = ["pandas"]
# ///
# [novalab] width=compact | app_view=false | kernel_python="3.13"

# %% [cell-id: e1a2b3c4]
import pandas as pd

survey = pd.DataFrame(
    {
        "city": ["沈阳", "大连", "鞍山"],
        "pop_2024": [9.1, 7.5, 3.4],
    }
)
survey

# %% [cell-id: e5d6f7a8]
row = survey.iloc[0].to_dict()

label = row["county"]
print(label)
