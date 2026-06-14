"""Pure-numpy mirror of the bespoke TS inference kernel (src/ml/kernel.ts) plus the
weights-blob format (src/ml/blob.ts) — the trainer's half of the weights-blob
contract (PLAN "ML engineering"; issue #11).

Why this file exists, and why it mirrors the TS so carefully:

  • The runtime is a hand-written TS kernel, NOT a general ML runtime (PLAN
    decision #2). So there is no ONNX/torch export — the trainer must WRITE exactly
    the bytes the TS kernel READS, and its forward pass must MATCH the TS kernel's
    bit-for-(near)bit, or the shipped int8 weights would compute something different
    in the browser than they did in training (PLAN top-risk #4, "hand-rolled
    inference parity").
  • The guard against divergence is the manifest's referenceVector: this module
    computes (ramp input -> output) here in numpy; the TS parity test asserts the TS
    kernel reproduces it (scripts/corner-v1-asset.test.ts). If the two forward
    passes disagree, that test fails loudly.

Conventions copied verbatim from kernel.ts so the maths lines up:
  • Feature maps are CHW float32; conv weights [outC,inC,kH,kW]; dense [outF,inF].
  • Cross-correlation (no kernel flip), zero-pad, float accumulate.
  • TS accumulates each conv/dense output in float64 (JS numbers) then STORES it into
    a Float32Array — i.e. float32 at every layer boundary. We mirror that: matmul in
    float64, cast the result to float32 after each layer. That makes the parity error
    ~float32 epsilon (summation-order differences vanish under the float32 cast).
  • int8 (de)quant matches blob.ts quantizeInt8: symmetric, scale = maxAbs/127,
    q = JS-Math.round(f/scale) clamped to [-127,127], dequant f = q*scale. JS
    Math.round is floor(x+0.5); np.floor(x+0.5) reproduces it for negatives too.
"""

from __future__ import annotations

import numpy as np

# ── int8 (de)quantisation — must match blob.ts exactly ───────────────────────────

def js_round(x: np.ndarray) -> np.ndarray:
    """JS Math.round semantics (round half toward +inf): floor(x + 0.5)."""
    return np.floor(x.astype(np.float64) + 0.5)


def quantize_int8(data: np.ndarray) -> tuple[np.ndarray, float]:
    """Symmetric per-tensor int8 quant. Returns (int8 values, scale). Mirrors
    blob.ts quantizeInt8 (zeroPoint is always 0)."""
    flat = np.asarray(data, dtype=np.float64).ravel()
    max_abs = float(np.max(np.abs(flat))) if flat.size else 0.0
    scale = max_abs / 127.0 if max_abs > 0 else 1.0
    q = js_round(flat / scale)
    q = np.clip(q, -127, 127).astype(np.int8)
    return q, scale


def dequantize_int8(q: np.ndarray, scale: float) -> np.ndarray:
    """Inverse of quantize_int8 (zeroPoint 0): f = q * scale, as float32."""
    return (q.astype(np.float64) * scale).astype(np.float32)


# ── kernel ops (forward) — mirror src/ml/kernel.ts ───────────────────────────────

def _out_dim(in_size: int, kernel: int, stride: int, pad: int) -> int:
    return (in_size + 2 * pad - kernel) // stride + 1


def conv2d(x: np.ndarray, w: np.ndarray, b: np.ndarray | None, p: dict) -> np.ndarray:
    """2-D cross-correlation, zero-pad, stride. x is (Cin,H,W) float; w is
    (outC,inC,kH,kW); b is (outC,) or None. Returns (outC,outH,outW) float32.

    Implemented with im2col + matmul (fast in numpy) but accumulated in float64 and
    cast to float32 at the end — the same value the TS nested-loop conv stores."""
    cin, h, wid = x.shape
    assert cin == p["inChannels"], f"conv2d: {cin} channels != {p['inChannels']}"
    kh, kw = p["kernelH"], p["kernelW"]
    sh, sw = p["strideH"], p["strideW"]
    ph, pw = p["padH"], p["padW"]
    out_h = _out_dim(h, kh, sh, ph)
    out_w = _out_dim(wid, kw, sw, pw)
    assert out_h >= 1 and out_w >= 1, "conv2d: kernel larger than padded input"

    xf = x.astype(np.float64)
    if ph or pw:
        xf = np.pad(xf, ((0, 0), (ph, ph), (pw, pw)), mode="constant")
    # im2col: cols[(ic,ky,kx), (oy,ox)]
    cols = np.empty((cin * kh * kw, out_h * out_w), dtype=np.float64)
    r = 0
    for ic in range(cin):
        for ky in range(kh):
            for kx in range(kw):
                patch = xf[ic, ky : ky + sh * out_h : sh, kx : kx + sw * out_w : sw]
                cols[r] = patch.reshape(-1)
                r += 1
    wm = w.astype(np.float64).reshape(p["outChannels"], cin * kh * kw)
    out = wm @ cols  # (outC, outH*outW)
    if b is not None:
        out += b.astype(np.float64).reshape(-1, 1)
    return out.reshape(p["outChannels"], out_h, out_w).astype(np.float32)


