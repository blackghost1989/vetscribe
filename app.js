// ===== VetScribe — 獸醫看診錄音分析 =====
(() => {
    'use strict';

    // ===== Config =====
    const STORAGE_KEYS = {
        PROVIDER: 'vetscribe_provider',
        GEMINI_KEY: 'vetscribe_api_key',
        GEMINI_MODEL: 'vetscribe_model',
        OPENAI_KEY: 'vetscribe_openai_key',
        OPENAI_MODEL: 'vetscribe_openai_model',
        LOCAL_API: 'vetscribe_local_api',
        LOCAL_LLM: 'vetscribe_local_llm',
        LOCAL_LLM_API: 'vetscribe_local_llm_api',
        HISTORY: 'vetscribe_history',
    };

    const CATEGORIES = [
        { key: 'chief_complaint', name: '主訴', nameEn: 'Chief Complaint', icon: '🐾', cssClass: 'cat-chief' },
        { key: 'symptoms', name: '症狀', nameEn: 'Symptoms', icon: '🔍', cssClass: 'cat-symptom' },
        { key: 'physical_exam', name: '理學檢查結果', nameEn: 'Physical Examination', icon: '🩺', cssClass: 'cat-physical' },
        { key: 'blood_test', name: '血檢結果', nameEn: 'Blood Test Results', icon: '🩸', cssClass: 'cat-blood' },
        { key: 'imaging', name: '影像檢查結果', nameEn: 'Imaging Results', icon: '📷', cssClass: 'cat-imaging' },
        { key: 'treatment', name: '後續治療選項', nameEn: 'Treatment Options', icon: '💊', cssClass: 'cat-treatment' },
        { key: 'other', name: '其他備註', nameEn: 'Other Notes', icon: '📝', cssClass: 'cat-other' },
    ];

    const SYSTEM_PROMPT = `你是一位資深獸醫助理，負責分析看診錄音的逐字稿。
請將內容分類整理為以下類別，以條列式呈現。

你必須以嚴格的 JSON 格式回覆，不要包含任何 markdown 標記或程式碼區塊標記。
JSON 結構如下：
{
  "chief_complaint": ["項目1", "項目2"],
  "symptoms": ["項目1", "項目2"],
  "physical_exam": ["項目1", "項目2"],
  "blood_test": ["項目1", "項目2"],
  "imaging": ["項目1", "項目2"],
  "treatment": ["項目1", "項目2"],
  "other": ["項目1", "項目2"]
}

各類別說明：
- chief_complaint：飼主描述的主要就診原因與問題
- symptoms：對話中提到的所有臨床症狀
- physical_exam：理學檢查發現，如體溫、心跳、呼吸、觸診結果等
- blood_test：血液檢查的數值與結果
- imaging：X光、超音波、CT等影像檢查的結果
- treatment：診斷後建議或討論的治療方案
- other：其他重要資訊，如用藥史、過敏史、飲食建議等

規則：
1. 如果某類別在對話中未提及，該陣列留空 []
2. 每個項目要簡潔清楚，保留重要數值
3. 使用繁體中文
4. 非常重要：請根據對話語氣與上下文，主動將對話內容標註是由誰說的（例：【獸醫】、【飼主】）。
5. 非常重要：如果逐字稿中包含台語（閩南語）或因台語產生的同音錯字，請在整理與分類時，直接將其意譯為流暢的國語（繁體中文）。
6. 只回傳 JSON，不要回傳其他文字`;

    // ===== State =====
    let mediaRecorder = null;
    let audioChunks = [];
    let audioBlob = null;
    let audioStream = null;
    let analyserNode = null;
    let timerInterval = null;
    let recordingSeconds = 0;
    let isPaused = false;
    let isRecording = false;
    let wakeLock = null;

    // ===== Wake Lock (prevent iOS screen sleep during API calls) =====
    async function acquireWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake lock acquired');
            }
        } catch (e) {
            console.warn('Wake lock not available:', e);
        }
    }

    async function releaseWakeLock() {
        if (wakeLock) {
            try {
                await wakeLock.release();
                wakeLock = null;
                console.log('Wake lock released');
            } catch (e) { /* noop */ }
        }
    }

    // ===== Fetch with retry (handles iOS network suspension) =====
    async function fetchWithRetry(url, options, retries = 3, delay = 2000) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const resp = await fetch(url, options);
                return resp;
            } catch (err) {
                console.warn(`Fetch attempt ${attempt}/${retries} failed:`, err.message);
                if (attempt === retries) throw err;
                toast(`網路中斷，${delay / 1000}秒後重試 (${attempt}/${retries})...`, 'warning');
                await new Promise(r => setTimeout(r, delay));
                delay *= 1.5; // exponential backoff
            }
        }
    }

    // ===== DOM refs =====
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        recordBtn: $('#recordBtn'),
        stopBtn: $('#stopBtn'),
        recorderControls: $('#recorderControls'),
        timer: $('#timer'),
        statusDot: $('#statusDot'),
        statusText: $('#statusText'),
        waveform: $('#waveform'),
        uploadArea: $('#uploadArea'),
        audioFileInput: $('#audioFileInput'),
        audioPlayerContainer: $('#audioPlayerContainer'),
        audioPlayer: $('#audioPlayer'),
        downloadAudioBtn: $('#downloadAudioBtn'),
        transcriptPlaceholder: $('#transcriptPlaceholder'),
        transcriptText: $('#transcriptText'),
        transcriptActions: $('#transcriptActions'),
        copyTranscriptBtn: $('#copyTranscriptBtn'),
        analysisPlaceholder: $('#analysisPlaceholder'),
        analysisResult: $('#analysisResult'),
        analysisActions: $('#analysisActions'),
        copyAnalysisBtn: $('#copyAnalysisBtn'),
        exportJsonBtn: $('#exportJsonBtn'),
        // Settings
        settingsBtn: $('#settingsBtn'),
        settingsModal: $('#settingsModal'),
        closeSettingsBtn: $('#closeSettingsBtn'),
        cancelSettingsBtn: $('#cancelSettingsBtn'),
        saveSettingsBtn: $('#saveSettingsBtn'),
        providerSelect: $('#providerSelect'),
        geminiSettings: $('#geminiSettings'),
        openaiSettings: $('#openaiSettings'),
        apiKeyInput: $('#apiKeyInput'),
        modelSelect: $('#modelSelect'),
        openaiKeyInput: $('#openaiKeyInput'),
        openaiModelSelect: $('#openaiModelSelect'),
        localSettings: $('#localSettings'),
        localApiInput: $('#localApiInput'),
        localLlmApiInput: $('#localLlmApiInput'),
        localLlmSelect: $('#localLlmSelect'),
        apiStatusDot: $('#apiStatusDot'),
        apiStatusText: $('#apiStatusText'),
        // History
        historyBtn: $('#historyBtn'),
        historyModal: $('#historyModal'),
        closeHistoryBtn: $('#closeHistoryBtn'),
        historyList: $('#historyList'),
        clearHistoryBtn: $('#clearHistoryBtn'),
        importJsonBtn: $('#importJsonBtn'),
        jsonFileInput: $('#jsonFileInput'),
        // URL input
        videoUrlInput: $('#videoUrlInput'),
        analyzeUrlBtn: $('#analyzeUrlBtn'),
        // Toast
        toastContainer: $('#toastContainer'),
    };

    // ===== Settings Helpers =====
    function getProvider() {
        return localStorage.getItem(STORAGE_KEYS.PROVIDER) || 'gemini';
    }

    function getGeminiKey() {
        return localStorage.getItem(STORAGE_KEYS.GEMINI_KEY) || '';
    }

    function getGeminiModel() {
        return localStorage.getItem(STORAGE_KEYS.GEMINI_MODEL) || 'gemini-2.5-flash';
    }

    function getOpenaiKey() {
        return localStorage.getItem(STORAGE_KEYS.OPENAI_KEY) || '';
    }

    function getOpenaiModel() {
        return localStorage.getItem(STORAGE_KEYS.OPENAI_MODEL) || 'gpt-4o';
    }

    function getActiveApiKey() {
        if (getProvider() === 'local') return true; // Local bypasses API key check for transcript, LLM check will happen later
        return getProvider() === 'openai' ? getOpenaiKey() : getGeminiKey();
    }

    function getLocalApiUrl() {
        return localStorage.getItem(STORAGE_KEYS.LOCAL_API) || 'http://127.0.0.1:8000';
    }

    function getLocalLlmProvider() {
        return localStorage.getItem(STORAGE_KEYS.LOCAL_LLM) || 'gemini';
    }

    function getLocalLlmApiUrl() {
        return localStorage.getItem(STORAGE_KEYS.LOCAL_LLM_API) || 'http://127.0.0.1:11434/v1';
    }

    // ===== Init =====
    function init() {
        loadSettings();
        initWaveformBars();
        bindEvents();
        updateApiStatus();
    }

    // ===== Waveform =====
    function initWaveformBars() {
        const count = 50;
        dom.waveform.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const bar = document.createElement('div');
            bar.className = 'waveform-bar';
            bar.style.setProperty('--delay', `${0.3 + Math.random() * 0.4}s`);
            bar.style.setProperty('--max-h', `${12 + Math.random() * 35}px`);
            dom.waveform.appendChild(bar);
        }
    }

    function setWaveformActive(active) {
        dom.waveform.querySelectorAll('.waveform-bar').forEach((bar) => {
            bar.classList.toggle('active', active);
        });
    }

    // ===== Timer =====
    function startTimer() {
        recordingSeconds = 0;
        updateTimerDisplay();
        timerInterval = setInterval(() => {
            if (!isPaused) {
                recordingSeconds++;
                updateTimerDisplay();
            }
        }, 1000);
    }

    function stopTimer() {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    function updateTimerDisplay() {
        const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
        const s = String(recordingSeconds % 60).padStart(2, '0');
        dom.timer.textContent = `${m}:${s}`;
    }

    // ===== Recording =====
    async function startRecording() {
        try {
            audioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100,
                },
            });

            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(audioStream);
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 256;
            source.connect(analyserNode);

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/wav';

            mediaRecorder = new MediaRecorder(audioStream, { mimeType });
            audioChunks = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
                audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                onRecordingComplete();
            };

            mediaRecorder.start(1000);
            isRecording = true;
            isPaused = false;

            dom.recordBtn.classList.add('recording');
            dom.recordBtn.innerHTML = '⏸️';
            dom.recorderControls.style.display = 'flex';
            dom.uploadArea.style.display = 'none';
            dom.statusDot.className = 'status-dot recording';
            dom.statusText.textContent = '錄音中...';
            dom.timer.classList.add('active');
            setWaveformActive(true);
            startTimer();
        } catch (err) {
            console.error('Mic access error:', err);
            toast('無法存取麥克風，請確認瀏覽器權限', 'error');
        }
    }

    function toggleRecording() {
        if (!isRecording) {
            startRecording();
        } else if (isPaused) {
            // Resume
            mediaRecorder.resume();
            isPaused = false;
            dom.recordBtn.innerHTML = '⏸️';
            dom.recordBtn.classList.add('recording');
            dom.statusDot.className = 'status-dot recording';
            dom.statusText.textContent = '錄音中...';
            setWaveformActive(true);
        } else {
            // Pause
            mediaRecorder.pause();
            isPaused = true;
            dom.recordBtn.innerHTML = '🎤';
            dom.recordBtn.classList.remove('recording');
            dom.statusDot.className = 'status-dot paused';
            dom.statusText.textContent = '已暫停';
            setWaveformActive(false);
        }
    }

    function stopRecording() {
        if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
        mediaRecorder.stop();
        audioStream.getTracks().forEach((t) => t.stop());
        isRecording = false;
        isPaused = false;
        stopTimer();

        dom.recordBtn.classList.remove('recording');
        dom.recordBtn.innerHTML = '🎤';
        dom.recorderControls.style.display = 'none';
        dom.statusDot.className = 'status-dot';
        dom.statusText.textContent = '錄音結束';
        dom.timer.classList.remove('active');
        setWaveformActive(false);
    }

    function onRecordingComplete() {
        const url = URL.createObjectURL(audioBlob);
        dom.audioPlayer.src = url;
        dom.audioPlayerContainer.style.display = 'block';
        processAudio(audioBlob);
    }

    // ===== File Upload =====
    function handleFileUpload(file) {
        if (!file || !file.type.startsWith('audio/')) {
            toast('請上傳音訊檔案', 'error');
            return;
        }
        audioBlob = file;
        const url = URL.createObjectURL(file);
        dom.audioPlayer.src = url;
        dom.audioPlayerContainer.style.display = 'block';
        dom.uploadArea.style.display = 'none';
        toast('音訊檔案已載入', 'success');
        processAudio(file);
    }

    async function downloadAudio() {
        if (!audioBlob) {
            toast('沒有可下載的錄音', 'error');
            return;
        }

        toast('正在轉換為 WAV 格式...', 'info');

        try {
            // Decode audio blob to PCM using AudioContext
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

            // Encode as WAV
            const wavBlob = audioBufferToWav(audioBuffer);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(wavBlob);
            a.download = `vetscribe_${timestamp}.wav`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            audioCtx.close();
            toast('WAV 錄音檔已下載', 'success');
        } catch (err) {
            console.error('WAV conversion error:', err);
            // Fallback: download original format
            const a = document.createElement('a');
            a.href = URL.createObjectURL(audioBlob);
            a.download = `vetscribe_recording.${audioBlob.type.includes('mp4') ? 'm4a' : 'webm'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            toast('原始格式已下載（轉換失敗）', 'warning');
        }
    }

    function audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const format = 1; // PCM
        const bitsPerSample = 16;

        // Interleave channels
        let interleaved;
        if (numChannels === 1) {
            interleaved = buffer.getChannelData(0);
        } else {
            const left = buffer.getChannelData(0);
            const right = buffer.getChannelData(1);
            interleaved = new Float32Array(left.length + right.length);
            for (let i = 0, idx = 0; i < left.length; i++) {
                interleaved[idx++] = left[i];
                interleaved[idx++] = right[i];
            }
        }

        const dataLength = interleaved.length * (bitsPerSample / 8);
        const headerLength = 44;
        const totalLength = headerLength + dataLength;
        const arrayBuffer = new ArrayBuffer(totalLength);
        const view = new DataView(arrayBuffer);

        // WAV header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, totalLength - 8, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // chunk size
        view.setUint16(20, format, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
        view.setUint16(32, numChannels * (bitsPerSample / 8), true);
        view.setUint16(34, bitsPerSample, true);
        writeString(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        // PCM samples (float32 → int16)
        let offset = 44;
        for (let i = 0; i < interleaved.length; i++, offset += 2) {
            let s = Math.max(-1, Math.min(1, interleaved[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    function writeString(view, offset, str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    // ===== Utility =====
    async function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function getGeminiMimeType(blob) {
        const type = blob.type || 'audio/wav';
        const map = {
            'audio/webm;codecs=opus': 'audio/webm',
            'audio/webm': 'audio/webm',
            'audio/wav': 'audio/wav',
            'audio/mpeg': 'audio/mp3',
            'audio/mp3': 'audio/mp3',
            'audio/ogg': 'audio/ogg',
            'audio/flac': 'audio/flac',
            'audio/aac': 'audio/aac',
            'audio/mp4': 'audio/aac',
            'audio/x-m4a': 'audio/aac',
        };
        return map[type] || 'audio/wav';
    }

    // =================================================================
    //  GEMINI API
    // =================================================================
    async function geminiGenerateContent(base64Audio, mimeType, prompt, systemInstruction) {
        const apiKey = getGeminiKey();
        if (!apiKey) throw new Error('請先設定 Gemini API Key');

        const model = getGeminiModel();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const body = {
            contents: [{
                parts: [
                    { inline_data: { mime_type: mimeType, data: base64Audio } },
                    { text: prompt },
                ]
            }],
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }

        const resp = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Gemini API 錯誤 (${resp.status})`);
        }
        const data = await resp.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    async function geminiAnalyzeText(transcript) {
        const apiKey = getGeminiKey();
        const model = getGeminiModel();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const body = {
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{
                parts: [
                    { text: `以下是獸醫看診的逐字稿，請分析並分類：\n\n${transcript}` },
                ]
            }],
            generation_config: { temperature: 0.2, response_mime_type: 'application/json' },
        };

        const resp = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Gemini API 錯誤 (${resp.status})`);
        }
        const data = await resp.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    }

    // For large files: Gemini Files API
    async function geminiUploadFile(blob) {
        const apiKey = getGeminiKey();
        if (!apiKey) throw new Error('請先設定 Gemini API Key');

        const mimeType = getGeminiMimeType(blob);
        const numBytes = blob.size;

        const initResp = await fetchWithRetry(
            `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'X-Goog-Upload-Protocol': 'resumable',
                    'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': String(numBytes),
                    'X-Goog-Upload-Header-Content-Type': mimeType,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ file: { display_name: 'vetscribe_audio' } }),
            }
        );
        if (!initResp.ok) throw new Error(`檔案上傳初始化失敗 (${initResp.status})`);

        const uploadUrl = initResp.headers.get('X-Goog-Upload-URL');
        if (!uploadUrl) throw new Error('無法取得上傳 URL');

        const uploadResp = await fetchWithRetry(uploadUrl, {
            method: 'POST',
            headers: {
                'Content-Length': String(numBytes),
                'X-Goog-Upload-Offset': '0',
                'X-Goog-Upload-Command': 'upload, finalize',
            },
            body: blob,
        });
        if (!uploadResp.ok) throw new Error(`檔案上傳失敗 (${uploadResp.status})`);
        return (await uploadResp.json()).file;
    }

    async function geminiGenerateFromFile(fileUri, mimeType, prompt, systemInstruction) {
        const apiKey = getGeminiKey();
        const model = getGeminiModel();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const body = {
            contents: [{
                parts: [
                    { file_data: { mime_type: mimeType, file_uri: fileUri } },
                    { text: prompt },
                ]
            }],
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }

        const resp = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Gemini API 錯誤 (${resp.status})`);
        }
        const data = await resp.json();
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    // =================================================================
    //  GEMINI: URL-based analysis (YouTube etc)
    // =================================================================
    async function processVideoUrl(url) {
        const provider = getProvider();
        if (provider !== 'gemini') {
            toast('影片網址分析僅支援 Gemini API，請在設定中切換', 'error');
            return;
        }
        const apiKey = getGeminiKey();
        if (!apiKey) {
            toast('請先設定 Gemini API Key', 'error');
            openModal(dom.settingsModal);
            return;
        }

        await acquireWakeLock();
        const model = getGeminiModel();
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Step 1: Transcribe from URL
        showTranscriptLoading('正在從影片轉錄語音...');
        try {
            const transcribeBody = {
                contents: [{
                    parts: [
                        { file_data: { mime_type: 'video/mp4', file_uri: url } },
                        { text: '請將這段影片中的語音完整轉錄為逐字稿。使用繁體中文。如果有多位說話者，請標註說話者（如：獸醫、飼主）。保留所有對話細節。' },
                    ]
                }],
            };

            const transcribeResp = await fetchWithRetry(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transcribeBody),
            });
            if (!transcribeResp.ok) {
                const err = await transcribeResp.json().catch(() => ({}));
                throw new Error(err?.error?.message || `Gemini API 錯誤 (${transcribeResp.status})`);
            }
            const transcribeData = await transcribeResp.json();
            const transcript = transcribeData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

            if (!transcript.trim()) throw new Error('未能從影片中轉錄出任何語音');

            showTranscript(transcript);
            toast('逐字稿產生完成', 'success');

            // Step 2: Analyze
            showAnalysisLoading('使用 Gemini 分析中...');
            const analysisText = await geminiAnalyzeText(transcript);
            const parsed = parseAnalysis(analysisText);
            showAnalysis(parsed);
            toast('分析完成', 'success');
            saveToHistory(transcript, parsed);
        } catch (err) {
            console.error('URL analysis error:', err);
            hideTranscriptLoading();
            hideAnalysisLoading();
            toast(`影片分析失敗: ${err.message}`, 'error');
            showRetryButton(dom.transcriptPlaceholder, () => processVideoUrl(url));
        } finally {
            await releaseWakeLock();
        }
    }

    // =================================================================
    //  OPENAI API
    // =================================================================
    async function openaiWhisperTranscribe(blob) {
        const apiKey = getOpenaiKey();
        if (!apiKey) throw new Error('請先設定 OpenAI API Key');

        // Whisper API accepts form-data with file upload
        const formData = new FormData();

        // Whisper needs a proper file extension
        let ext = 'webm';
        if (blob.type.includes('wav')) ext = 'wav';
        else if (blob.type.includes('mp3') || blob.type.includes('mpeg')) ext = 'mp3';
        else if (blob.type.includes('ogg')) ext = 'ogg';
        else if (blob.type.includes('flac')) ext = 'flac';
        else if (blob.type.includes('m4a') || blob.type.includes('mp4')) ext = 'm4a';

        const file = new File([blob], `recording.${ext}`, { type: blob.type });
        formData.append('file', file);
        formData.append('model', 'whisper-1');
        formData.append('language', 'zh');
        formData.append('response_format', 'text');

        const resp = await fetchWithRetry('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData,
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Whisper API 錯誤 (${resp.status})`);
        }

        return await resp.text();
    }

    async function openaiChatAnalyze(transcript) {
        const apiKey = getOpenaiKey();
        if (!apiKey) throw new Error('請先設定 OpenAI API Key');

        const model = getOpenaiModel();
        const url = 'https://api.openai.com/v1/chat/completions';

        const body = {
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `以下是獸醫看診的逐字稿，請分析並分類：\n\n${transcript}` },
            ],
        };

        const resp = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `OpenAI API 錯誤 (${resp.status})`);
        }

        const data = await resp.json();
        return data?.choices?.[0]?.message?.content || '{}';
    }

    // =================================================================
    //  LOCAL QWEN-ASR API
    // =================================================================
    async function localQwenTranscribe(blob) {
        const apiUrl = getLocalApiUrl();
        if (!apiUrl) throw new Error('請先設定本機 API 網址');

        const formData = new FormData();
        const ext = blob.type.includes('webm') ? 'webm' : 'wav';
        const file = new File([blob], `recording.${ext}`, { type: blob.type });
        formData.append('audio', file);

        const resp = await fetchWithRetry(`${apiUrl.replace(/\/$/, '')}/api/transcribe`, {
            method: 'POST',
            body: formData,
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error || `本機 API 連線錯誤 (${resp.status})`);
        }

        const data = await resp.json();
        if (!data.success) {
            throw new Error(data.error || '本機 API 回傳失敗');
        }
        return data.text || '';
    }

    async function localLlmAnalyze(transcript) {
        const apiUrl = getLocalLlmApiUrl();
        if (!apiUrl) throw new Error('請先設定本機 LLM API 網址');

        // Assuming local LLM uses OpenAI compatible /chat/completions endpoint
        const url = `${apiUrl.replace(/\/$/, '')}/chat/completions`;

        const body = {
            model: 'qwen2.5', // Default to qwen2.5, could be made configurable
            temperature: 0.2,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `以下是獸醫看診的逐字稿，請分析並分類：\n\n${transcript}` },
            ],
            // Some local providers like Ollama support response_format for JSON
            response_format: { type: 'json_object' }
        };

        const resp = await fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err?.error?.message || `本機 LLM API 錯誤 (${resp.status})`);
        }

        const data = await resp.json();
        return data?.choices?.[0]?.message?.content || '{}';
    }

    // =================================================================
    //  PROCESS AUDIO (dispatches to correct provider)
    // =================================================================
    async function processAudio(blob) {
        const key = getActiveApiKey();
        if (!key) {
            toast('請先設定 API Key', 'error');
            openModal(dom.settingsModal);
            return;
        }

        await acquireWakeLock();
        const provider = getProvider();
        let transcript = '';

        // Step 1: Transcribe
        showTranscriptLoading();
        try {
            if (provider === 'openai') {
                if (blob.size > 25 * 1024 * 1024) {
                    throw new Error('OpenAI Whisper 最大支援 25MB 音訊檔案');
                }
                showTranscriptLoading('使用 Whisper 轉錄中...');
                transcript = await openaiWhisperTranscribe(blob);
            } else if (provider === 'local') {
                showTranscriptLoading('使用本機 Qwen-ASR 轉錄中...');
                transcript = await localQwenTranscribe(blob);
            } else {
                const mimeType = getGeminiMimeType(blob);
                const isLargeFile = blob.size > 15 * 1024 * 1024;

                if (isLargeFile) {
                    showTranscriptLoading('上傳音訊檔案中...');
                    const fileInfo = await geminiUploadFile(blob);

                    showTranscriptLoading('等待檔案處理...');
                    let fileState = fileInfo.state;
                    let fileUri = fileInfo.uri;
                    while (fileState === 'PROCESSING') {
                        await new Promise((r) => setTimeout(r, 2000));
                        const statusResp = await fetchWithRetry(
                            `https://generativelanguage.googleapis.com/v1beta/${fileInfo.name}?key=${getGeminiKey()}`,
                            {}
                        );
                        const statusData = await statusResp.json();
                        fileState = statusData.state;
                        fileUri = statusData.uri;
                    }

                    showTranscriptLoading('轉錄中...');
                    transcript = await geminiGenerateFromFile(
                        fileUri,
                        mimeType,
                        '請將這段音訊完整轉錄為逐字稿。使用繁體中文。如果有多位說話者，請標註說話者（如：獸醫、飼主）。保留所有對話細節。',
                        null
                    );
                } else {
                    showTranscriptLoading('使用 Gemini 轉錄中...');
                    const base64 = await blobToBase64(blob);
                    transcript = await geminiGenerateContent(
                        base64,
                        mimeType,
                        '請將這段音訊完整轉錄為逐字稿。使用繁體中文。如果有多位說話者，請標註說話者（如：獸醫、飼主）。保留所有對話細節。',
                        null
                    );
                }
            }

            showTranscript(transcript);
            toast('逐字稿產生完成', 'success');

            // Step 2: Analyze
            showAnalysisLoading('分析產生中...');
            let analysisText = '';

            if (provider === 'local') {
                const llmProvider = getLocalLlmProvider();
                if (llmProvider === 'openai') {
                    if (!getOpenaiKey()) throw new Error('本機模式下未設定 OpenAI API Key，無法進行分析分類');
                    analysisText = await openaiChatAnalyze(transcript);
                } else if (llmProvider === 'local_llm') {
                    showAnalysisLoading('使用本機 LLM 分析中...');
                    analysisText = await localLlmAnalyze(transcript);
                } else {
                    if (!getGeminiKey()) throw new Error('本機模式下未設定 Gemini API Key，無法進行分析分類');
                    analysisText = await geminiAnalyzeText(transcript);
                }
            } else if (provider === 'openai') {
                analysisText = await openaiChatAnalyze(transcript);
            } else {
                analysisText = await geminiAnalyzeText(transcript);
            }

            const parsed = parseAnalysis(analysisText);
            showAnalysis(parsed);
            toast('分析完成', 'success');
            saveToHistory(transcript, parsed);
        } catch (err) {
            console.error('Process error:', err);
            hideTranscriptLoading();
            hideAnalysisLoading();
            toast(`處理失敗: ${err.message}`, 'error');
            showRetryButton(dom.analysisPlaceholder || dom.transcriptPlaceholder, () => processAudio(blob));
        } finally {
            await releaseWakeLock();
        }
    }

    function parseAnalysis(text) {
        try {
            let cleaned = text.trim();
            if (cleaned.startsWith('```')) {
                cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
            }
            return JSON.parse(cleaned);
        } catch {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                try { return JSON.parse(match[0]); } catch { /* noop */ }
            }
            return { other: [text] };
        }
    }

    // ===== UI Updates =====
    function showTranscriptLoading(msg = '轉錄中...') {
        dom.transcriptPlaceholder.style.display = 'none';
        dom.transcriptText.style.display = 'none';
        dom.transcriptActions.style.display = 'none';

        let el = document.getElementById('transcriptLoading');
        if (!el) {
            el = document.createElement('div');
            el.id = 'transcriptLoading';
            el.className = 'loading-overlay';
            el.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text">${msg}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:60%"></div></div>
      `;
            dom.transcriptText.parentElement.appendChild(el);
        } else {
            el.querySelector('.loading-text').textContent = msg;
            el.style.display = 'flex';
        }
    }

    function hideTranscriptLoading() {
        const el = document.getElementById('transcriptLoading');
        if (el) el.style.display = 'none';
        dom.transcriptPlaceholder.style.display = 'flex';
    }

    function showTranscript(text) {
        const el = document.getElementById('transcriptLoading');
        if (el) el.style.display = 'none';
        dom.transcriptPlaceholder.style.display = 'none';
        dom.transcriptText.textContent = text;
        dom.transcriptText.style.display = 'block';
        dom.transcriptActions.style.display = 'flex';
    }

    function showAnalysisLoading(msg = '分析中，正在分類整理...') {
        dom.analysisPlaceholder.style.display = 'none';
        dom.analysisResult.style.display = 'none';
        dom.analysisActions.style.display = 'none';

        let el = document.getElementById('analysisLoading');
        if (!el) {
            el = document.createElement('div');
            el.id = 'analysisLoading';
            el.className = 'loading-overlay';
            el.innerHTML = `
        <div class="spinner"></div>
        <div class="loading-text">${msg}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:40%"></div></div>
      `;
            dom.analysisResult.parentElement.appendChild(el);
        } else {
            el.querySelector('.loading-text').textContent = msg;
            el.style.display = 'flex';
        }
    }

    function hideAnalysisLoading() {
        const el = document.getElementById('analysisLoading');
        if (el) el.style.display = 'none';
        dom.analysisPlaceholder.style.display = 'flex';
    }

    function showRetryButton(container, retryFn) {
        // Remove any existing retry button
        document.querySelectorAll('.retry-container').forEach(el => el.remove());
        const div = document.createElement('div');
        div.className = 'retry-container';
        div.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:0.75rem; padding:1.5rem; text-align:center;';
        div.innerHTML = `
            <p style="color:var(--text-tertiary); font-size:0.875rem;">自動重試均失敗，請確認網路連線後手動重試</p>
            <button class="btn btn-primary" id="retryBtn">🔄 重試</button>
        `;
        container.after(div);
        div.querySelector('#retryBtn').addEventListener('click', () => {
            div.remove();
            retryFn();
        });
    }

    function showAnalysis(data) {
        const el = document.getElementById('analysisLoading');
        if (el) el.style.display = 'none';
        dom.analysisPlaceholder.style.display = 'none';
        dom.analysisResult.style.display = 'block';
        dom.analysisActions.style.display = 'flex';

        let html = '';
        for (const cat of CATEGORIES) {
            const items = data[cat.key] || [];
            const count = items.length;
            const hasItems = count > 0 && !(count === 1 && items[0] === '未提及');
            const isEmpty = !hasItems;

            html += `
        <div class="category-section ${cat.cssClass}">
          <div class="category-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="category-badge">${cat.icon}</span>
            <span class="category-name">${cat.name}</span>
            <span class="category-count">${isEmpty ? '未提及' : `${count} 項`}</span>
          </div>
          <div class="category-body">
            ${isEmpty
                    ? '<div class="category-item not-mentioned">對話中未提及此類別</div>'
                    : items.map((item) => `<div class="category-item">${escapeHtml(item)}</div>`).join('')
                }
          </div>
        </div>`;
        }

        dom.analysisResult.innerHTML = html;
    }

    // ===== History =====
    function getHistory() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
        } catch {
            return [];
        }
    }

    function saveToHistory(transcript, analysis) {
        const history = getHistory();
        history.unshift({
            id: Date.now(),
            date: new Date().toLocaleString('zh-TW'),
            transcript,
            analysis,
        });
        if (history.length > 50) history.length = 50;
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    }

    function renderHistory() {
        const history = getHistory();
        if (history.length === 0) {
            dom.historyList.innerHTML = `
        <div class="transcript-placeholder" style="min-height: 100px;">
          <span>尚無歷史記錄</span>
        </div>`;
            return;
        }

        dom.historyList.innerHTML = history
            .map(
                (item) => `
      <div class="history-item" data-id="${item.id}">
        <div class="history-item-info">
          <div class="history-item-date">${item.date}</div>
          <div class="history-item-preview">${escapeHtml(item.transcript.substring(0, 80))}...</div>
        </div>
        <div class="history-item-actions">
          <button class="history-delete-btn" data-id="${item.id}" title="刪除">🗑️</button>
        </div>
      </div>`
            )
            .join('');

        dom.historyList.querySelectorAll('.history-item').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.history-delete-btn')) return;
                loadHistoryItem(parseInt(el.dataset.id));
            });
        });

        dom.historyList.querySelectorAll('.history-delete-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteHistoryItem(parseInt(btn.dataset.id));
            });
        });
    }

    function loadHistoryItem(id) {
        const item = getHistory().find((h) => h.id === id);
        if (!item) return;
        showTranscript(item.transcript);
        showAnalysis(item.analysis);
        closeModal(dom.historyModal);
        toast('已載入歷史記錄', 'info');
    }

    function deleteHistoryItem(id) {
        const history = getHistory().filter((h) => h.id !== id);
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
        renderHistory();
        toast('已刪除記錄', 'info');
    }

    function clearHistory() {
        if (!confirm('確定要清除所有歷史記錄嗎？')) return;
        localStorage.removeItem(STORAGE_KEYS.HISTORY);
        renderHistory();
        toast('已清除所有歷史記錄', 'info');
    }

    // ===== Export / Import =====
    function exportJson() {
        const transcript = dom.transcriptText.textContent;
        const analysisData = getCurrentAnalysisData();
        const data = {
            exportDate: new Date().toISOString(),
            app: 'VetScribe',
            transcript,
            analysis: analysisData,
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `VetScribe_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('已匯出 JSON', 'success');
    }

    function getCurrentAnalysisData() {
        const result = {};
        CATEGORIES.forEach((cat) => {
            const section = dom.analysisResult.querySelector(`.${cat.cssClass}`);
            if (section) {
                const items = section.querySelectorAll('.category-item:not(.not-mentioned)');
                result[cat.key] = Array.from(items).map((el) => el.textContent.trim());
            } else {
                result[cat.key] = [];
            }
        });
        return result;
    }

    function importJson(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.transcript) showTranscript(data.transcript);
                if (data.analysis) showAnalysis(data.analysis);
                closeModal(dom.historyModal);
                toast('已匯入記錄', 'success');
                if (data.transcript && data.analysis) {
                    saveToHistory(data.transcript, data.analysis);
                }
            } catch {
                toast('匯入失敗：無效的 JSON 格式', 'error');
            }
        };
        reader.readAsText(file);
    }

    // ===== Settings =====
    function loadSettings() {
        dom.providerSelect.value = getProvider();
        dom.apiKeyInput.value = getGeminiKey();
        dom.modelSelect.value = getGeminiModel();
        dom.openaiKeyInput.value = getOpenaiKey();
        dom.openaiModelSelect.value = getOpenaiModel();
        dom.localApiInput.value = getLocalApiUrl();
        dom.localLlmApiInput.value = getLocalLlmApiUrl();
        dom.localLlmSelect.value = getLocalLlmProvider();
        toggleSettingsView();
    }

    function toggleSettingsView() {
        const p = dom.providerSelect.value;
        dom.geminiSettings.style.display = p === 'gemini' ? 'block' : 'none';
        dom.openaiSettings.style.display = p === 'openai' ? 'block' : 'none';
        dom.localSettings.style.display = p === 'local' ? 'block' : 'none';
    }

    function saveSettings() {
        localStorage.setItem(STORAGE_KEYS.PROVIDER, dom.providerSelect.value);
        localStorage.setItem(STORAGE_KEYS.GEMINI_KEY, dom.apiKeyInput.value.trim());
        localStorage.setItem(STORAGE_KEYS.GEMINI_MODEL, dom.modelSelect.value);
        localStorage.setItem(STORAGE_KEYS.OPENAI_KEY, dom.openaiKeyInput.value.trim());
        localStorage.setItem(STORAGE_KEYS.OPENAI_MODEL, dom.openaiModelSelect.value);
        localStorage.setItem(STORAGE_KEYS.LOCAL_API, dom.localApiInput.value.trim());
        localStorage.setItem(STORAGE_KEYS.LOCAL_LLM_API, dom.localLlmApiInput.value.trim());
        localStorage.setItem(STORAGE_KEYS.LOCAL_LLM, dom.localLlmSelect.value);
        toast('設定已儲存', 'success');
        updateApiStatus();
        closeModal(dom.settingsModal);
    }

    function updateApiStatus() {
        const p = getProvider();
        let key = '';
        let label = '';
        if (p === 'openai') {
            key = getOpenaiKey();
            label = 'OpenAI';
        } else if (p === 'local') {
            key = getLocalApiUrl();
            label = 'Local (本機)';
        } else {
            key = getGeminiKey();
            label = 'Gemini';
        }

        if (key) {
            dom.apiStatusText.textContent = `已連接 ${label}`;
            dom.apiStatusDot.className = 'api-status-dot active';
        } else {
            dom.apiStatusText.textContent = `未設置 ${label}`;
            dom.apiStatusDot.className = 'api-status-dot';
        }
    }

    // ===== Modal =====
    function openModal(modal) {
        modal.classList.add('active');
    }

    function closeModal(modal) {
        modal.classList.remove('active');
    }

    // ===== Toast =====
    function toast(msg, type = 'info') {
        const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(msg)}</span>`;
        dom.toastContainer.appendChild(el);
        setTimeout(() => {
            el.classList.add('toast-exit');
            setTimeout(() => el.remove(), 300);
        }, 3500);
    }

    // ===== Utils =====
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(
            () => toast('已複製到剪貼簿', 'success'),
            () => toast('複製失敗', 'error')
        );
    }

    // ===== Event Bindings =====
    function bindEvents() {
        // Record
        // Record button: toggle start / pause / resume
        dom.recordBtn.addEventListener('click', toggleRecording);
        dom.stopBtn.addEventListener('click', stopRecording);

        // Upload
        dom.uploadArea.addEventListener('click', () => dom.audioFileInput.click());
        dom.audioFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) handleFileUpload(e.target.files[0]);
        });
        dom.uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            dom.uploadArea.style.borderColor = 'var(--accent)';
        });
        dom.uploadArea.addEventListener('dragleave', () => {
            dom.uploadArea.style.borderColor = '';
        });
        dom.uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            dom.uploadArea.style.borderColor = '';
            if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
        });

        // Download audio
        dom.downloadAudioBtn.addEventListener('click', downloadAudio);

        // URL analysis
        dom.analyzeUrlBtn.addEventListener('click', () => {
            const url = dom.videoUrlInput.value.trim();
            if (!url) {
                toast('請輸入影片網址', 'error');
                return;
            }
            processVideoUrl(url);
        });
        dom.videoUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') dom.analyzeUrlBtn.click();
        });

        // Copy
        dom.copyTranscriptBtn.addEventListener('click', () => {
            copyToClipboard(dom.transcriptText.textContent);
        });
        dom.copyAnalysisBtn.addEventListener('click', () => {
            const data = getCurrentAnalysisData();
            let text = '';
            CATEGORIES.forEach((cat) => {
                const items = data[cat.key] || [];
                text += `【${cat.icon} ${cat.name}】\n`;
                if (items.length === 0) {
                    text += '  未提及\n';
                } else {
                    items.forEach((item) => { text += `  • ${item}\n`; });
                }
                text += '\n';
            });
            copyToClipboard(text);
        });

        // Export
        dom.exportJsonBtn.addEventListener('click', exportJson);

        // Settings
        dom.settingsBtn.addEventListener('click', () => {
            loadSettings();
            openModal(dom.settingsModal);
        });
        dom.closeSettingsBtn.addEventListener('click', () => closeModal(dom.settingsModal));
        dom.cancelSettingsBtn.addEventListener('click', () => closeModal(dom.settingsModal));
        dom.saveSettingsBtn.addEventListener('click', saveSettings);

        // Provider toggle in settings
        dom.providerSelect.addEventListener('change', toggleSettingsView);

        // History
        dom.historyBtn.addEventListener('click', () => {
            renderHistory();
            openModal(dom.historyModal);
        });
        dom.closeHistoryBtn.addEventListener('click', () => closeModal(dom.historyModal));
        dom.clearHistoryBtn.addEventListener('click', clearHistory);
        dom.importJsonBtn.addEventListener('click', () => dom.jsonFileInput.click());
        dom.jsonFileInput.addEventListener('change', (e) => {
            if (e.target.files[0]) importJson(e.target.files[0]);
        });

        // Close modals on backdrop click
        [dom.settingsModal, dom.historyModal].forEach((modal) => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal(modal);
            });
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal(dom.settingsModal);
                closeModal(dom.historyModal);
            }
        });
    }

    // ===== Boot =====
    document.addEventListener('DOMContentLoaded', init);
})();
