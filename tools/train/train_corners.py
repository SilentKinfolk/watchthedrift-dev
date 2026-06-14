"""Pure-numpy trainer for the learned LCD-corner detector (issue #11, slice 6).

PLAN "Training is agent-doable — numpy-first, no heavy toolchain": this AppVM has
no torch/tf/ONNX and no GPU (numpy + PIL only), so rather than treat that as a
block the plan picks an architecture that needs none of it — a tiny CNN with
hand-written backprop over exactly the kernel's op set. Run:

    npm run prep:corners            # writes tools/train/corners-train.json
    python3 tools/train/train_corners.py
                                    # → src/models/corner-v1.{bin,json}

The forward ops + int8 quant + blob format are shared with cnn_numpy.py (the parity
mirror of the TS kernel), so what trains here runs identically in the browser; the
manifest's referenceVector (computed here) is asserted by the TS asset test.

Data reality (PLAN top-risks #2/#3/#5): the corner-labelled bases are few and show
one watch front-on, so AUGMENTATION carries generalisation — perspective warps move
/scale/skew the LCD across the frame (the angle/off-centre geometry the detector
must win), corners following each warp; photometric jitter breaks pixel-value
memorisation. Eval stays the held-out real eval-gold (measured by the harness).
Reproducible: seed + config (tools/train/config.json) + this code pin the run.
"""

from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cnn_numpy import (  # noqa: E402
    conv2d as conv2d_infer,
    forward as forward_infer,
    pack_tensors,
    quantize_int8,
    dequantize_int8,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))

# ── config (committed → reproducible) ────────────────────────────────────────────
CFG = json.load(open(os.path.join(HERE, "config.json")))
SEED = CFG["seed"]
INPUT_HW = CFG["inputHW"]          # 128
# Env overrides exist ONLY for the dev smoke run; the committed config pins the real
# training run (the reproducibility contract), so a normal `python3 train_corners.py`
# ignores them.
EPOCHS = int(os.environ.get("EPOCHS", CFG["epochs"]))
AUG_PER_BASE = int(os.environ.get("AUG_PER_BASE", CFG["augPerBase"]))  # variants per base per epoch (online aug)
LR = CFG["lr"]
HUBER_BETA = CFG["huberBeta"]
BASE_RES = CFG["baseRes"]          # working res for a base before warping
ARCH = CFG["arch"]                 # conv out-channels + dense hidden

rng = np.random.default_rng(SEED)

# ── data: bases + online augmentation ────────────────────────────────────────────

def load_bases() -> list[dict]:
    spec = json.load(open(os.path.join(HERE, "corners-train.json")))
    bases = []
    for it in spec["items"]:
        img = Image.open(os.path.join(ROOT, it["path"])).convert("L")
        # SQUASH to a square working res — production (KernelCornerSource.toModelInput)
        # resizes the whole frame to 128² with independent x/y scale, so normalised
        # corners are scale-invariant; we mirror that (no letterbox).
        arr = np.asarray(img.resize((BASE_RES, BASE_RES), Image.BILINEAR), dtype=np.float64)
        corners = np.array(it["corners"], dtype=np.float64)  # (4,2) normalised
        bases.append({"img": arr, "corners": corners, "name": os.path.basename(it["path"])})
    return bases


def solve_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray | None:
    """4-point DLT: H mapping src→dst (8 coeffs, h33=1). src/dst are (4,2)."""
    M = np.zeros((8, 8))
    r = np.zeros(8)
    for i in range(4):
        x, y = src[i]
        X, Y = dst[i]
        M[2 * i] = [x, y, 1, 0, 0, 0, -x * X, -y * X]
        r[2 * i] = X
        M[2 * i + 1] = [0, 0, 0, x, y, 1, -x * Y, -y * Y]
        r[2 * i + 1] = Y
    try:
        return np.linalg.solve(M, r)
    except np.linalg.LinAlgError:
        return None