def relu(x: np.ndarray) -> np.ndarray:
    return np.maximum(x, 0).astype(np.float32)


def global_avg_pool(x: np.ndarray) -> np.ndarray:
    """(C,H,W) -> (C,) mean over each plane, float32."""
    c = x.shape[0]
    return x.astype(np.float64).reshape(c, -1).mean(axis=1).astype(np.float32)


def dense(x: np.ndarray, w: np.ndarray, b: np.ndarray | None, in_f: int, out_f: int) -> np.ndarray:
    """out[o] = b[o] + sum_i x[i]*w[o*inF+i]. w is (outF,inF) flat. float32 out."""
    xf = x.astype(np.float64).reshape(-1)
    assert xf.size == in_f, f"dense: input {xf.size} != inF {in_f}"
    wm = w.astype(np.float64).reshape(out_f, in_f)
    out = wm @ xf
    if b is not None:
        out = out + b.astype(np.float64).reshape(-1)
    return out.astype(np.float32)


def forward(layers: list[dict], tensors: list[dict | None], x: np.ndarray) -> np.ndarray:
    """Run the manifest's layer list on a CHW float32 input, returning the output
    vector. `tensors[i]` is {'weight':np.ndarray, 'bias':np.ndarray|None} (already
    dequantised to float32) for parametric layers, else None — aligned 1:1 with
    `layers`. Dispatch mirrors src/ml/model.ts runModel."""
    cur = x.astype(np.float32)
    for layer, t in zip(layers, tensors):
        kind = layer["type"]
        if kind == "conv2d":
            cur = conv2d(cur, t["weight"], t["bias"], layer)
        elif kind == "relu":
            cur = relu(cur)
        elif kind == "globalavgpool":
            cur = global_avg_pool(cur)
        elif kind == "flatten":
            cur = cur.reshape(-1).astype(np.float32)
        elif kind == "dense":
            cur = dense(cur, t["weight"], t["bias"], layer["inFeatures"], layer["outFeatures"])
        else:
            raise ValueError(f"forward: unsupported layer {kind}")
    return cur


# ── reference input (mirror src/ml/model.ts referenceInput) ──────────────────────

def reference_input(manifest: dict) -> np.ndarray:
    inp = manifest["input"]
    n = inp["channels"] * inp["height"] * inp["width"]
    spec = manifest["referenceVector"]["input"]
    if spec["pattern"] == "ramp":
        data = np.array([(i % 256) / 255 for i in range(n)], dtype=np.float64)
    elif spec["pattern"] == "constant":
        data = np.full(n, spec["value"], dtype=np.float64)
    elif spec["pattern"] == "explicit":
        data = np.asarray(spec["data"], dtype=np.float64)
    else:
        raise ValueError(f"reference_input: unknown pattern {spec['pattern']}")
    return data.reshape(inp["channels"], inp["height"], inp["width"]).astype(np.float32)


# ── blob (de)serialisation — mirror src/ml/blob.ts ───────────────────────────────

def read_blob_tensors(manifest: dict, blob: bytes) -> list[dict | None]:
    """Resolve every layer's weight/bias from the blob to float32, aligned with
    manifest['layers'] (None for non-parametric layers). Mirrors loadModel."""

    def read_ref(ref: dict) -> np.ndarray:
        off, length, dtype = ref["offset"], ref["length"], ref["dtype"]
        if dtype == "int8":
            q = np.frombuffer(blob, dtype=np.int8, count=length, offset=off)
            return dequantize_int8(q, ref.get("scale", 1.0))
        floats = np.frombuffer(blob, dtype="<f4", count=length, offset=off)
        return floats.astype(np.float32)

    out: list[dict | None] = []
    for layer in manifest["layers"]:
        if layer["type"] not in ("conv2d", "dense"):
            out.append(None)
            continue
        weight = read_ref(layer["weight"])
        bias = read_ref(layer["bias"]) if layer.get("bias") else None
        out.append({"weight": weight, "bias": bias})
    return out


def pack_tensors(tensors: list[dict]) -> tuple[bytes, list[dict]]:
    """Pack [{'data':np.ndarray,'dtype':'int8'|'float32'}] into one contiguous blob,
    returning (bytes, refs). The inverse of read_blob_tensors / mirror of
    blob.ts packTensors, so writer and reader agree byte-for-byte."""
    chunks: list[bytes] = []
    refs: list[dict] = []
    offset = 0
    for t in tensors:
        data = np.asarray(t["data"], dtype=np.float64).ravel()
        if t["dtype"] == "int8":
            q, scale = quantize_int8(data)
            b = q.tobytes()
            ref = {"offset": offset, "length": int(data.size), "dtype": "int8",
                   "scale": scale, "zeroPoint": 0}
        else:
            b = data.astype("<f4").tobytes()
            ref = {"offset": offset, "length": int(data.size), "dtype": "float32"}
        chunks.append(b)
        refs.append(ref)
        offset += len(b)
    return b"".join(chunks), refs
