import io
import os
import time
import zipfile
from collections import defaultdict, deque
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

APP_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "10")) * 1024 * 1024
MAX_PIXELS = int(os.getenv("MAX_IMAGE_PIXELS", "8000000"))
RATE_LIMIT_COUNT = int(os.getenv("RATE_LIMIT_COUNT", "8"))
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "3600"))
MAX_WEB_SIDE = int(os.getenv("WEB_MAX_SIDE", "1800"))

app = FastAPI(
    title="City Sofal Reflection Retoucher",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
)
app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")

# Lightweight in-memory rate limiter. Resets on restart; suitable for a small public beta.
_request_log = defaultdict(deque)


def check_rate_limit(request: Request):
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[-1].strip() if forwarded else (request.client.host if request.client else "unknown")
    now = time.time()
    q = _request_log[ip]
    while q and now - q[0] > RATE_LIMIT_WINDOW:
        q.popleft()
    if len(q) >= RATE_LIMIT_COUNT:
        raise HTTPException(status_code=429, detail="سهمیه پردازش این IP فعلاً تمام شده است. کمی بعد دوباره تلاش کنید.")
    q.append(now)


def decode_image(data: bytes) -> np.ndarray:
    if not data:
        raise HTTPException(400, "فایل تصویر خالی است.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"حجم فایل باید کمتر از {MAX_UPLOAD_BYTES // (1024*1024)} مگابایت باشد.")
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            if im.width * im.height > MAX_PIXELS:
                raise HTTPException(413, f"ابعاد تصویر بیش از حد مجاز است؛ حداکثر {MAX_PIXELS:,} پیکسل.")
            arr = np.asarray(im)
        return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "فایل تصویر معتبر یا پشتیبانی‌شده نیست.")


def decode_mask(data: bytes, shape, name: str) -> np.ndarray:
    h, w = shape[:2]
    try:
        with Image.open(io.BytesIO(data)) as im:
            mask = np.asarray(im.convert("L"))
    except Exception:
        raise HTTPException(400, f"ماسک {name} معتبر نیست.")
    if mask.shape != (h, w):
        raise HTTPException(400, f"ابعاد ماسک {name} با عکس اصلی برابر نیست.")
    return mask


def encode_image(image: np.ndarray, fmt: str, quality: int = 92) -> bytes:
    if fmt == "png":
        ok, encoded = cv2.imencode(".png", image, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    elif fmt == "webp":
        ok, encoded = cv2.imencode(".webp", image, [cv2.IMWRITE_WEBP_QUALITY, quality])
    else:
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise HTTPException(500, "ساخت فایل خروجی ناموفق بود.")
    return encoded.tobytes()


def apply_inpainting(image, remove_mask, protect_mask, method, radius, auto_protect):
    mask = remove_mask.copy()
    mask[protect_mask > 0] = 0

    if auto_protect:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        # Conservative highlight protection: very bright, low-saturation pixels only.
        highlight = (hsv[:, :, 2] >= 247) & (hsv[:, :, 1] <= 65)
        mask[highlight] = 0

    if not np.any(mask):
        raise HTTPException(400, "ناحیه‌ای برای اصلاح انتخاب نشده است.")

    repaired = None
    # Optional local AI stage. Disabled by default because LaMa can exceed
    # Render Free's memory budget. Enable only on a machine with sufficient RAM.
    if os.getenv("ENABLE_LAMA", "false").lower() in {"1", "true", "yes"}:
        try:
            from simple_lama_inpainting import SimpleLama
            from PIL import Image
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            lama_image = Image.fromarray(rgb)
            lama_mask = Image.fromarray(mask).convert("L")
            ai_result = SimpleLama()(lama_image, lama_mask)
            repaired = cv2.cvtColor(np.asarray(ai_result.convert("RGB")), cv2.COLOR_RGB2BGR)
        except Exception:
            # Graceful fallback to OpenCV if optional model/dependencies fail.
            repaired = None

    if repaired is None:
        flag = cv2.INPAINT_TELEA if method.lower() == "telea" else cv2.INPAINT_NS
        repaired = cv2.inpaint(image, mask, float(np.clip(radius, 1, 8)), flag)

    # Feather the transition only inside the selected mask; outside pixels stay exact.
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 1.0)
    alpha = np.clip(alpha, 0.0, 1.0)
    alpha[mask == 0] = 0.0
    alpha = alpha[:, :, None]
    result = (repaired.astype(np.float32) * alpha +
              image.astype(np.float32) * (1.0 - alpha)).clip(0, 255).astype(np.uint8)
    result[mask == 0] = image[mask == 0]
    return result


def make_web_version(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    scale = min(1.0, MAX_WEB_SIDE / max(h, w))
    if scale < 1.0:
        image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return image


@app.get("/", response_class=HTMLResponse)
async def home():
    with open(os.path.join(APP_DIR, "static", "index.html"), "r", encoding="utf-8") as f:
        return f.read()


@app.get("/healthz")
async def health():
    return {"status": "ok", "service": "city-sofal-reflection-retoucher"}


@app.post("/api/process")
async def process_image(
    request: Request,
    image: UploadFile = File(...),
    remove_mask: UploadFile = File(...),
    protect_mask: UploadFile = File(...),
    method: str = Form("telea"),
    radius: float = Form(3.0),
    auto_protect: bool = Form(True),
    output_mode: str = Form("original"),
    quality: int = Form(92),
):
    check_rate_limit(request)
    if output_mode not in {"original", "web", "both"}:
        raise HTTPException(400, "حالت خروجی نامعتبر است.")
    if method.lower() not in {"telea", "ns"}:
        raise HTTPException(400, "روش پردازش نامعتبر است.")

    image_data = await image.read(MAX_UPLOAD_BYTES + 1)
    remove_data = await remove_mask.read(MAX_UPLOAD_BYTES + 1)
    protect_data = await protect_mask.read(MAX_UPLOAD_BYTES + 1)

    original = decode_image(image_data)
    h, w = original.shape[:2]
    remove = decode_mask(remove_data, (h, w), "حذف انعکاس")
    protect = decode_mask(protect_data, (h, w), "محافظت")

    result = apply_inpainting(original, remove, protect, method, radius, auto_protect)
    quality = int(np.clip(quality, 60, 100))

    if output_mode == "original":
        data = encode_image(result, "png")
        return Response(
            content=data,
            media_type="image/png",
            headers={"Content-Disposition": 'attachment; filename="citysofal-retouched-original.png"'}
        )

    if output_mode == "web":
        web_image = make_web_version(result)
        data = encode_image(web_image, "webp", quality)
        return Response(
            content=data,
            media_type="image/webp",
            headers={"Content-Disposition": 'attachment; filename="citysofal-retouched-web.webp"'}
        )

    # Both: package the untouched-dimension PNG and optimized WebP together.
    web_image = make_web_version(result)
    original_bytes = encode_image(result, "png")
    web_bytes = encode_image(web_image, "webp", quality)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        archive.writestr("citysofal-retouched-original.png", original_bytes)
        archive.writestr("citysofal-retouched-web.webp", web_bytes)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="citysofal-outputs.zip"'}
    )