def apply_h(h: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Map (N,2) points through homography h (8 coeffs)."""
    x, y = pts[:, 0], pts[:, 1]
    denom = h[6] * x + h[7] * y + 1
    return np.stack([(h[0] * x + h[1] * y + h[2]) / denom,
                     (h[3] * x + h[4] * y + h[5]) / denom], axis=1)


def random_background(out_hw: int, r: np.random.Generator) -> np.ndarray:
    """A structured background for the area outside the warped watch: a low-frequency
    gradient + coarse blobs + noise. Critical for generalisation — with one watch and
    flat fill the net learns 'bright/flat = background'; a structured, varied surround
    forces it to localise the LCD by its OWN structure (bright field + dark digit
    strokes) rather than by what surrounds it."""
    yy, xx = np.mgrid[0:out_hw, 0:out_hw].astype(np.float64) / out_hw
    base = r.uniform(40, 210)
    gx, gy = r.uniform(-80, 80), r.uniform(-80, 80)
    bg = base + gx * xx + gy * yy
    # a few soft blobs for texture
    for _ in range(int(r.integers(0, 4))):
        cx, cy = r.uniform(0, 1, 2)
        rad = r.uniform(0.1, 0.4)
        bg = bg + r.uniform(-60, 60) * np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2)) / (2 * rad * rad))
    bg = bg + r.normal(0, r.uniform(2, 14), size=bg.shape)
    return bg


def warp_to(img: np.ndarray, dst_quad: np.ndarray, out_hw: int, bg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse-warp `img` (HxW) so its rectangle lands on dst_quad (4,2 in out px),
    compositing over per-pixel background `bg`; returns (out image, forward
    homography src→out)."""
    h, w = img.shape
    src = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float64)
    forward = solve_homography(src, dst_quad)
    back = solve_homography(dst_quad, src)
    if forward is None or back is None:
        return None, None
    ys, xs = np.mgrid[0:out_hw, 0:out_hw]
    out_pts = np.stack([xs.ravel() + 0.5, ys.ravel() + 0.5], axis=1)
    s = apply_h(back, out_pts)
    sx, sy = s[:, 0], s[:, 1]
    inside = (sx >= 0) & (sx < w) & (sy >= 0) & (sy < h)
    # bilinear sample (clamped) for inside pixels
    x0 = np.clip(np.floor(sx).astype(int), 0, w - 1)
    y0 = np.clip(np.floor(sy).astype(int), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = np.clip(sx - np.floor(sx), 0, 1)
    fy = np.clip(sy - np.floor(sy), 0, 1)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    val = top * (1 - fy) + bot * fy
    out = np.where(inside, val, bg.ravel()).reshape(out_hw, out_hw)
    return out, forward


def augment(base: dict, r: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """One random (image, corners) variant: perspective warp (geometry) + photometric.
    Returns (128² grayscale float64 in [0,255], corners (4,2) normalised)."""
    img = base["img"]
    res = img.shape[0]
    out_hw = INPUT_HW
    # Destination quad for the image rectangle: scale into a sub-region, translate,
    # then jitter each corner (keystone/skew) — moves the LCD across the frame. Wide
    # scale range so the watch ranges from filling the frame to small-and-distant
    # (the eval set's full-length shot is a tiny LCD in a tall frame).
    scale = r.uniform(0.28, 1.0)
    span = out_hw * scale
    max_off = out_hw - span
    ox = r.uniform(0, max_off)
    oy = r.uniform(0, max_off)
    base_quad = np.array([[ox, oy], [ox + span, oy], [ox + span, oy + span], [ox, oy + span]], dtype=np.float64)
    jit = CFG["jitter"] * out_hw
    dst = base_quad + r.uniform(-jit, jit, size=(4, 2))
    out, forward = warp_to(img, dst, out_hw, random_background(out_hw, r))
    if out is None:
        # degenerate draw → identity fallback (squash base to 128)
        out = np.asarray(Image.fromarray(img.astype(np.uint8)).resize((out_hw, out_hw), Image.BILINEAR), dtype=np.float64)
        corners = base["corners"].copy()
    else:
        # corners (normalised over base) → base px → forward → out px → normalised
        cpx = base["corners"] * res
        opx = apply_h(forward, cpx)
        corners = opx / out_hw

    # photometric: brightness/contrast, gamma, glare, noise
    out = out * r.uniform(0.65, 1.3) + r.uniform(-30, 30)           # contrast+brightness
    g = r.uniform(0.6, 1.7)
    out = 255.0 * np.clip(out / 255.0, 0, 1) ** g                   # gamma
    if r.uniform() < 0.4:                                           # glare blob
        cx, cy = r.uniform(0, out_hw, 2)
        yy, xx = np.mgrid[0:out_hw, 0:out_hw]
        rad = r.uniform(0.12, 0.3) * out_hw
        out = out + r.uniform(80, 200) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * rad * rad))
    out = out + r.normal(0, r.uniform(0, 10), size=out.shape)       # sensor noise
    if r.uniform() < 0.5:                                           # inverted-display robustness
        out = 255.0 - out
    return np.clip(out, 0, 255), corners


