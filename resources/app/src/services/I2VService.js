const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { API_ENDPOINTS, MODEL_CONFIG, I2V_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');
const path = require('path');

class I2VService {
    constructor() {
        this.activeJobs = new Map();
        this._cancelled = false;
    }

    cancelAll() {
        this._cancelled = true;
        console.log('[I2VService] ⛔ Cancel requested');
    }

    resetCancel() {
        this._cancelled = false;
    }

    /**
     * Format cookies for headers
     */
    formatCookies(cookies) {
        return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Build request headers with optional referer
     */
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
     * Upload image file
     * @param {string} imagePath - Path to image file
     * @param {Object} session - Session data
     * @returns {Promise<Object>} {fileMetadataId, fileUri} or {error}
     */
    async uploadFile(imagePath, session) {
        try {
            const fileBuffer = FileService.readFile(imagePath);
            const base64Content = fileBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase().replace('.', '');
            const mimeMap = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                webp: 'image/webp',
                gif: 'image/gif',
            };
            const fileMimeType = mimeMap[ext] || 'image/jpeg';
            const fileName = `${crypto.randomUUID()}.${ext === 'jpg' ? 'jpeg' : ext}`;

            const cookieStr = this.formatCookies(session.cookies);

            const res = await axios.post(
                API_ENDPOINTS.UPLOAD_URL,
                {
                    fileName,
                    fileMimeType,
                    content: base64Content,
                    fileSource: 'IMAGINE_SELF_UPLOAD_FILE_SOURCE',
                },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 60000,
                }
            );

            if (res.status !== 200) {
                return {
                    error: `upload HTTP ${res.status}`,
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            const fileMetadataId = res.data?.fileMetadataId;
            const fileUri = res.data?.fileUri;

            if (!fileMetadataId) {
                return {
                    error: 'no fileMetadataId',
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            console.log(`[I2VService] ✅ Upload OK: ${fileMetadataId}`);
            return { fileMetadataId, fileUri, uploadResponse: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Create media post (CRITICAL step for I2V)
     * @param {string} imageUrl - Full image URL
     * @param {Object} session - Session data
     * @returns {Promise<Object>} {postId} or {error}
     */
    async createMediaPost(imageUrl, session) {
        const cookieStr = this.formatCookies(session.cookies);

        try {
            const res = await axios.post(
                API_ENDPOINTS.POST_CREATE_URL,
                {
                    mediaType: 'MEDIA_POST_TYPE_IMAGE',
                    mediaUrl: imageUrl,
                },
                {
                    headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                    validateStatus: () => true,
                    timeout: 30000,
                }
            );

            if (res.status !== 200) {
                return {
                    error: `post/create HTTP ${res.status}`,
                    errorDetail: JSON.stringify(res.data).substring(0, 500),
                };
            }

            const postId = res.data?.post?.id;
            console.log(`[I2VService] ✅ post/create OK: postId=${postId}`);
            return { postId, postData: res.data };
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Build I2V generation request body
     * @param {string} prompt - Video prompt
     * @param {string} fileMetadataId - File metadata ID from upload
     * @param {string} imageUrl - Full image URL
     * @param {Object} config - I2V configuration (from UI or I2V_CONFIG)
     * @returns {Object} Request body
     */
    buildI2VBody(prompt, fileMetadataId, imageUrl, config = {}) {
        // Merge UI config with I2V_CONFIG defaults, map field names
        // Validate values are within I2V-allowed options (reject leaked VIDEO_CONFIG values)
        const validLength = config.videoLength && I2V_CONFIG.lengthOptions.includes(Number(config.videoLength))
            ? Number(config.videoLength) : I2V_CONFIG.videoLength;
        const validResolution = (config.resolutionName || config.resolution) && I2V_CONFIG.resolutionOptions.includes(config.resolutionName || config.resolution)
            ? (config.resolutionName || config.resolution) : I2V_CONFIG.resolutionName;
        const validAspect = config.aspectRatio && I2V_CONFIG.aspectRatioOptions.includes(config.aspectRatio)
            ? config.aspectRatio : I2V_CONFIG.aspectRatio;
        const mergedConfig = {
            aspectRatio: validAspect,
            videoLength: validLength,
            isVideoEdit: config.isVideoEdit !== undefined ? config.isVideoEdit : I2V_CONFIG.isVideoEdit,
            resolutionName: validResolution,
        };

        // `--mode=<mode>` controls how strict moderation is. "custom" matches the
        // legacy app behaviour; "spicy" is the bolder/less-filtered preset that
        // grok.com web exposes for adult-oriented generation. UI/config can
        // override this; generateOne() also retries with `moderationRetryMode`
        // when the first attempt is fully blocked.
        const allowedModes = I2V_CONFIG.modeOptions || ['custom', 'fun', 'normal', 'spicy'];
        const mode = allowedModes.includes(config.mode) ? config.mode : (I2V_CONFIG.mode || 'custom');

        console.log(`[I2VService] buildI2VBody config: aspectRatio=${mergedConfig.aspectRatio}, videoLength=${mergedConfig.videoLength}, resolution=${mergedConfig.resolutionName}, mode=${mode}`);

        const fileMetadataIds = Array.isArray(fileMetadataId) ? fileMetadataId.filter(Boolean) : [fileMetadataId].filter(Boolean);
        const imageUrls = Array.isArray(imageUrl) ? imageUrl.filter(Boolean) : [imageUrl].filter(Boolean);
        const imagePrefix = imageUrls.length ? `${imageUrls.join('  ')}  ` : '';
        const message = `${imagePrefix}${prompt} --mode=${mode}`;

        return {
            temporary: true,
            modelName: MODEL_CONFIG.I2V_MODEL,
            message,
            fileAttachments: fileMetadataIds,
            toolOverrides: { videoGen: true },
            enableSideBySide: true,
            responseMetadata: {
                experiments: [],
                modelConfigOverride: {
                    modelMap: {
                        videoGenModelConfig: {
                            parentPostId: fileMetadataIds[0],
                            aspectRatio: mergedConfig.aspectRatio,
                            videoLength: mergedConfig.videoLength,
                            isVideoEdit: mergedConfig.isVideoEdit,
                            resolutionName: mergedConfig.resolutionName,
                        },
                    },
                },
            },
        };
    }

    /**
     * Parse streaming I2V response
     * @param {AsyncIterable} stream - Response stream
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} Parsed result
     */
    async parseStreamResponse(stream, onProgress = null) {
        const result = {
            title: '',
            videoUrl: null,
            videoId: null,
            userId: null,
            progress: 0,
            error: null,
            // Multi-candidate side-by-side support — Grok web returns 2 videos
            // per request when `enableSideBySide` is true. We track each
            // candidate by `videoId` (or `assetId`) so the generator can save
            // every variant to disk instead of clobbering the URL on each chunk.
            candidates: [],
            allVideoUrls: [],
        };
        const candidatesByKey = new Map(); // key (videoId/assetId) -> candidate state

        let buffer = '';
        let lastLog = 0;
        let lastProgressTime = Date.now();
        const STALL_TIMEOUT_MS = 90000; // 90s stall → abort
        let aborted = false;
        let moderationBlockCount = 0; // Track how many side-by-side candidates were blocked

        // Wrap stream iteration with stall detection
        const iterateWithTimeout = async () => {
            for await (const chunk of stream) {
                const now = Date.now();
                const chunkStr = chunk.toString();
                buffer += chunkStr;

                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const j = JSON.parse(line);
                        if (j.result?.title?.newTitle) result.title = j.result.title.newTitle;

                        // Errors
                        if (j.error) {
                            const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
                            if (!result.error) result.error = msg;
                        }
                        if (j.result?.error) {
                            const msg = typeof j.result.error === 'string' ? j.result.error : j.result.error.message || JSON.stringify(j.result.error);
                            if (!result.error) result.error = msg;
                        }

                        const mr = j.result?.response?.modelResponse;
                        if (mr?.error) {
                            const msg = typeof mr.error === 'string' ? mr.error : mr.error.message || JSON.stringify(mr.error);
                            if (!result.error) result.error = msg;
                        }
                        // Detect content moderation block — DON'T abort!
                        // With enableSideBySide=true, Grok generates 2 candidates.
                        // One may be blocked but the other can still succeed.
                        if (mr?.isSoftBlock || mr?.isDisallowed) {
                            moderationBlockCount++;
                            console.warn(`[I2VService] ⚠️ MODERATION flag #${moderationBlockCount} at ${result.progress}% — continuing stream (side-by-side may have another candidate)`);
                            // Only set error if no video URL found yet — will be cleared if a URL arrives later
                            if (!result.videoUrl && result.allVideoUrls.length === 0) {
                                result.error = `⛔ Content blocked by moderation (softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed})`;
                            }
                        }

                        // Video progress
                        const vr = j.result?.response?.streamingVideoGenerationResponse;
                        if (vr) {
                            // With enableSideBySide=true, the stream interleaves
                            // chunks for every candidate. Group by videoId/assetId
                            // so we can dedupe URLs and treat each candidate
                            // independently (one may be moderated while the
                            // other succeeds).
                            const candKey = vr.videoId || vr.assetId
                                || (vr.videoIndex != null ? `idx${vr.videoIndex}` : null)
                                || (vr.videoUrl ? `url:${vr.videoUrl}` : 'default');
                            let cand = candidatesByKey.get(candKey);
                            if (!cand) {
                                cand = { progress: 0 };
                                candidatesByKey.set(candKey, cand);
                            }
                            if (vr.videoId) cand.videoId = vr.videoId;
                            if (vr.assetId) cand.assetId = vr.assetId;
                            if (vr.videoIndex != null) cand.videoIndex = vr.videoIndex;
                            if (vr.imageReference) cand.imageReference = vr.imageReference;
                            if (typeof vr.progress === 'number' && vr.progress > (cand.progress || 0)) {
                                cand.progress = vr.progress;
                            }

                            // Keep top-level fields populated with the first/primary
                            // candidate so existing callers (UI, batch downloader)
                            // continue to work without modification.
                            if (vr.videoId) result.videoId = result.videoId || vr.videoId;
                            if (vr.assetId) result.videoId = result.videoId || vr.assetId;

                            // Extract userId from imageReference
                            if (vr.imageReference && !result.userId) {
                                const m = vr.imageReference.match(/\/users\/([^/]+)\//);
                                if (m) result.userId = m[1];
                            }

                            const newProgress = vr.progress || result.progress;
                            if (newProgress > result.progress) {
                                result.progress = newProgress;
                                lastProgressTime = now; // Reset stall timer on real progress
                                // Log every 20%
                                if (result.progress - lastLog >= 20) {
                                    console.log(`[I2VService] Progress: ${result.progress}%`);
                                    lastLog = result.progress;
                                    if (onProgress) onProgress({ progress: result.progress });
                                }
                            }

                            // DEBUG: dump full response when progress is high
                            if (result.progress >= 80) {
                                console.log(`[I2VService] DEBUG high-progress vr keys: ${Object.keys(vr).join(', ')}`);
                                console.log(`[I2VService] DEBUG vr.videoUrl=${vr.videoUrl}, vr.videoId=${vr.videoId}, vr.assetId=${vr.assetId}, vr.videoIndex=${vr.videoIndex}, vr.progress=${vr.progress}`);
                                if (vr.imageReference) console.log(`[I2VService] DEBUG vr.imageReference=${vr.imageReference}`);
                            }

                            if (vr.videoUrl) {
                                cand.videoUrl = vr.videoUrl;
                                if (!result.allVideoUrls.includes(vr.videoUrl)) {
                                    result.allVideoUrls.push(vr.videoUrl);
                                }
                                if (!result.videoUrl) result.videoUrl = vr.videoUrl;
                                // Clear any moderation error since we got a successful video
                                if (result.error && result.error.startsWith('⛔')) result.error = null;
                                console.log(`[I2VService] 🎉 Video ready! url=${vr.videoUrl.substring(0, 50)} (${result.allVideoUrls.length} unique URL(s), ${candidatesByKey.size} candidate(s))`);
                            }

                            if (vr.error) {
                                const msg = typeof vr.error === 'string' ? vr.error : vr.error.message || JSON.stringify(vr.error);
                                cand.error = cand.error || msg;
                                if (!result.error) result.error = msg;
                            }

                            // Check for moderation flags in video response — DON'T abort!
                            if (vr.isSoftBlock || vr.isDisallowed || vr.blocked) {
                                cand.moderated = true;
                                moderationBlockCount++;
                                console.warn(`[I2VService] ⚠️ Video moderation flag #${moderationBlockCount} at ${result.progress}% — continuing (side-by-side)`);
                                if (!result.videoUrl && result.allVideoUrls.length === 0) {
                                    result.error = `⛔ Video blocked by moderation at ${result.progress}%`;
                                }
                            }
                        }
                    } catch (_) {
                        // Ignore parse errors
                    }
                }

                // Stall detection: if progress stuck for too long, abort
                if (result.progress > 0 && result.progress < 100 && !result.videoUrl) {
                    const stallDuration = now - lastProgressTime;
                    if (stallDuration > STALL_TIMEOUT_MS) {
                        result.error = `⏱️ Generation stalled at ${result.progress}% for ${Math.round(stallDuration / 1000)}s — likely blocked by moderation`;
                        console.warn(`[I2VService] ⏱️ STALL TIMEOUT at ${result.progress}% (${Math.round(stallDuration / 1000)}s) — aborting`);
                        aborted = true;
                        try { stream.destroy && stream.destroy(); } catch (_) {}
                        return;
                    }
                }
            }
        };

        try {
            await iterateWithTimeout();
        } catch (err) {
            if (!aborted) {
                console.warn(`[I2VService] Stream error: ${err.message}`);
                if (!result.error) result.error = `Stream error: ${err.message}`;
            }
        }

        // Process remaining buffer
        if (buffer.trim() && !aborted) {
            try {
                const j = JSON.parse(buffer);
                const vr = j.result?.response?.streamingVideoGenerationResponse;
                if (vr) {
                    console.log(`[I2VService] DEBUG buffer vr keys: ${Object.keys(vr).join(', ')}, progress=${vr.progress}, videoUrl=${vr.videoUrl}, videoId=${vr.videoId}`);
                    result.progress = vr.progress || result.progress;
                    if (vr.videoUrl) {
                        const candKey = vr.videoId || vr.assetId
                            || (vr.videoIndex != null ? `idx${vr.videoIndex}` : null)
                            || `url:${vr.videoUrl}`;
                        let cand = candidatesByKey.get(candKey);
                        if (!cand) {
                            cand = { progress: vr.progress || 0 };
                            candidatesByKey.set(candKey, cand);
                        }
                        cand.videoUrl = vr.videoUrl;
                        if (vr.videoId) cand.videoId = vr.videoId;
                        if (vr.assetId) cand.assetId = vr.assetId;
                        if (vr.videoIndex != null) cand.videoIndex = vr.videoIndex;
                        if (!result.allVideoUrls.includes(vr.videoUrl)) {
                            result.allVideoUrls.push(vr.videoUrl);
                        }
                        if (!result.videoUrl) result.videoUrl = vr.videoUrl;
                        result.videoId = result.videoId || vr.videoId || vr.assetId;
                        // Clear moderation error since we got a video
                        if (result.error && result.error.startsWith('⛔')) result.error = null;
                    }
                }
            } catch (_) { }
        }

        // Materialize candidates list (sorted by videoIndex when present)
        result.candidates = Array.from(candidatesByKey.values())
            .filter(c => c.videoUrl || c.videoId || c.assetId)
            .sort((a, b) => {
                const ai = a.videoIndex != null ? a.videoIndex : 99;
                const bi = b.videoIndex != null ? b.videoIndex : 99;
                return ai - bi;
            });
        result.moderationBlockCount = moderationBlockCount;
        console.log(`[I2VService] DEBUG final state: progress=${result.progress}, videoUrl=${result.videoUrl}, videoId=${result.videoId}, aborted=${aborted}, moderationBlocks=${moderationBlockCount}, candidates=${result.candidates.length}, allVideoUrls=${result.allVideoUrls.length}`);

        // Fallback: construct proper download URL from userId + videoId
        // ONLY if progress === 100 — anything less without a videoUrl is a moderation block
        if (!result.videoUrl && result.videoId && !aborted) {
            if (result.progress >= 100) {
                if (result.userId) {
                    result.videoUrl = `users/${result.userId}/generated/${result.videoId}/generated_video.mp4`;
                    console.log(`[I2VService] Constructed video URL from userId+videoId: ${result.videoUrl}`);
                } else {
                    result.videoUrl = result.videoId;
                    console.log(`[I2VService] Using videoId as download key (no userId): ${result.videoId}`);
                }
            } else {
                console.warn(`[I2VService] ⚠️ Stream ended at ${result.progress}% without videoUrl — likely moderation block, skipping download`);
                if (!result.error) {
                    result.error = `⛔ Stream ended at ${result.progress}% — video generation was likely blocked by moderation`;
                }
            }
        }

        if (!result.videoUrl && !result.error) {
            result.error = `Video generation stopped at ${result.progress}% — no video URL or ID returned (possible moderation block)`;
        }

        return result;
    }

    /**
     * Download video by URL
     * @param {string} url - Full or partial video URL
     * @param {Object} session - Session data
     * @returns {Promise<Object>} Video data {data, size}
     */
    async downloadVideoByUrl(url, session) {
        const cookieStr = this.formatCookies(session.cookies);
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        dlHeaders['referer'] = 'https://grok.com/';
        dlHeaders['origin'] = 'https://grok.com';
        dlHeaders['accept'] = '*/*';
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        const fullUrl = url.startsWith('http') ? url : `${API_ENDPOINTS.ASSETS_BASE_URL}${url}`;

        const MAX_RETRIES = 5;
        const RETRY_DELAY = 5000;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const res = await axios.get(fullUrl, {
                    headers: dlHeaders,
                    responseType: 'arraybuffer',
                    timeout: 120000,
                    validateStatus: () => true,
                });

                if (res.status === 200 && res.data.byteLength > 1000) {
                    return { data: Buffer.from(res.data), size: res.data.byteLength };
                }

                if (res.status === 404 || res.status === 403 || res.status === 500) {
                    if (attempt < MAX_RETRIES - 1) {
                        const wait = RETRY_DELAY + attempt * 3000;
                        console.log(`[I2VService] Video not ready (${res.status}), retry ${attempt + 1}/${MAX_RETRIES} in ${(wait/1000).toFixed(0)}s...`);
                        await new Promise(resolve => setTimeout(resolve, wait));
                        continue;
                    }
                }

                console.log(`[I2VService] Download → HTTP ${res.status}`);
            } catch (error) {
                console.log(`[I2VService] Download error:`, error.message.substring(0, 60));
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }

        return null;
    }

    /**
     * Download video directly to disk to avoid holding MP4 buffers in memory.
     */
    async downloadVideoByUrlToFile(url, session, filePath) {
        const cookieStr = this.formatCookies(session.cookies);
        const dlHeaders = {};
        for (const [k, v] of Object.entries(session.capturedHeaders)) {
            if (!k.startsWith(':')) dlHeaders[k] = v;
        }
        dlHeaders['cookie'] = cookieStr;
        dlHeaders['referer'] = 'https://grok.com/';
        dlHeaders['origin'] = 'https://grok.com';
        dlHeaders['accept'] = '*/*';
        delete dlHeaders['host'];
        delete dlHeaders['content-length'];
        delete dlHeaders['content-type'];

        const fullUrl = url.startsWith('http') ? url : `${API_ENDPOINTS.ASSETS_BASE_URL}${url}`;
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 5000;
        const tmpPath = `${filePath}.download`;
        FileService.ensureDir(path.dirname(filePath));

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                const res = await axios.get(fullUrl, {
                    headers: dlHeaders,
                    responseType: 'stream',
                    timeout: 120000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    validateStatus: () => true,
                });

                if (res.status === 200) {
                    await new Promise((resolve, reject) => {
                        const writer = fs.createWriteStream(tmpPath);
                        res.data.on('error', reject);
                        writer.on('error', reject);
                        writer.on('finish', resolve);
                        res.data.pipe(writer);
                    });

                    const size = fs.statSync(tmpPath).size;
                    if (size > 1000) {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                        fs.renameSync(tmpPath, filePath);
                        console.log(`[I2VService] Saved stream: ${filePath}`);
                        return { path: filePath, size };
                    }
                    fs.unlinkSync(tmpPath);
                }

                if (res.status === 404 || res.status === 403 || res.status === 500) {
                    if (attempt < MAX_RETRIES - 1) {
                        const wait = RETRY_DELAY + attempt * 3000;
                        console.log(`[I2VService] Video not ready (${res.status}), retry ${attempt + 1}/${MAX_RETRIES} in ${(wait/1000).toFixed(0)}s...`);
                        await new Promise(resolve => setTimeout(resolve, wait));
                        continue;
                    }
                }

                console.log(`[I2VService] Download → HTTP ${res.status}`);
            } catch (error) {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
                console.log(`[I2VService] Download error:`, error.message.substring(0, 80));
                if (attempt < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }

        return null;
    }

    /**
     * Check if an error is a retryable network error
     * @param {Error} error - Error object
     * @returns {boolean}
     */
    _isRetryableError(error) {
        const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'];
        if (error.code && retryableCodes.includes(error.code)) return true;
        if (error.message && retryableCodes.some(c => error.message.includes(c))) return true;
        return false;
    }

    /**
     * Detect whether a `generateOne` result was blocked by content moderation
     * (no video URL produced and an error message that looks like a block).
     * Used to decide whether to retry with `moderationRetryMode` (e.g. spicy).
     */
    _isModerationBlock(result) {
        if (!result) return false;
        if (result.videoUrl) return false;
        if (result.candidates && result.candidates.some(c => c.videoUrl)) return false;
        if (!result.error) return false;
        const e = String(result.error).toLowerCase();
        return e.includes('moderat')
            || e.includes('softblock')
            || e.includes('soft block')
            || e.includes('disallowed')
            || e.includes('blocked')
            || e.includes('content blocked')
            || e.startsWith('⛔')
            || e.includes('stalled');
    }

    /**
     * Generate single I2V video.
     *
     * Wraps `_generateOneAttempt` with a moderation-aware fallback: if the
     * first attempt is fully blocked (no video produced) and the config
     * specifies a `moderationRetryMode` distinct from the requested mode,
     * we retry once with that mode. This mirrors how grok.com web silently
     * upgrades to "spicy" for content the default preset rejects.
     *
     * @param {Object} item - {imagePath, prompt}
     * @param {Object} session - Session data
     * @param {Object} config - I2V configuration
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Object>} Result with video URL
     */
    async generateOne(item, session, config = I2V_CONFIG, onProgress = null) {
        const allowedModes = I2V_CONFIG.modeOptions || ['custom', 'fun', 'normal', 'spicy'];
        const requestedMode = allowedModes.includes(config.mode) ? config.mode : (I2V_CONFIG.mode || 'custom');
        const retryMode = config.moderationRetryMode !== undefined
            ? config.moderationRetryMode
            : I2V_CONFIG.moderationRetryMode;

        const firstResult = await this._generateOneAttempt(item, session, { ...config, mode: requestedMode }, onProgress);

        if (retryMode
            && allowedModes.includes(retryMode)
            && retryMode !== requestedMode
            && this._isModerationBlock(firstResult)) {
            console.warn(`[I2VService] ✨ First attempt blocked by moderation (mode=${requestedMode}). Retrying with mode=${retryMode}...`);
            const retryResult = await this._generateOneAttempt(item, session, { ...config, mode: retryMode }, onProgress);
            // If retry produced a video, prefer it; otherwise keep the first result
            // but tag the error so callers can tell both attempts were blocked.
            if (retryResult && (retryResult.videoUrl || (retryResult.candidates && retryResult.candidates.some(c => c.videoUrl)))) {
                retryResult.modeUsed = retryMode;
                retryResult.moderationFallback = true;
                return retryResult;
            }
            const merged = { ...firstResult };
            merged.modeUsed = requestedMode;
            merged.moderationFallback = true;
            merged.error = `⛔ Blocked in both modes ("${requestedMode}" and "${retryMode}"): ${firstResult.error || retryResult?.error || 'no video'}`;
            return merged;
        }

        if (firstResult) firstResult.modeUsed = requestedMode;
        return firstResult;
    }

    /**
     * Single generation attempt (with retry for network errors).
     * Internal — callers should use `generateOne` for moderation fallback.
     */
    async _generateOneAttempt(item, session, config = I2V_CONFIG, onProgress = null) {
        const { imagePath, prompt } = item;
        const imagePaths = (Array.isArray(item.refImagePaths) && item.refImagePaths.length > 0)
            ? item.refImagePaths.filter(Boolean)
            : [imagePath].filter(Boolean);
        const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;
        const BASE_DELAY = PROCESSING_CONFIG.RETRY_DELAY;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Step 1: Upload image
                console.log(`[I2VService] 📤 Uploading ${imagePaths.length} ref image(s): ${imagePaths.map(p => path.basename(p)).join(', ')}...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
                const uploads = [];
                for (const refPath of imagePaths) {
                    const uploaded = await this.uploadFile(refPath, session);
                    uploads.push(uploaded);
                    if (uploaded.error) break;
                }
                const upload = uploads.find(u => u.error) || uploads[0];

                // Handle 403 from upload — re-login and retry
                if (upload.error && upload.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 from upload for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (upload.error) {
                    return { ...upload, videoUrl: null, progress: 0 };
                }

                const fileMetadataIds = uploads.map(u => u.fileMetadataId).filter(Boolean);
                const imageUrls = uploads.map(u => u.fileUri ? `${API_ENDPOINTS.ASSETS_BASE_URL}${u.fileUri}` : null).filter(Boolean);
                const imageUrl = imageUrls[0] || null;

                // Step 2: Create media post (CRITICAL!)
                console.log(`[I2VService] 📝 Creating media post...`);
                const post = await this.createMediaPost(imageUrl, session);

                // Handle 403 from createMediaPost — re-login and retry
                if (post.error && post.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 from createMediaPost for ${session.email} — attempting re-login...`);
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (post.error) {
                    return { ...post, videoUrl: null, progress: 0 };
                }

                // Step 3: Generate video
                console.log(`[I2VService] 🎬 Generating video (stream)...`);
                const cookieStr = this.formatCookies(session.cookies);

                const res = await axios.post(
                    API_ENDPOINTS.API_URL,
                    this.buildI2VBody(prompt, fileMetadataIds, imageUrls, config),
                    {
                        headers: this.buildHeaders(session.capturedHeaders, cookieStr, 'https://grok.com/imagine'),
                        responseType: 'stream',
                        validateStatus: () => true,
                        timeout: 180000, // 3 min max (stall detection handles early abort)
                    }
                );

                // Handle 429 rate limit - retry
                if (res.status === 429 && attempt < MAX_RETRIES) {
                    const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
                    console.log(`[I2VService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }

                // Handle 403 — session expired, re-login this account only
                if (res.status === 403 && attempt < MAX_RETRIES) {
                    console.warn(`[I2VService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
                    // Drain stream to avoid memory leak
                    for await (const chunk of res.data) { /* discard */ }
                    const newSession = await AuthService.reloginAccount(session.email);
                    if (newSession) {
                        Object.assign(session, newSession);
                        console.log(`[I2VService] ✅ Re-login OK for ${session.email}, retrying...`);
                        continue;
                    } else {
                        return { videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
                    }
                }

                if (res.status !== 200) {
                    let errBody = '';
                    for await (const chunk of res.data) errBody += chunk.toString();
                    return {
                        videoUrl: null,
                        progress: 0,
                        error: `HTTP ${res.status}`,
                        errorDetail: errBody.substring(0, 500),
                    };
                }

                const result = await this.parseStreamResponse(res.data, onProgress);
                result.fileMetadataId = fileMetadataIds[0];
                result.fileMetadataIds = fileMetadataIds;

                // Fallback userId extraction from upload fileUri
                if (!result.userId) {
                    for (const u of uploads) {
                        if (u.fileUri) {
                            const m = u.fileUri.match(/users\/([^/]+)\//);
                            if (m) {
                                result.userId = m[1];
                                console.log(`[I2VService] Extracted userId from fileUri: ${result.userId}`);
                                break;
                            }
                        }
                    }
                }

                return result;
            } catch (error) {
                if (attempt < MAX_RETRIES && this._isRetryableError(error)) {
                    const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
                    console.log(`[I2VService] ⚠️ ${error.message}, retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, wait));
                    continue;
                }
                return {
                    videoUrl: null,
                    progress: 0,
                    error: error.message,
                };
            }
        }
    }

    /**
     * Generate I2V videos with multiple images (concurrent worker pool)
     * @param {Array<Object>} items - Array of {imagePath, prompt}
     * @param {Object} session - Session data
     * @param {Object} config - I2V configuration
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<Object>>} Results array
     */
    async generateBatch(items, session, config = I2V_CONFIG, onProgress = null, startIdx = 0) {
        const N = items.length;
        const requestedConcurrency = Number(config.batchSize || PROCESSING_CONFIG.CONCURRENCY.I2V || PROCESSING_CONFIG.BATCH_SIZE || 10);
        const CONCURRENCY = Math.max(1, Math.min(requestedConcurrency, 2));
        const outputFolder = config.outputFolder || PATHS.I2V_DIR;
        const label = `Acc${session.accIdx + 1}`;

        console.log(`[I2VService] [${label}] ${N} I2V items | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

        const results = [];
        let nextIdx = 0;
        const self = this;

        async function worker() {
            while (nextIdx < N) {
                if (self._cancelled) {
                    console.log(`[I2VService] [${label}] ⛔ Cancelled, stopping worker`);
                    break;
                }
                const myIdx = nextIdx++;
                const item = items[myIdx];
                const globalNum = startIdx + myIdx + 1; // 1-based global number

                console.log(`[I2VService] [${label}] 🎬📸 #${myIdx + 1}/${N} (shot${String(globalNum).padStart(4, '0')}) processing: ${path.basename(item.imagePath)}`);

                // Emit 0-progress "started" event immediately so the tracker UI
                // shows the job as pending right away instead of staying blank
                // for several seconds while upload / first server response runs.
                if (onProgress) onProgress(item, 0, null, myIdx);

                const result = await self.generateOne(item, session, config, (prog) => {
                    if (onProgress) onProgress(item, prog.progress, null, myIdx);
                });

                // Download video(s). With enableSideBySide=true Grok returns
                // multiple candidates per request; collect every distinct URL
                // (or videoId) from the parsed stream and save each one.
                const saveAll = config.saveAllSideBySide !== false && I2V_CONFIG.saveAllSideBySide !== false;
                const downloadTargets = [];
                if (saveAll && Array.isArray(result.candidates) && result.candidates.length > 0) {
                    for (const c of result.candidates) {
                        const url = c.videoUrl
                            || (c.videoId && result.userId ? `users/${result.userId}/generated/${c.videoId}/generated_video.mp4` : null)
                            || c.videoId || c.assetId;
                        if (!url) continue;
                        if (downloadTargets.some(t => t.url === url)) continue;
                        downloadTargets.push({ url, videoId: c.videoId || c.assetId, videoIndex: c.videoIndex });
                    }
                }
                if (downloadTargets.length === 0 && result.videoUrl) {
                    downloadTargets.push({ url: result.videoUrl, videoId: result.videoId });
                }

                const savedFiles = [];
                if (downloadTargets.length > 0) {
                    console.log(`[I2VService] [${label}] 📥 #${myIdx + 1} downloading ${downloadTargets.length} video(s)...`);
                    for (let i = 0; i < downloadTargets.length; i++) {
                        const target = downloadTargets[i];
                        try {
                            const shotNum = String(globalNum).padStart(4, '0');
                            const titleSlug = (result.title || '').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '').trim().replace(/\s+/g, '_').substring(0, 60);
                            const variantSuffix = downloadTargets.length > 1 ? `_v${i + 1}` : '';
                            const filename = titleSlug
                                ? `shot${shotNum}_${titleSlug}${variantSuffix}.mp4`
                                : `shot${shotNum}${variantSuffix}.mp4`;
                            const filePath = path.join(outputFolder, filename);
                            const dl = await self.downloadVideoByUrlToFile(target.url, session, filePath);
                            if (dl) {
                                savedFiles.push(dl.path);
                            }
                        } catch (error) {
                            console.error(`[I2VService] [${label}] Download error (variant ${i + 1}):`, error.message);
                        }
                    }
                }
                const savedFile = savedFiles[0] || null;

                const jobResult = {
                    imagePath: item.imagePath,
                    prompt: item.prompt,
                    localIdx: myIdx,
                    title: result.title,
                    videoId: result.videoId,
                    savedFile,
                    savedFiles,                          // array of all variants saved
                    outputPath: savedFile || null,
                    outputPaths: savedFiles.slice(),     // alias for UIs that prefer this name
                    candidateCount: downloadTargets.length,
                    modeUsed: result.modeUsed,
                    moderationFallback: !!result.moderationFallback,
                    success: savedFiles.length > 0,
                    error: result.error,
                };

                results.push(jobResult);

                if (onProgress) {
                    onProgress(item, 100, jobResult, myIdx);
                }

                console.log(`[I2VService] [${label}] #${myIdx + 1}/${N} ${savedFile ? '✅' : '❌'} ${result.title || item.prompt.substring(0, 50)}`);
            }
        }

        // Launch concurrent workers with staggered starts
        const workers = [];
        for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
            workers.push(
                new Promise((resolve) => setTimeout(() => resolve(worker()), i * 200))
            );
        }
        await Promise.all(workers);

        console.log(`[I2VService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
        return results;
    }
}

// Export singleton instance
module.exports = new I2VService();
