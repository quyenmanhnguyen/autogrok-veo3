const axios = require('axios');
const crypto = require('crypto');
const { API_ENDPOINTS, MODEL_CONFIG, IMAGE_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const path = require('path');

/**
 * RefImageService — Generate images using reference images (imagine-image-edit model)
 * Flow: upload ref images → post/create → post/folders → conversations/new
 */
class RefImageService {
    constructor() {
        this.activeJobs = new Map();
    }

    formatCookies(cookies) {
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    buildHeaders(capturedHeaders, cookieStr, referer = null) {
        const headers = {};
        for (const [k, v] of Object.entries(capturedHeaders)) {
            if (!k.startsWith(':')) headers[k] = v;
        }
        headers['content-type'] = 'application/json';
        headers['x-xai-request-id'] = crypto.randomUUID();
        headers['cookie'] = cookieStr;
        if (referer) headers['referer'] = referer;
        delete headers['host'];
        delete headers['content-length'];
        return headers;
    }

    /**
     * Parse ref image "name" from filename: girl_model.png → "girl model"
     */
    static parseRefImageName(filePath) {
        const basename = path.basename(filePath, path.extname(filePath));
        return basename.replace(/_/g, ' ').toLowerCase().trim();
    }

    /**
     * Match ref images to a prompt by name.
     * Returns up to 3 matched ref image paths.
     */
    static matchRefImages(prompt, refImages) {
        const promptLower = prompt.toLowerCase();
        const matched = refImages.filter(ref => promptLower.includes(ref.name));
        return matched.slice(0, 3);
    }

    /**
     * Upload a single image file to Grok
     */
    async uploadFile(imagePath, session) {
        try {
            const fileBuffer = FileService.readFile(imagePath);
            const base64Content = fileBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase().replace('.', '');
            const mimeMap = {
                jpg: 'image/jpeg', jpeg: 'image/jpeg',
                png: 'image/png', webp: 'image/webp', gif: 'image/gif',
            };
            const fileMimeType = mimeMap[ext] || 'image/jpeg';
            const fileName = `${crypto.randomUUID()}.${ext === 'jpg' ? 'jpeg' : ext}`;

            const cookieStr = this.formatCookies(session.cookies);
            const res = await axios.post(
                API_ENDPOINTS.UPLOAD_URL,
                { fileName, fileMimeType, content: base64Content, fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE' },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 60000,
                }
            );

            if (res.status !== 200) {
                return { error: `upload HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }

            const fileMetadataId = res.data?.fileMetadataId;
            const fileUri = res.data?.fileUri;
            if (!fileMetadataId) {
                return { error: 'no fileMetadataId', errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }

            console.log(`[RefImageService] ✅ Upload OK: ${fileMetadataId}`);
            return { fileMetadataId, fileUri, uploadResponse: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Create media post for an uploaded image
     */
    async createMediaPost(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);
        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_CREATE_URL,
                { mediaType: 'MEDIA_POST_TYPE_IMAGE', mediaUrl: imageUrl },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 30000,
                }
            );
            if (res.status !== 200) {
                return { error: `post/create HTTP ${res.status}`, errorDetail: JSON.stringify(res.data).substring(0, 500) };
            }
            const postId = res.data?.post?.id;
            console.log(`[RefImageService] ✅ post/create OK: postId=${postId}`);
            return { postId, postData: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Create post folder (required after all ref images are uploaded)
     */
    async createPostFolder(postId, session) {
        const cookieStr = this.formatCookies(session.cookies);
        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_FOLDERS_URL,
                { postId },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 30000,
                }
            );
            if (res.status !== 200) {
                console.log(`[RefImageService] ⚠️ post/folders HTTP ${res.status} (non-critical)`);
            } else {
                console.log(`[RefImageService] ✅ post/folders OK`);
            }
            return { success: res.status === 200, data: res.data };
        } catch (error) {
            console.log(`[RefImageService] ⚠️ post/folders error: ${error.message} (non-critical)`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Upload all ref images and create media posts.
     * Returns { imageUrls, parentPostId } or { error }
     */
    async uploadRefImages(imagePaths, session) {
        const imageUrls = [];
        let lastPostId = null;

        for (let i = 0; i < imagePaths.length; i++) {
            const imgPath = imagePaths[i];
            console.log(`[RefImageService] 📤 Uploading ref ${i + 1}/${imagePaths.length}: ${path.basename(imgPath)}`);

            // Step 1: Upload
            const upload = await this.uploadFile(imgPath, session);
            if (upload.error) {
                return { error: `Upload ref ${i + 1} failed: ${upload.error}` };
            }

            const imageUrl = upload.fileUri ? `${API_ENDPOINTS.ASSETS_BASE_URL}${upload.fileUri}` : null;
            if (!imageUrl) {
                return { error: `No fileUri for ref ${i + 1}` };
            }

            // Step 2: Create media post
            const post = await this.createMediaPost(imageUrl, session);
            if (post.error) {
                return { error: `Post/create ref ${i + 1} failed: ${post.error}` };
            }

            imageUrls.push(imageUrl);
            lastPostId = post.postId;
        }

        // Step 3: Create post folder with last postId
        if (lastPostId) {
            await this.createPostFolder(lastPostId, session);
        }

        return { imageUrls, parentPostId: lastPostId };
    }

    /**
     * Build request body for ref image generation (imagine-image-edit model)
     */
    buildRefImageBody(prompt, imageUrls, parentPostId) {
        return {
            temporary: true,
            modelName: MODEL_CONFIG.REF_IMAGE_MODEL,
            message: prompt,
            enableImageGeneration: true,
            returnImageBytes: false,
            returnRawGrokInXaiRequest: false,
            enableImageStreaming: true,
            imageGenerationCount: 2,
            forceConcise: false,
            toolOverrides: { imageGen: true },
            enableSideBySide: true,
            sendFinalMetadata: true,
            isReasoning: false,
            disableTextFollowUps: true,
            responseMetadata: {
                modelConfigOverride: {
                    modelMap: {
                        imageEditModelConfig: {
                            imageReferences: imageUrls,
                            parentPostId: parentPostId,
                        },
                        imageEditModel: 'imagine',
                    },
                },
            },
            disableMemory: false,
            forceSideBySide: false,
        };
    }

    /**
     * Parse NDJSON response (same as ImageService)
     */
    parseResponse(text, status) {
        const result = {
            title: '',
            imageUrls: [],
            imageBase64: [],
            error: null,
            errorDetail: null,
            status: status,
        };

        const lines = text.split('\n').filter(l => l.trim());
        const errorMessages = [];

        for (const line of lines) {
            try {
                const j = JSON.parse(line);
                if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                if (j.error) {
                    errorMessages.push(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
                }
                if (j.result?.error) {
                    errorMessages.push(typeof j.result.error === 'string' ? j.result.error : j.result.error.message || JSON.stringify(j.result.error));
                }

                const mr = j.result?.response?.modelResponse;
                if (mr?.error) {
                    errorMessages.push(typeof mr.error === 'string' ? mr.error : mr.error.message || JSON.stringify(mr.error));
                }
                if (mr?.isSoftBlock || mr?.isDisallowed) {
                    errorMessages.push(`Content blocked: softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed}`);
                }

                // Collect image URLs from streaming response
                const ir = j.result?.response?.streamingImageGenerationResponse;
                if (ir && ir.progress === 100 && ir.imageUrl) {
                    result.imageUrls.push({ imageUrl: ir.imageUrl, imageIndex: ir.imageIndex });
                }
                if (ir && ir.imageBytes) {
                    result.imageBase64.push({ data: ir.imageBytes, imageIndex: ir.imageIndex || result.imageBase64.length });
                }

                // Fallback: collect from modelResponse
                if (mr?.generatedImageUrls?.length > 0 && result.imageUrls.length === 0) {
                    mr.generatedImageUrls.forEach((u, i) =>
                        result.imageUrls.push({ imageUrl: u, imageIndex: i })
                    );
                }

                // Collect base64 data URIs from tokens
                const token = j.result?.response?.token;
                if (typeof token === 'string' && token.includes('data:image/')) {
                    const matches = token.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (matches) {
                        for (const m of matches) {
                            result.imageBase64.push({ data: m, imageIndex: result.imageBase64.length });
                        }
                    }
                }
            } catch (_) {
                if (line.includes('data:image/')) {
                    const matches = line.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g);
                    if (matches) {
                        for (const m of matches) {
                            result.imageBase64.push({ data: m, imageIndex: result.imageBase64.length });
                        }
                    }
                }
            }
        }

        const totalImages = result.imageUrls.length + result.imageBase64.length;
        if (totalImages === 0) {
            result.error = status !== 200 ? `HTTP ${status}` : errorMessages.length > 0 ? errorMessages.join(' | ') : 'no images returned';
            result.errorDetail = text.substring(0, 500);
        }

        return result;
    }

    /**
     * Download image from URL
     */
    async downloadImage(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        try {
            const url = imageUrl.startsWith('http') ? imageUrl : `${API_ENDPOINTS.ASSETS_BASE_URL}${imageUrl}`;
            const res = await axios.get(url, {
                headers: dlHeaders,
                responseType: 'arraybuffer',
                timeout: 30000,
                validateStatus: () => true,
            });
            if (res.status === 200) {
                return { data: Buffer.from(res.data), size: res.data.byteLength, contentType: res.headers['content-type'] };
            }
        } catch (_) { }
        return null;
    }

    /**
     * Generate one image with ref images
     * @param {Object} item - { prompt, refImagePaths: [path1, path2, ...] }
     */
    async generateOne(item, session, config = {}, onProgress = null) {
        const { prompt, refImagePaths } = item;
        const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Step 1: Upload all ref images
                console.log(`[RefImageService] 📤 Uploading ${refImagePaths.length} ref image(s)...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
                const uploadResult = await this.uploadRefImages(refImagePaths, session);

                // Handle 403 from upload/createMediaPost — re-login and retry
                if (uploadResult.error && uploadResult.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[RefImageService] ⚠️ 403 during upload for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[RefImageService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { imageUrls: [], imageBase64: [], error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}`, status: 403 };
                    }
                }

                if (uploadResult.error) {
                    return { imageUrls: [], imageBase64: [], error: uploadResult.error, status: 0 };
                }

                // Step 2: Generate with ref images
                console.log(`[RefImageService] 🎨 Generating with ${uploadResult.imageUrls.length} ref(s): ${prompt.substring(0, 50)}...`);
                const cookieStr = this.formatCookies(session.cookies);
                const body = this.buildRefImageBody(prompt, uploadResult.imageUrls, uploadResult.parentPostId);

                const res = await axios.post(
                    API_ENDPOINTS.API_URL,
                    body,
                    {
                        headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                        responseType: 'text',
                        validateStatus: () => true,
                        timeout: 120000,
                    }
                );

                // Handle 429 rate limit
                if (res.status === 429 && attempt < MAX_RETRIES) {
                    const wait = PROCESSING_CONFIG.RETRY_DELAY + Math.random() * 5000;
                    console.log(`[RefImageService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s...`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }

                // Handle 403 — session expired, re-login this account only
                if (res.status === 403 && attempt < MAX_RETRIES) {
                    console.warn(`[RefImageService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[RefImageService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { imageUrls: [], imageBase64: [], error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}`, status: 403 };
                    }
                }

                const result = this.parseResponse(res.data, res.status);

                if ((result.imageUrls.length > 0 || result.imageBase64.length > 0) && onProgress) {
                    onProgress({ progress: 100, status: 'completed' });
                }

                return result;
            } catch (error) {
                if (attempt < MAX_RETRIES) {
                    console.error(`[RefImageService] Error, retrying (${attempt + 1}/${MAX_RETRIES}):`, error.message);
                    await new Promise(resolve => setTimeout(resolve, PROCESSING_CONFIG.RETRY_DELAY));
                    continue;
                }
                return { imageUrls: [], imageBase64: [], error: error.message, status: 0 };
            }
        }
    }

    /**
     * Generate images with ref images (concurrent worker pool)
     * @param {Array<Object>} items - [{ prompt, refImagePaths: [...] }]
     */
    async generateBatch(items, session, config = {}, onProgress = null, startIdx = 0) {
        const N = items.length;
        // Lower concurrency for ref image (upload overhead)
        const CONCURRENCY = Math.min(config.batchSize || PROCESSING_CONFIG.CONCURRENCY.I2V || 5, N);
        const outputFolder = config.outputFolder || PATHS.IMAGE_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[RefImageService] [${label}] ${N} ref-image items | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

        const results = [];
        let nextIdx = 0;
        const self = this;

        async function worker() {
            while (nextIdx < N) {
                const myIdx = nextIdx++;
                const item = items[myIdx];
                const globalNum = startIdx + myIdx + 1;

                console.log(`[RefImageService] [${label}] 🖼️✨ #${myIdx + 1}/${N} (shot${String(globalNum).padStart(4, '0')}) refs=${item.refImagePaths.length} | ${item.prompt.substring(0, 50)}...`);

                const result = await self.generateOne(item, session, config, (prog) => {
                    if (onProgress) onProgress(item.prompt, prog.progress, null, myIdx);
                });

                // Save images
                const savedFiles = [];
                const shotNum = String(globalNum).padStart(4, '0');
                const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);

                // Save base64 images
                if (result.imageBase64 && result.imageBase64.length > 0) {
                    for (const img of result.imageBase64) {
                        try {
                            let base64Data = img.data;
                            let ext = 'png';
                            if (base64Data.startsWith('data:image/')) {
                                const match = base64Data.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
                                if (match) {
                                    ext = match[1] === 'jpeg' ? 'jpg' : match[1];
                                    base64Data = base64Data.substring(match[0].length);
                                }
                            }
                            const buffer = Buffer.from(base64Data, 'base64');
                            const filename = titleSlug
                                ? `ref_shot${shotNum}_${titleSlug}_i${img.imageIndex || 0}.${ext}`
                                : `ref_shot${shotNum}_i${img.imageIndex || 0}.${ext}`;
                            const filePath = FileService.saveFile(buffer, filename, outputFolder);
                            savedFiles.push(filePath);
                            console.log(`[RefImageService] [${label}] 💾 Saved: ${filename} (${buffer.length} bytes)`);
                        } catch (error) {
                            console.error(`[RefImageService] [${label}] Base64 save error:`, error.message);
                        }
                    }
                }

                // Download images from URLs (fallback)
                if (result.imageUrls && result.imageUrls.length > 0 && savedFiles.length === 0) {
                    for (const img of result.imageUrls) {
                        try {
                            const dl = await self.downloadImage(img.imageUrl, session);
                            if (dl) {
                                const ext = dl.contentType?.includes('png') ? 'png' : 'jpg';
                                const filename = titleSlug
                                    ? `ref_shot${shotNum}_${titleSlug}_i${img.imageIndex || 0}.${ext}`
                                    : `ref_shot${shotNum}_i${img.imageIndex || 0}.${ext}`;
                                const filePath = FileService.saveFile(dl.data, filename, outputFolder);
                                savedFiles.push(filePath);
                            }
                        } catch (error) {
                            console.error(`[RefImageService] [${label}] Download error:`, error.message);
                        }
                    }
                }

                const jobResult = {
                    prompt: item.prompt,
                    localIdx: myIdx,
                    title: result.title,
                    savedFiles,
                    outputPath: savedFiles.length > 0 ? savedFiles[0] : null,
                    success: savedFiles.length > 0,
                    error: result.error,
                };

                results.push(jobResult);

                if (onProgress) {
                    onProgress(item.prompt, 100, jobResult, myIdx);
                }

                console.log(`[RefImageService] [${label}] #${myIdx + 1}/${N} ${savedFiles.length > 0 ? '✅' : '❌'} ${result.title || item.prompt.substring(0, 50)}`);
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
            workers.push(
                new Promise((resolve) => setTimeout(() => resolve(worker()), i * 200))
            );
        }
        await Promise.all(workers);

        console.log(`[RefImageService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
        return results;
    }
}

// Export singleton instance
module.exports = new RefImageService();
