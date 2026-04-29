const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { API_ENDPOINTS, MODEL_CONFIG, VIDEO_CONFIG, PROCESSING_CONFIG, PATHS } = require('../config/app.config');
const FileService = require('./FileService');
const AuthService = require('./AuthService');

class VideoService {
  constructor() {
    this.activeJobs = new Map();
    this._cancelled = false;
  }

  cancelAll() {
    this._cancelled = true;
    console.log('[VideoService] ⛔ Cancel requested');
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
   * Build request headers
   */
  buildHeaders(capturedHeaders, cookieStr) {
    const headers = {};
    for (const [k, v] of Object.entries(capturedHeaders)) {
      if (!k.startsWith(':')) headers[k] = v;
    }
    headers['content-type'] = 'application/json';
    headers['x-xai-request-id'] = crypto.randomUUID();
    headers['cookie'] = cookieStr;
    delete headers['host'];
    delete headers['content-length'];
    return headers;
  }

  /**
   * Create media post (required step before video generation)
   * @param {string} prompt - Video prompt
   * @param {Object} session - Session data
   * @returns {Promise<Object>} {postId} or {error}
   */
  async createPost(prompt, session) {
    const cookieStr = this.formatCookies(session.cookies);

    try {
      const res = await axios.post(
        API_ENDPOINTS.POST_CREATE_URL,
        {
          mediaType: 'MEDIA_POST_TYPE_VIDEO',
          prompt: prompt,
        },
        {
          headers: this.buildHeaders(session.capturedHeaders, cookieStr),
          validateStatus: () => true,
          timeout: 30000,
        }
      );

      if (res.status !== 200) {
        return {
          error: `createPost HTTP ${res.status}`,
          errorDetail: JSON.stringify(res.data).substring(0, 500),
        };
      }

      const postId = res.data?.post?.id;
      if (!postId) {
        return { error: 'no postId returned' };
      }

      return { postId };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Build video generation request body
   * @param {string} prompt - Video prompt
   * @param {string} parentPostId - Post ID from createPost
   * @param {Object} config - Video configuration
   * @returns {Object} Request body
   */
  buildVideoBody(prompt, parentPostId, config = {}) {
    // Merge UI config with VIDEO_CONFIG defaults, map field names
    const mergedConfig = {
      aspectRatio: config.aspectRatio || VIDEO_CONFIG.aspectRatio,
      videoLength: config.videoLength || VIDEO_CONFIG.videoLength,
      isVideoEdit: config.isVideoEdit !== undefined ? config.isVideoEdit : VIDEO_CONFIG.isVideoEdit,
      resolutionName: config.resolutionName || config.resolution || VIDEO_CONFIG.resolutionName,
    };

    // `--mode=<mode>` controls how strict moderation is. "custom" matches legacy
    // app behaviour; "spicy" is the bolder/less-filtered preset that grok.com
    // web exposes. UI/config can override; generateOne() retries with
    // moderationRetryMode when the first attempt is fully blocked.
    const allowedModes = VIDEO_CONFIG.modeOptions || ['custom', 'fun', 'normal', 'spicy'];
    const mode = allowedModes.includes(config.mode) ? config.mode : (VIDEO_CONFIG.mode || 'custom');

    console.log(`[VideoService] buildVideoBody config: aspectRatio=${mergedConfig.aspectRatio}, videoLength=${mergedConfig.videoLength}, resolution=${mergedConfig.resolutionName}, mode=${mode}`);

    return {
      temporary: true,
      modelName: MODEL_CONFIG.VIDEO_MODEL,
      message: `${prompt} --mode=${mode}`,
      toolOverrides: { videoGen: true },
      enableSideBySide: true,
      responseMetadata: {
        experiments: [],
        modelConfigOverride: {
          modelMap: {
            videoGenModelConfig: {
              parentPostId,
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
   * Parse streaming NDJSON response
   * @param {string} text - Response text
   * @returns {Object} Parsed result
   */
  parseStreamResponse(text) {
    const result = {
      title: '',
      videoUrl: null,
      videoId: null,
      progress: 0,
      error: null,
      errorDetail: null,
      // Multi-candidate side-by-side support — Grok web returns 2 videos
      // per request when `enableSideBySide` is true.
      candidates: [],
      allVideoUrls: [],
    };
    let moderationBlockCount = 0;
    const candidatesByKey = new Map();

    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
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
        // Moderation block — DON'T return early!
        // With enableSideBySide=true, Grok generates 2 candidates.
        // One may be blocked but the other can still succeed.
        if (mr?.isSoftBlock || mr?.isDisallowed) {
          moderationBlockCount++;
          console.warn(`[VideoService] ⚠️ MODERATION flag #${moderationBlockCount} — continuing (side-by-side)`);
          if (!result.videoUrl && result.allVideoUrls.length === 0) {
            result.error = `⛔ Content blocked by moderation (softBlock=${mr.isSoftBlock}, disallowed=${mr.isDisallowed})`;
          }
        }

        // Video progress
        const vr = j.result?.response?.streamingVideoGenerationResponse;
        if (vr) {
          // Group chunks by candidate (videoId/assetId/videoIndex) so we can
          // collect distinct URLs from side-by-side generation.
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
          if (typeof vr.progress === 'number' && vr.progress > (cand.progress || 0)) {
            cand.progress = vr.progress;
          }

          result.progress = vr.progress || result.progress;
          // Capture videoId/assetId whenever available (primary slot)
          if (vr.videoId) result.videoId = result.videoId || vr.videoId;
          if (vr.assetId) result.videoId = result.videoId || vr.assetId;
          // Capture videoUrl whenever available (not just at progress=100)
          if (vr.videoUrl) {
            cand.videoUrl = vr.videoUrl;
            if (!result.allVideoUrls.includes(vr.videoUrl)) {
              result.allVideoUrls.push(vr.videoUrl);
            }
            if (!result.videoUrl) result.videoUrl = vr.videoUrl;
            // Clear moderation error since we got a successful video
            if (result.error && result.error.startsWith('⛔')) result.error = null;
            console.log(`[VideoService] 🎉 Video ready! url=${vr.videoUrl.substring(0, 50)} (${result.allVideoUrls.length} unique URL(s), ${candidatesByKey.size} candidate(s))`);
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
            console.warn(`[VideoService] ⚠️ Video moderation flag #${moderationBlockCount} at ${result.progress}% — continuing (side-by-side)`);
            if (!result.videoUrl && result.allVideoUrls.length === 0) {
              result.error = `⛔ Video blocked by moderation at ${result.progress}%`;
            }
          }
        }
      } catch (_) {
        // Ignore parse errors
      }
    }

    // Fallback: use videoId as download key — ONLY if progress is 100%
    // Below 100% without a videoUrl = moderation block, skip download
    if (!result.videoUrl && result.videoId) {
      if (result.progress >= 100) {
        result.videoUrl = result.videoId;
        console.log(`[VideoService] Using videoId as download key: ${result.videoId}`);
      } else {
        console.warn(`[VideoService] ⚠️ Stream ended at ${result.progress}% without videoUrl — likely moderation block`);
        if (!result.error) {
          result.error = `⛔ Stream ended at ${result.progress}% — video was likely blocked by moderation`;
        }
      }
    }

    if (!result.videoUrl && !result.error) {
      result.error = `Video generation stopped at ${result.progress}% — no video URL returned (possible moderation block)`;
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

    return result;
  }

  /**
   * Download video
   * @param {string} videoUrl - Video URL path
   * @param {Object} session - Session data
   * @returns {Promise<Object>} Video data {data, size}
   */
  async downloadVideo(videoUrl, session) {
    const cookieStr = this.formatCookies(session.cookies);
    const bases = [API_ENDPOINTS.ASSETS_BASE_URL];

    const dlHeaders = {};
    for (const [k, v] of Object.entries(session.capturedHeaders)) {
      if (!k.startsWith(':')) dlHeaders[k] = v;
    }
    dlHeaders['cookie'] = cookieStr;
    delete dlHeaders['host'];
    delete dlHeaders['content-length'];
    delete dlHeaders['content-type'];

    for (const base of bases) {
      try {
        const res = await axios.get(base + videoUrl, {
          headers: dlHeaders,
          responseType: 'arraybuffer',
          timeout: 120000,
          validateStatus: () => true,
        });

        if (res.status === 200) {
          return {
            data: Buffer.from(res.data),
            size: res.data.byteLength,
          };
        }
        console.log(`[VideoService] Download ${base} → HTTP ${res.status}`);
      } catch (error) {
        console.log(`[VideoService] Download error:`, error.message.substring(0, 60));
      }
    }
    return null;
  }

  /**
   * Download video directly to disk to avoid holding MP4 buffers in memory.
   */
  async downloadVideoToFile(videoUrl, session, filePath) {
    const cookieStr = this.formatCookies(session.cookies);
    const bases = [API_ENDPOINTS.ASSETS_BASE_URL];

    const dlHeaders = {};
    for (const [k, v] of Object.entries(session.capturedHeaders)) {
      if (!k.startsWith(':')) dlHeaders[k] = v;
    }
    dlHeaders['cookie'] = cookieStr;
    delete dlHeaders['host'];
    delete dlHeaders['content-length'];
    delete dlHeaders['content-type'];

    FileService.ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.download`;

    for (const base of bases) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        const res = await axios.get(base + videoUrl, {
          headers: dlHeaders,
          responseType: 'stream',
          timeout: 120000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: () => true,
        });

        if (res.status !== 200) {
          console.log(`[VideoService] Download ${base} → HTTP ${res.status}`);
          continue;
        }

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(tmpPath);
          res.data.on('error', reject);
          writer.on('error', reject);
          writer.on('finish', resolve);
          res.data.pipe(writer);
        });

        const size = fs.statSync(tmpPath).size;
        if (size <= 1000) {
          fs.unlinkSync(tmpPath);
          throw new Error(`Downloaded file too small (${size} bytes)`);
        }

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
        console.log(`[VideoService] Saved stream: ${filePath}`);
        return { path: filePath, size };
      } catch (error) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        console.log(`[VideoService] Download error:`, error.message.substring(0, 80));
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
   * Generate single video (with retry for network errors)
   * @param {string} prompt - Video prompt
   * @param {Object} session - Session data
   * @param {Object} config - Video configuration
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<Object>} Result with video URL
   */
  /**
   * Detect whether a `_generateOneAttempt` result was blocked by moderation
   * (no video URL produced and an error message that looks like a block).
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

  async generateOne(prompt, session, config = VIDEO_CONFIG, onProgress = null) {
    // Moderation-aware fallback: try requested mode first, then
    // `moderationRetryMode` (default "spicy") if the first attempt is blocked.
    const allowedModes = VIDEO_CONFIG.modeOptions || ['custom', 'fun', 'normal', 'spicy'];
    const requestedMode = allowedModes.includes(config.mode) ? config.mode : (VIDEO_CONFIG.mode || 'custom');
    const retryMode = config.moderationRetryMode !== undefined
      ? config.moderationRetryMode
      : VIDEO_CONFIG.moderationRetryMode;

    const firstResult = await this._generateOneAttempt(prompt, session, { ...config, mode: requestedMode }, onProgress);

    if (retryMode
        && allowedModes.includes(retryMode)
        && retryMode !== requestedMode
        && this._isModerationBlock(firstResult)) {
      console.warn(`[VideoService] ✨ First attempt blocked by moderation (mode=${requestedMode}). Retrying with mode=${retryMode}...`);
      const retryResult = await this._generateOneAttempt(prompt, session, { ...config, mode: retryMode }, onProgress);
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
  async _generateOneAttempt(prompt, session, config = VIDEO_CONFIG, onProgress = null) {
    const MAX_RETRIES = PROCESSING_CONFIG.MAX_RETRIES;
    const BASE_DELAY = PROCESSING_CONFIG.RETRY_DELAY;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Step 1: Create post
        console.log(`[VideoService] Creating post for: ${prompt.substring(0, 50)}...${attempt > 0 ? ` (retry ${attempt}/${MAX_RETRIES})` : ''}`);
        const post = await this.createPost(prompt, session);

        // Handle 403 from createPost — re-login and retry
        if (post.error && post.error.includes('HTTP 403') && attempt < MAX_RETRIES) {
          console.warn(`[VideoService] ⚠️ 403 from createPost for ${session.email} — attempting re-login...`);
          const newSession = await AuthService.reloginAccount(session.email);
          if (newSession) {
            Object.assign(session, newSession);
            console.log(`[VideoService] ✅ Re-login OK for ${session.email}, retrying...`);
            continue;
          } else {
            return { title: '', videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
          }
        }

        if (post.error) {
          return { ...post, title: '', videoUrl: null, progress: 0 };
        }

        // Step 2: Generate video
        console.log(`[VideoService] Generating video (postId: ${post.postId})...`);
        const cookieStr = this.formatCookies(session.cookies);

        const res = await axios.post(
          API_ENDPOINTS.API_URL,
          this.buildVideoBody(prompt, post.postId, config),
          {
            headers: this.buildHeaders(session.capturedHeaders, cookieStr),
            responseType: 'text',
            validateStatus: () => true,
            timeout: 180000, // 3 min max
          }
        );

        // Handle 429 rate limit - retry
        if (res.status === 429 && attempt < MAX_RETRIES) {
          const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
          console.log(`[VideoService] ⚠️ Rate limited (429), retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }

        // Handle 403 — session expired, re-login this account only
        if (res.status === 403 && attempt < MAX_RETRIES) {
          console.warn(`[VideoService] ⚠️ 403 Forbidden for ${session.email} — attempting re-login...`);
          const newSession = await AuthService.reloginAccount(session.email);
          if (newSession) {
            Object.assign(session, newSession);
            console.log(`[VideoService] ✅ Re-login OK for ${session.email}, retrying...`);
            continue;
          } else {
            return { title: '', videoUrl: null, progress: 0, error: `403 Forbidden — re-login failed or limit exceeded for ${session.email}` };
          }
        }

        if (res.status !== 200) {
          return {
            title: '',
            videoUrl: null,
            progress: 0,
            error: `HTTP ${res.status}`,
            errorDetail: (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).substring(0, 500),
          };
        }

        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const parsed = this.parseStreamResponse(text);

        if (onProgress && parsed.progress === 100) {
          onProgress({ progress: 100, status: 'completed' });
        }

        return parsed;
      } catch (error) {
        if (attempt < MAX_RETRIES && this._isRetryableError(error)) {
          const wait = BASE_DELAY * (attempt + 1) + Math.random() * 5000;
          console.log(`[VideoService] ⚠️ ${error.message}, retrying in ${(wait / 1000).toFixed(1)}s... (${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, wait));
          continue;
        }
        return {
          title: '',
          videoUrl: null,
          progress: 0,
          error: error.message,
        };
      }
    }
  }

  /**
   * Generate videos with multiple prompts
   * @param {Array<string>} prompts - Array of prompts
   * @param {Object} session - Session data
   * @param {Object} config - Video configuration
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<Array<Object>>} Results array
   */
  async generateBatch(prompts, session, config = VIDEO_CONFIG, onProgress = null, startIdx = 0) {
    const N = prompts.length;
    const requestedConcurrency = Number(config.batchSize || PROCESSING_CONFIG.BATCH_SIZE || 10);
    const CONCURRENCY = Math.max(1, Math.min(requestedConcurrency, 2));
    const outputFolder = config.outputFolder || PATHS.VIDEO_DIR;
    const label = `Acc${session.accIdx + 1}`;

    console.log(`[VideoService] [${label}] ${N} videos | ${CONCURRENCY} concurrent | startIdx=${startIdx}`);

    const results = [];
    let nextIdx = 0;
    const self = this;

    async function worker() {
      while (nextIdx < N) {
        if (self._cancelled) {
          console.log(`[VideoService] [${label}] ⛔ Cancelled, stopping worker`);
          break;
        }
        const myIdx = nextIdx++;
        const prompt = prompts[myIdx];
        const globalNum = startIdx + myIdx + 1; // 1-based global number

        console.log(`[VideoService] [${label}] 🎬 #${myIdx + 1}/${N} (shot${String(globalNum).padStart(4, '0')}) starting: ${prompt.substring(0, 50)}...`);

        // Emit a 0-progress "started" event immediately so the tracker UI
        // shows the job as pending instead of staying blank for 5+ seconds
        // while createPost / first server response are in flight.
        if (onProgress) onProgress(prompt, 0, null, myIdx);

        const result = await self.generateOne(prompt, session, config, (prog) => {
          if (onProgress) onProgress(prompt, prog.progress, null, myIdx);
        });

        // Download video(s). With enableSideBySide=true Grok returns multiple
        // candidates; collect every distinct URL and save each as `_v1`, `_v2`,
        // etc. so the user has both videos like grok.com web shows.
        const saveAll = config.saveAllSideBySide !== false && VIDEO_CONFIG.saveAllSideBySide !== false;
        const downloadTargets = [];
        if (saveAll && Array.isArray(result.candidates) && result.candidates.length > 0) {
          for (const c of result.candidates) {
            const url = c.videoUrl || c.videoId || c.assetId;
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
          console.log(`[VideoService] [${label}] 📥 #${myIdx + 1} downloading ${downloadTargets.length} video(s)...`);
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
              const dl = await self.downloadVideoToFile(target.url, session, filePath);
              if (dl) {
                savedFiles.push(dl.path);
              }
            } catch (error) {
              console.error(`[VideoService] [${label}] Download error (variant ${i + 1}):`, error.message);
            }
          }
        }
        const savedFile = savedFiles[0] || null;

        const jobResult = {
          prompt,
          localIdx: myIdx,
          title: result.title,
          videoId: result.videoId,
          savedFile,
          savedFiles,
          outputPath: savedFile || null,
          outputPaths: savedFiles.slice(),
          candidateCount: downloadTargets.length,
          modeUsed: result.modeUsed,
          moderationFallback: !!result.moderationFallback,
          success: savedFiles.length > 0,
          error: result.error,
        };

        results.push(jobResult);

        if (onProgress) {
          onProgress(prompt, 100, jobResult, myIdx);
        }

        console.log(`[VideoService] [${label}] #${myIdx + 1}/${N} ${savedFile ? '✅' : '❌'} ${result.title || prompt.substring(0, 50)}`);
      }
    }

    // Launch concurrent workers with staggered starts
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, N); i++) {
      workers.push(
        new Promise((resolve) => setTimeout(() => resolve(worker()), i * 75))
      );
    }
    await Promise.all(workers);

    console.log(`[VideoService] [${label}] Complete: ${results.filter(r => r.success).length}/${results.length} successful`);
    return results;
  }
}

// Export singleton instance
module.exports = new VideoService();

