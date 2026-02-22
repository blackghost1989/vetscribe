# VetScribe 本機 AI 語音辨識部署指南

這份指南將協助你在自己的電腦上部署 **Qwen3-ASR** 語音辨識模型。透過這個方式，你的錄音檔案將完完全全在本地端進行運算與轉錄，不用擔心隱私外洩問題，同時也可以繞過部分雲端 API 的長度或大小限制。

我們的策略是：在本地建立一個小型的 API 伺服器 (FastAPI)，當前端網頁有轉錄需求時，直接把音檔丟到這個本機伺服器來處理。

## 系統需求

- Python 3.9 或以上版本
- 建議配有至少 8GB VRAM 的 NVIDIA 顯示卡，或者至少有 16GB 以上的記憶體 (若使用 CPU，速度會較慢)。
- 能連上網路 (第一次執行需下載模型檔案，約佔數 GB)。

## 步驟 1：安裝必要套件

打開終端機 (Terminal) 或命令提示字元 (cmd / PowerShell)，建立一個虛擬環境並安裝以下套件：

```bash
# 建立並啟動虛擬環境 (建議)
python -m venv venv
# Windows 啟動虛擬環境: venv\scripts\activate
# Mac/Linux 啟動虛擬環境: source venv/bin/activate

# 安裝核心依賴
pip install fastapi uvicorn python-multipart
pip install torch torchaudio
pip install qwen_asr silero_vad
```

> **注意：** `qwen_asr` 若有安裝上的問題，請參考 [Qwen3-ASR 官方 GitHub](https://github.com/QwenLM/Qwen3-ASR) 的最新安裝指令。

## 步驟 2：建立伺服器程式碼

在你喜歡的位置（例如 VetScribe 專案資料夾底下，或另開新資料夾），新增一個名為 `server.py` 的檔案，並將以下程式碼貼入：

```python
import os
import tempfile
import torch
import torchaudio
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from qwen_asr import QwenASR
from silero_vad import load_silero_vad, get_speech_timestamps

# 1. 啟動 FastAPI 服務並設定 CORS (給 VetScribe 前端跨域呼叫)
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    # 如果你的 VetScribe 只在單機直接點開 (file://) 或是 local server (localhost, 127.0.0.1)
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. 載入模型（啟動伺服器時就會載入，會佔用記憶體/顯存）
print("正在載入 Qwen3-ASR 與 VAD 模型，請稍候...")
try:
    # 預設使用 1.7B 模型，視設備效能可更換大小
    asr_model = QwenASR("Qwen/Qwen3-ASR-1.7B") 
    vad_model = load_silero_vad()
    print("模型載入完成！伺服器準備就緒。")
except Exception as e:
    print(f"模型載入失敗: {e}")

# 3. 定義轉錄端點
@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    # 建立暫存檔存放上傳的音軌
    temp_ext = os.path.splitext(audio.filename)[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=temp_ext) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # A. 預處理音檔並使用 VAD 切割 (避免長音檔 OOM)
        wav, sr = torchaudio.load(tmp_path)
        
        # Qwen 與 Silero VAD 建議的採樣率通常為 16000Hz
        if sr != 16000:
            wav = torchaudio.functional.resample(wav, sr, 16000)
            
        # 轉換為單聲道
        if wav.shape[0] > 1:
            wav = wav.mean(dim=0, keepdim=True)
            
        print("開始進行 Voice Activity Detection (VAD) 分段...")
        speech_timestamps = get_speech_timestamps(wav[0], vad_model, sampling_rate=16000)
        
        full_transcript = []
        
        print(f"分段完成，共 {len(speech_timestamps)} 段。開始依序進行辨識...")
        
        # B. 依序將片段送給 Qwen-ASR 辨識
        for i, ts in enumerate(speech_timestamps):
            chunk = wav[:, ts['start']:ts['end']]
            
            # 將單一 chunk 寫入暫存檔
            chunk_path = f"temp_chunk_{i}.wav"
            torchaudio.save(chunk_path, chunk, 16000)
            
            try:
                # 進行辨識
                # 依據你的 qwen_asr 版本，呼叫方式可能略有不同，請確保 result 的格式正確解開
                result = asr_model.transcribe(chunk_path)
                
                # 取得文字結果 (假設 result 是 list of dicts 或單純 dict)
                if isinstance(result, list) and len(result) > 0:
                    text = result[0].get("text", "")
                elif isinstance(result, dict):
                    text = result.get("text", "")
                else:
                    text = str(result)
                    
                if text:
                    full_transcript.append(text)
                    print(f"片段 {i+1} 辨識完成: {text[:20]}...")
            except Exception as e:
                print(f"片段 {i+1} 辨識錯誤: {e}")
            finally:
                if os.path.exists(chunk_path):
                    os.remove(chunk_path)
                    
        final_text = " ".join(full_transcript)
        print("完整音檔辨識完畢。")
        return {"success": True, "text": final_text}

    except Exception as e:
        print(f"處理過程發生錯誤: {e}")
        return {"success": False, "error": str(e)}
        
    finally:
        # 清理原始上傳的暫存檔
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
```

## 步驟 3：啟動 API 伺服器

完成腳本後，在相同的終端機視窗，輸入以下指令啟動 FastAPI 伺服器：

```bash
uvicorn server:app --host 127.0.0.1 --port 8000
```

> 第一次執行時，程式會去 HuggingFace 自動下載 `QwenLM/Qwen3-ASR-1.7B` 以及 `silero-vad` 的模型檔案（視網路速度可能需要數分鐘到數十分鐘）。等到畫面出現 `模型載入完成！伺服器準備就緒。` 以及 `Application startup complete.`，代表部署成功。

## 步驟 4：設定 VetScribe 網頁端

1. 開啟你的 VetScribe 網頁 (`index.html`)。
2. 點擊右上角的 **⚙️ 設定** 按鈕。
3. **API 服務商** 選擇 `Local Qwen3-ASR (本機端)`。
4. **Local API URL** 欄位保持預設或填入 `http://127.0.0.1:8000` (如果你的命令列顯示在其他 port 上，請修改此處)。
5. 選擇你要用來把逐字稿做「**重點分類跟分離角色**」的 LLM 模型 (Gemini 或 OpenAI)。*注意：本機設定只負責聽打出逐字稿，這一步驟為了聰明的醫學邏輯分類體驗，目前依然串接原本輕量且快速的雲端文字大模型。*
6. 點擊儲存，此時如果系統顯示「已連接 Local (本機)」，代表設定完成。

恭喜！現在你送出的任何龐大的錄音檔，或者是現場即將錄音的資料，都會發到你背景正在執行的終端機由你現成的卡機處理。你可以隨時看終端機跳動的進度條得知狀態。