def make_batch(bases: list[dict], r: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Build one epoch's augmented set: (N,1,128,128) inputs, (N,8) targets."""
    xs, ys = [], []
    for base in bases:
        for _ in range(AUG_PER_BASE):
            img, corners = augment(base, r)
            xs.append(((img / 255.0 - 0.5) / 0.5)[None, :, :])
            ys.append(corners.reshape(-1))
    X = np.array(xs, dtype=np.float64)
    Y = np.array(ys, dtype=np.float64)
    perm = r.permutation(len(X))
    return X[perm], Y[perm]


# ── the net: forward (cached) + hand-written backprop ────────────────────────────

def conv_params(in_c: int, out_c: int) -> dict:
    return {"inChannels": in_c, "outChannels": out_c, "kernelH": 3, "kernelW": 3,
            "strideH": 2, "strideW": 2, "padH": 1, "padW": 1}


CONV_SHAPES = [(1, ARCH[0]), (ARCH[0], ARCH[1]), (ARCH[1], ARCH[2]), (ARCH[2], ARCH[3])]
LAST_C = ARCH[3]
HID = ARCH[4]


def _conv_out(n: int) -> int:
    return (n + 2 * 1 - 3) // 2 + 1


# Spatial size after the 4 stride-2 convs, and the flattened feature count. The head
# FLATTENS (not global-avg-pools) the last conv map: corner regression is LOCALISATION
# (where), so the spatial grid must survive to the dense head — GAP averages it away
# and leaves the head able to emit only a constant prior. (PLAN grill fork "regression
# vs heatmaps": direct regression, but over a spatial-preserving flatten.)
_HW = INPUT_HW
for _ in CONV_SHAPES:
    _HW = _conv_out(_HW)
LAST_HW = _HW
FLAT = LAST_C * LAST_HW * LAST_HW


def he_std(fan_in: int) -> float:
    return float(np.sqrt(2.0 / fan_in))


def init_params(bases: list[dict]) -> dict:
    p = {}
    for i, (ic, oc) in enumerate(CONV_SHAPES):
        p[f"cw{i}"] = rng.normal(0, he_std(ic * 9), size=(oc, ic, 3, 3))
        p[f"cb{i}"] = np.zeros(oc)
    p["dw0"] = rng.normal(0, he_std(FLAT), size=(HID, FLAT))
    p["db0"] = np.zeros(HID)
    p["dw1"] = rng.normal(0, 0.01, size=(8, HID))
    # init last bias to the mean training corner → start near the data, learn deltas
    p["db1"] = np.mean([b["corners"].reshape(-1) for b in bases], axis=0)
    return p


def im2col(x: np.ndarray, p: dict) -> tuple[np.ndarray, int, int]:
    """x (Cin,H,W) → cols (Cin*9, outH*outW) with zero-pad/stride (training, f64)."""
    cin, h, w = x.shape
    kh = kw = 3
    sh = sw = 2
    ph = pw = 1
    out_h = (h + 2 * ph - kh) // sh + 1
    out_w = (w + 2 * pw - kw) // sw + 1
    xf = np.pad(x, ((0, 0), (ph, ph), (pw, pw)))
    cols = np.empty((cin * kh * kw, out_h * out_w))
    r = 0
    for ic in range(cin):
        for ky in range(kh):
            for kx in range(kw):
                cols[r] = xf[ic, ky:ky + sh * out_h:sh, kx:kx + sw * out_w:sw].reshape(-1)
                r += 1
    return cols, out_h, out_w


def forward_train(p: dict, x: np.ndarray) -> tuple[np.ndarray, dict]:
    """Single-sample forward, caching activations for backprop. x is (1,128,128)."""
    cache = {"x0": x}
    cur = x
    for i, (ic, oc) in enumerate(CONV_SHAPES):
        cols, oh, ow = im2col(cur, conv_params(ic, oc))
        wm = p[f"cw{i}"].reshape(oc, -1)
        z = (wm @ cols + p[f"cb{i}"][:, None]).reshape(oc, oh, ow)
        a = np.maximum(z, 0)
        cache[f"cols{i}"] = cols
        cache[f"z{i}"] = z
        cache[f"in{i}"] = cur
        cache[f"shape{i}"] = (oc, oh, ow)
        cur = a
    cache["last_shape"] = cur.shape                # (LAST_C, h, w)
    flat = cur.reshape(-1)                          # row-major CHW → matches kernel flatten
    cache["flat"] = flat
    h0 = p["dw0"] @ flat + p["db0"]
    a0 = np.maximum(h0, 0)
    cache["h0"] = h0
    cache["a0"] = a0
    out = p["dw1"] @ a0 + p["db1"]                 # (8,) linear
    return out, cache


def backward_train(p: dict, cache: dict, dout: np.ndarray) -> dict:
    """Backprop dL/dout (8,) → grads for every param. Mirrors forward_train."""
    g = {}
    a0 = cache["a0"]
    g["dw1"] = np.outer(dout, a0)
    g["db1"] = dout.copy()
    da0 = p["dw1"].T @ dout
    dh0 = da0 * (cache["h0"] > 0)
    g["dw0"] = np.outer(dh0, cache["flat"])
    g["db0"] = dh0
    dflat = p["dw0"].T @ dh0                        # (FLAT,)
    # flatten backward: reshape straight back to the last conv map (CHW)
    dcur = dflat.reshape(cache["last_shape"])
    for i in reversed(range(len(CONV_SHAPES))):
        ic, occ = CONV_SHAPES[i]
        z = cache[f"z{i}"]
        dz = dcur * (z > 0)                         # relu backward
        oc_i, oh_i, ow_i = cache[f"shape{i}"]
        dz_m = dz.reshape(oc_i, -1)                 # (oc, oh*ow)
        cols = cache[f"cols{i}"]                    # (ic*9, oh*ow)
        g[f"cw{i}"] = (dz_m @ cols.T).reshape(occ, ic, 3, 3)
        g[f"cb{i}"] = dz_m.sum(axis=1)
        if i > 0:                                   # propagate to the conv input
            wm = p[f"cw{i}"].reshape(occ, -1)       # (oc, ic*9)
            dcols = wm.T @ dz_m                      # (ic*9, oh*ow)
            dcur = col2im(dcols, cache[f"in{i}"].shape, oh_i, ow_i)
    return g


def col2im(dcols: np.ndarray, in_shape: tuple, out_h: int, out_w: int) -> np.ndarray:
    """Scatter-add conv-input gradient (inverse of im2col), zero-pad/stride 3/2/1."""
    cin, h, w = in_shape
    kh = kw = 3
    sh = sw = 2
    ph = pw = 1
    dxf = np.zeros((cin, h + 2 * ph, w + 2 * pw))
    r = 0
    for ic in range(cin):
        for ky in range(kh):
            for kx in range(kw):
                patch = dcols[r].reshape(out_h, out_w)
                dxf[ic, ky:ky + sh * out_h:sh, kx:kx + sw * out_w:sw] += patch
                r += 1
    return dxf[:, ph:ph + h, pw:pw + w]


def huber_grad(pred: np.ndarray, tgt: np.ndarray, beta: float) -> tuple[float, np.ndarray]:
    d = pred - tgt
    ad = np.abs(d)
    loss = np.where(ad < beta, 0.5 * d * d / beta, ad - 0.5 * beta).sum()
    grad = np.where(ad < beta, d / beta, np.sign(d))
    return float(loss), grad


# ── Adam ─────────────────────────────────────────────────────────────────────────

class Adam:
    def __init__(self, params: dict, lr: float, weight_decay: float = 0.0):
        self.lr = lr
        self.wd = weight_decay
        self.b1, self.b2, self.eps = 0.9, 0.999, 1e-8
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def step(self, params: dict, grads: dict):
        self.t += 1
        for k in params:
            gk = grads[k]
            self.m[k] = self.b1 * self.m[k] + (1 - self.b1) * gk
            self.v[k] = self.b2 * self.v[k] + (1 - self.b2) * gk * gk
            mhat = self.m[k] / (1 - self.b1 ** self.t)
            vhat = self.v[k] / (1 - self.b2 ** self.t)
            params[k] -= self.lr * mhat / (np.sqrt(vhat) + self.eps)
            # decoupled weight decay (AdamW) on weight matrices only, not biases →
            # regularises against tiny-corpus overfit (PLAN top-risk #5).
            if self.wd and (k.startswith("cw") or k.startswith("dw")):
                params[k] -= self.lr * self.wd * params[k]


# ── eval-gold corner-error monitor (held out — never trained on) ─────────────────

def load_eval_gold() -> list[dict]:
    """Real held-out eval images with human corners, for an honest training monitor.
    Mirrors the harness corner-error (mean per-corner displacement / LCD diagonal)."""
    fixtures = os.path.join(ROOT, "tools", "fixtures")
    out = []
    if not os.path.isdir(fixtures):
        return out
    for f in sorted(os.listdir(fixtures)):
        if not f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        sc_path = os.path.join(fixtures, f + ".json")
        if not os.path.exists(sc_path):
            continue
        sc = json.load(open(sc_path))
        if sc.get("eval") is not True or not sc.get("corners"):
            continue
        img = Image.open(os.path.join(fixtures, f)).convert("L")
        W, H = img.size
        arr = np.asarray(img.resize((INPUT_HW, INPUT_HW), Image.BILINEAR), dtype=np.float64)
        x = ((arr / 255.0 - 0.5) / 0.5)[None, :, :]
        corners = np.array([[p["x"] / W, p["y"] / H] for p in sc["corners"]])
        out.append({"x": x, "corners": corners, "stratum": sc.get("stratum"), "name": f})
    return out


def corner_error(pred8: np.ndarray, tgt: np.ndarray) -> float:
    pred = pred8.reshape(4, 2)
    diag = np.hypot(*(tgt[2] - tgt[0]))  # TL→BR diagonal
    if diag <= 0:
        return float("nan")
    return float(np.mean(np.hypot(*(pred - tgt).T)) / diag)


def eval_corner_errors(p: dict, gold: list[dict]) -> dict:
    per = {}
    for g in gold:
        out, _ = forward_train(p, g["x"])
        per[g["name"]] = (g["stratum"], corner_error(out, g["corners"]))
    return per


# ── train ────────────────────────────────────────────────────────────────────────

def main() -> None:
    t0 = time.time()
    bases = load_bases()
    gold = load_eval_gold()
    print(f"bases: {len(bases)}  eval-gold: {len(gold)}  "
          f"arch: conv{[s[1] for s in CONV_SHAPES]} flat{FLAT} dense{HID}->8  "
          f"epochs {EPOCHS} aug/base {AUG_PER_BASE} lr {LR}")
    params = init_params(bases)
    opt = Adam(params, LR, CFG.get("weightDecay", 0.0))

    base_lr = LR
    for epoch in range(EPOCHS):
        # step LR decay → settle the end-of-training bounce from online augmentation.
        frac = epoch / EPOCHS
        opt.lr = base_lr * (1.0 if frac < 0.6 else 0.3 if frac < 0.85 else 0.1)
        ep_rng = np.random.default_rng(SEED * 100003 + epoch)
        X, Y = make_batch(bases, ep_rng)
        total = 0.0
        for i in range(len(X)):
            out, cache = forward_train(params, X[i])
            loss, dout = huber_grad(out, Y[i], HUBER_BETA)
            total += loss
            grads = backward_train(params, cache, dout)
            opt.step(params, grads)
        if epoch % 10 == 0 or epoch == EPOCHS - 1:
            errs = eval_corner_errors(params, gold)
            em = [e for (s, e) in errs.values() if s in ("easy", "moderate")]
            hard = [e for (s, e) in errs.values() if s == "hard"]
            msg = f"epoch {epoch:3d}  loss {total / len(X):.4f}"
            if em:
                msg += f"  eval-gold corner-err easy+mod {np.mean(em):.3f}"
            if hard:
                msg += f"  hard {np.mean(hard):.3f}"
            print(msg)

    # final eval-gold report
    errs = eval_corner_errors(params, gold)
    print("\neval-gold corner-error (mean per-corner displacement / LCD diagonal):")
    for name, (stratum, e) in errs.items():
        print(f"  {str(stratum):9} {e:.4f}  {name}")

    export(params, bases, errs, time.time() - t0)


def export(params: dict, bases: list[dict], errs: dict, secs: float) -> None:
    """Quantise to int8, build the manifest (matching blob.ts layer types), compute
    the referenceVector via the shared cnn_numpy forward on the DEQUANTISED weights
    (exactly what the TS kernel runs), and write src/models/corner-v1.{bin,json}
    (a Vite `?url` build asset — hashed at build, precached by the service worker)."""
    pack = []

    # Pack in layer order: conv(w int8, b f32) ×4, dense0(w int8, b f32), dense1(w int8, b f32)
    for i, (ic, oc) in enumerate(CONV_SHAPES):
        pack.append({"data": params[f"cw{i}"].reshape(oc, ic, 3, 3).reshape(-1), "dtype": "int8"})
        pack.append({"data": params[f"cb{i}"], "dtype": "float32"})
    pack.append({"data": params["dw0"].reshape(-1), "dtype": "int8"})
    pack.append({"data": params["db0"], "dtype": "float32"})
    pack.append({"data": params["dw1"].reshape(-1), "dtype": "int8"})
    pack.append({"data": params["db1"], "dtype": "float32"})

    blob, refs = pack_tensors(pack)

    layers = []
    ri = 0
    for i, (ic, oc) in enumerate(CONV_SHAPES):
        layers.append({"type": "conv2d", "inChannels": ic, "outChannels": oc,
                       "kernelH": 3, "kernelW": 3, "strideH": 2, "strideW": 2,
                       "padH": 1, "padW": 1, "weight": refs[ri], "bias": refs[ri + 1]})
        layers.append({"type": "relu"})
        ri += 2
    layers.append({"type": "flatten"})
    layers.append({"type": "dense", "inFeatures": FLAT, "outFeatures": HID,
                   "weight": refs[ri], "bias": refs[ri + 1]})
    layers.append({"type": "relu"})
    layers.append({"type": "dense", "inFeatures": HID, "outFeatures": 8,
                   "weight": refs[ri + 2], "bias": refs[ri + 3]})

    manifest = {
        "formatVersion": 1,
        "architecture": "corner-cnn-v1",
        "input": {"channels": 1, "height": INPUT_HW, "width": INPUT_HW, "mean": 0.5, "std": 0.5},
        "layers": layers,
        "output": {"size": 8, "meaning": "4 LCD corners (x,y) normalised, TL,TR,BR,BL"},
        "referenceVector": {"input": {"pattern": "ramp"}, "output": []},
    }
    # reference output via the SHARED forward on DEQUANTISED weights (what TS runs).
    tensors = []
    for layer in manifest["layers"]:
        if layer["type"] not in ("conv2d", "dense"):
            tensors.append(None)
            continue
        w = layer["weight"]
        weight = dequantize_int8(np.frombuffer(blob, np.int8, w["length"], w["offset"]), w["scale"])
        b = layer.get("bias")
        bias = np.frombuffer(blob, "<f4", b["length"], b["offset"]).astype(np.float32) if b else None
        tensors.append({"weight": weight, "bias": bias})
    n = manifest["input"]["channels"] * INPUT_HW * INPUT_HW
    ramp = np.array([(i % 256) / 255 for i in range(n)], dtype=np.float64).reshape(1, INPUT_HW, INPUT_HW).astype(np.float32)
    ref_out = forward_infer(manifest["layers"], tensors, ramp)
    manifest["referenceVector"]["output"] = [float(v) for v in ref_out]

    out_dir = os.path.join(ROOT, "src", "models")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "corner-v1.bin"), "wb") as f:
        f.write(blob)
    with open(os.path.join(out_dir, "corner-v1.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    # human-readable training report (committed → documents the run)
    em = [e for (s, e) in errs.values() if s in ("easy", "moderate")]
    report = {
        "seed": SEED, "epochs": EPOCHS, "augPerBase": AUG_PER_BASE, "lr": LR,
        "bases": [b["name"] for b in bases],
        "blobBytes": len(blob),
        "evalGoldCornerError": {name: {"stratum": s, "error": round(e, 4)} for name, (s, e) in errs.items()},
        "easyModerateMeanCornerError": round(float(np.mean(em)), 4) if em else None,
        "trainSeconds": round(secs, 1),
    }
    with open(os.path.join(HERE, "train-report.json"), "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(f"\nwrote src/models/corner-v1.{{bin,json}}  ({len(blob)} B)  in {secs:.0f}s")
    print(f"  reference output: [{', '.join(f'{v:.4f}' for v in ref_out)}]")
    if em:
        print(f"  easy+moderate mean corner-error: {np.mean(em):.4f}")


if __name__ == "__main__":
    main()
