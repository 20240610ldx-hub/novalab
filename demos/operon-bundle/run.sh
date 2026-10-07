#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# ─── Environment setup ───
if [ -f "frames/OPERON-f9fa236d/00-python/environment.yml" ]; then
  if ! conda env list | grep -q "^bundle-f9fa236d-python "; then
    echo "Creating conda env bundle-f9fa236d-python from frames/OPERON-f9fa236d/00-python/environment.yml..."
    conda env create -f "frames/OPERON-f9fa236d/00-python/environment.yml" -n bundle-f9fa236d-python
  fi
else
  echo "Warning: frames/OPERON-f9fa236d/00-python/environment.yml not found; skipping env bundle-f9fa236d-python" >&2
fi

# ─── Execute notebooks ───
# ─── OPERON · segment 0 (python) ───
conda run -n bundle-f9fa236d-python jupyter nbconvert --to notebook --execute "frames/OPERON-f9fa236d/00-python/notebook.ipynb" --output executed.ipynb

echo "✓ bundle reproduced — compare outputs/ against your re-run"
