"""Assert the numpy kernel (cnn_numpy.py) reproduces the TS kernel's forward pass
on the real corner architecture (issue #11; PLAN top-risk #4).

Run after `npm run gen:parity`:

    python3 tools/train/check_parity.py

Loads tools/train/parity-fixture.json (manifest + int8 blob + the TS output), runs
the numpy forward on the same dequantised weights + ramp input, and fails (exit 1)
if the max abs difference exceeds the tolerance. This is the fast dev-loop guard;
the committed guard is the trained model's referenceVector in the TS asset test.
"""

import base64
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cnn_numpy import forward, read_blob_tensors, reference_input  # noqa: E402

TOL = 1e-4  # the TS asset test's parity tolerance

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "parity-fixture.json")
if not os.path.exists(path):
    sys.exit("parity-fixture.json missing — run `npm run gen:parity` first")

with open(path) as f:
    fix = json.load(f)

manifest = fix["manifest"]
blob = base64.b64decode(fix["blobBase64"])
ts_out = np.array(fix["output"], dtype=np.float64)

tensors = read_blob_tensors(manifest, blob)
np_out = forward(manifest["layers"], tensors, reference_input(manifest)).astype(np.float64)

max_abs = float(np.max(np.abs(np_out - ts_out)))
print(f"TS:    [{', '.join(f'{v:.5f}' for v in ts_out)}]")
print(f"numpy: [{', '.join(f'{v:.5f}' for v in np_out)}]")
print(f"max abs error = {max_abs:.3e}  (tol {TOL:.0e})")
if max_abs > TOL:
    sys.exit(f"FAIL — numpy and TS forward passes diverge by {max_abs:.3e} > {TOL:.0e}")
print("PASS — numpy and TS forward passes agree")
