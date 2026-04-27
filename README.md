# AutoGrok Veo3 — Grok Image Generation (Cần Fix)

## ❌ Vấn đề chính cần fix

### 1. Chỉ sinh 1 ảnh thay vì 4
- Config đặt `imageGenerationCount: 4` nhưng Grok API chỉ trả về **1 imageUuid** (xem `debug/parseResult_*.json`)
- Cần tìm cách để Grok trả về đúng số lượng ảnh yêu cầu

### 2. Ảnh bị blur 25KB (moderation)
- Với prompt NSFW, server trả `moderated: true` và ảnh bị blur thành ~25KB thumbnail
- Cần tìm cách lấy ảnh full-res trước khi server apply blur
- Trên grok.com web thì ảnh hiện rõ, nhưng download qua API thì bị blur

---

## 📁 Cấu trúc code

```
resources/app/
├── electron/
│   ├── main.js          # ⭐ Electron main process, IPC handlers (image:generate ở dòng 590)
│   ├── preload.js       # Bridge giữa renderer và main
│   └── autoUpdater.js   # Auto update
├── dist/
│   ├── index.html       # React frontend (đã build)
│   └── renderer.js      # React bundle (đã build)
├── src/
│   ├── services/
│   │   ├── ImageService.js   # ⭐⭐⭐ FILE CHÍNH CẦN SỬA
│   │   ├── AuthService.js    # Login & session management (puppeteer)
│   │   ├── VideoService.js   # Video generation
│   │   ├── I2VService.js     # Image-to-Video
│   │   ├── RefImageService.js # Reference image generation
│   │   ├── FileService.js    # File save/load
│   │   ├── AccountService.js # Account CRUD
│   │   └── LicenseService.js # License (bypassed)
│   ├── config/
│   │   └── app.config.js     # ⭐ Config (API URLs, imageGenerationCount, batch size)
│   ├── gen-image.js          # ⭐ Original working browser-context gen (tham khảo)
│   ├── gen-image-axios.js    # Axios-based gen (cũ)
│   ├── gen-video.js          # Video gen
│   ├── gen-video-axios.js    # Video gen axios
│   ├── gen-i2v-axios.js      # I2V gen
│   ├── browser.js            # Puppeteer browser setup
│   ├── config.js             # Legacy config
│   ├── prompts.js            # Prompt templates
│   └── utils.js              # Utilities
├── debug/                    # ⭐ API response samples (xem bên dưới)
├── package.json
└── test-fix.js               # Test script
```

---

## 🔑 Files quan trọng nhất

### `ImageService.js` — Logic chính
- `buildBody()` (dòng 46): Tạo request body gửi Grok API
- `generateViaBrowser()` (dòng 103): Generate qua browser context (puppeteer page)
- `generateOne()` (dòng 391): Generate 1 ảnh (browser → axios fallback)
- `generateBatch()` (dòng 931): Batch generate nhiều prompt
- `parseResponse()` (dòng 619): Parse NDJSON response từ Grok
- `downloadImage()` (dòng 778): Download ảnh qua axios
- `downloadViaBrowser()` (dòng 863): Download ảnh qua browser session

### `gen-image.js` — Code gốc (hoạt động tốt)
- Chạy trực tiếp trong browser context (page.evaluate)
- **Quan trọng**: Đây là code gốc của app, nó hoạt động — nhưng chỉ dùng `streamingImageGenerationResponse` format cũ

### `app.config.js` — Config
- `IMAGE_CONFIG.imageGenerationCount: 4` — số ảnh mong muốn
- `API_ENDPOINTS.API_URL`: `https://grok.com/rest/app-chat/conversations/new`
- `API_ENDPOINTS.ASSETS_BASE_URL`: `https://assets.grok.com/`

---

## 📡 Grok API Format

### Request
```
POST https://grok.com/rest/app-chat/conversations/new
Content-Type: application/json
Cookie: [session cookies từ puppeteer login]
```

### Response (NDJSON — mỗi dòng là 1 JSON object)

**Dòng quan trọng — image_chunk trong cardAttachment:**
```json
{
  "result": {
    "response": {
      "cardAttachment": {
        "jsonData": "{\"image_chunk\":{\"imageUuid\":\"UUID\",\"imageUrl\":\"users/.../generated/UUID-part-0/image.jpg\",\"seq\":0,\"progress\":50,\"imageIndex\":0}}"
      }
    }
  }
}
```

**Khi hoàn thành (progress=100):**
```json
{
  "image_chunk": {
    "imageUuid": "48b432d3-...",
    "imageUrl": "users/.../generated/48b432d3-.../image.jpg",
    "seq": 1,
    "progress": 100,
    "moderated": false,
    "imageIndex": 0,
    "rRated": false
  }
}
```

### URL Pattern
- **Part-0 (preview)**: `users/{userId}/generated/{imageUuid}-part-0/image.jpg`
- **Final**: `users/{userId}/generated/{imageUuid}/image.jpg`
- **CDN**: `https://assets.grok.com/{path}`
- **REST**: `https://grok.com/rest/app-chat/asset/{path}`

### Khi bị moderation
```json
{
  "image_chunk": {
    "progress": 100,
    "moderated": true,   // ← server sẽ blur ảnh
    "rRated": true
  }
}
```

---

## 🐛 Debug Samples (trong thư mục `debug/`)

### `parseResult_*.json` — Kết quả parse
- `imageChunkMapSize: 1` ← luôn chỉ có 1, dù request 4
- `imageUrlsCount: 1`
- `imageBase64Count: 0`

### `response_*.txt` — Raw API response
- Dòng đầu: `HTTP 200`
- Các dòng sau: NDJSON (mỗi dòng 1 JSON)
- Chứa toàn bộ stream response từ Grok

### `dl_*.json` — Download result
```json
{"url":"generated/...-part-0/image.jpg","status":200,"bytes":25360,"contentType":"image/jpeg"}
```
→ 25KB = ảnh bị blur!

---

## ⚙️ Cách chạy

1. Đây là Electron app đã build (cần file .exe + dll để chạy)
2. Source code nằm trong `resources/app/` — sửa trực tiếp, restart app
3. Login tài khoản qua UI → Setup Accounts → nhập email|password

---

## 💡 Hướng fix đề xuất

1. **Multi-image**: Thử thay đổi `buildBody()` params — hiện đã thử align với `gen-image.js` gốc nhưng vẫn chỉ được 1 ảnh
2. **Anti-blur**: Race download từ nhiều URL variants ngay khi `progress=50` xuất hiện (trước khi moderation apply)
3. **Browser-based**: Dùng `page.evaluate()` fetch ảnh trong browser context (same session như grok.com web)
4. **Base64 capture**: Intercept base64 image data từ streaming response trước khi server flag moderation
