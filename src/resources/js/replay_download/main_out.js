/**
 * Main script for converting Pikachu Volleyball replay files to video
 * OFFLINE RENDERING (High Speed)
 * - Audio: Reconstructs stereo sound by hooking fakeAudio
 * - UI: Burns HTML overlays (Nicknames, Chat) directly into Canvas
 * Uses 'mp4-muxer' library
 * 
 * FIXED VERSION: Audio debugging and symmetric positioning
 */
'use strict';
import { settings } from '@pixi/settings';
import { SCALE_MODES } from '@pixi/constants';
import { Renderer, BatchRenderer, autoDetectRenderer } from '@pixi/core';
import { Prepare } from '@pixi/prepare';
import { Container } from '@pixi/display';
import { Loader } from '@pixi/loaders';
import { SpritesheetLoader } from '@pixi/spritesheet';
import { CanvasRenderer } from '@pixi/canvas-renderer';
import { CanvasSpriteRenderer } from '@pixi/canvas-sprite';
import { CanvasPrepare } from '@pixi/canvas-prepare';
import '@pixi/canvas-display';
import { ASSETS_PATH } from '../offline_version_js/assets_path.js';
import { PikachuVolleyballReplay } from './pikavolley_replay.js';
import { setGetSpeechBubbleNeeded } from '../chat_display.js';
import { serialize } from '../utils/serialize.js';
import { getHashCode } from '../utils/hash_code.js';
import '../../style.css';

// npm install mp4-muxer 필요
import * as Mp4Muxer from 'mp4-muxer';

console.log('🎬 [INIT] Offline Renderer (FIXED - Audio Debug & Symmetric UI)');

// [1] 전역 DOM 패치
const originalReplaceChild = Node.prototype.replaceChild;
Node.prototype.replaceChild = function(newChild, oldChild) {
    try { return originalReplaceChild.call(this, newChild, oldChild); } 
    catch (e) { try { this.appendChild(newChild); } catch (e2) {} return newChild; }
};
const originalRemoveChild = Node.prototype.removeChild;
Node.prototype.removeChild = function(child) {
    try { return originalRemoveChild.call(this, child); } catch (e) { return null; }
};

class OfflineConverter {
  constructor() {
    Renderer.registerPlugin('prepare', Prepare);
    Renderer.registerPlugin('batch', BatchRenderer);
    CanvasRenderer.registerPlugin('prepare', CanvasPrepare);
    CanvasRenderer.registerPlugin('sprite', CanvasSpriteRenderer);
    Loader.registerPlugin(SpritesheetLoader);
    settings.RESOLUTION = 2;
    settings.SCALE_MODE = SCALE_MODES.NEAREST;
    settings.ROUND_PIXELS = true;

    this.renderer = null;
    this.stage = null;
    this.loader = null;
    this.pikaVolley = null;
    
    // 오디오 기록용
    this.audioLog = []; // { key: string, frame: number, pan: number }
    this.decodedBuffers = {}; 
    this.totalDuration = 0;
    
    this.muxer = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
  }

  updateStatus(message) {
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = message;
    console.log(`📝 [STATUS] ${message}`);
  }

  handleRecordButtonClick() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.txt';
    fileInput.onchange = (e) => {
      //@ts-ignore
      const file = e.target.files[0];
      if (file) this.loadReplayFile(file);
    };
    fileInput.click();
  }

  loadReplayFile(file) {
    this.updateStatus('리플레이 분석 중...');
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        //@ts-ignore
        const packWithComment = JSON.parse(event.target.result);
        const pack = packWithComment.pack;
        
        // 해시 검증 (경고만)
        const originalHash = pack.hash;
        pack.hash = 0;
        if (originalHash !== getHashCode(serialize(pack))) {
             console.warn('⚠️ [HASH] Hash mismatch - ignored');
        }
        pack.hash = originalHash;

        this.initializeRenderer(pack);
      } catch (err) {
        console.error('❌ [LOAD] Error:', err);
        this.updateStatus('파일 로딩 실패');
      }
    };
    reader.readAsText(file);
  }

  initializeRenderer(pack) {
    this.updateStatus('리소스 및 오디오 디코딩 중...');
    
    this.renderer = autoDetectRenderer({
      width: 432,
      height: 304,
      antialias: false,
      backgroundColor: 0x000000,
      forceCanvas: true,
      preserveDrawingBuffer: true,
    });

    this.stage = new Container();
    this.loader = new Loader();

    const container = document.querySelector('#game-canvas-container');
    container.innerHTML = '';
    container.appendChild(this.renderer.view);
    
    this.ensureDOMElements(container); 

    this.loader.add(ASSETS_PATH.SPRITE_SHEET);
    
    // [오디오 준비] Web Audio API용 버퍼 디코딩
    const soundLoadPromises = [];
    //@ts-ignore
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext();
    
    console.log('🔊 [AUDIO] Starting audio decoding...');
    console.log('🔊 [AUDIO] Sound files:', Object.keys(ASSETS_PATH.SOUNDS));
    
    for (const key in ASSETS_PATH.SOUNDS) {
        const url = ASSETS_PATH.SOUNDS[key];
        console.log(`🔊 [AUDIO] Decoding: ${key} from ${url}`);
        const promise = fetch(url)
            .then(res => {
                console.log(`📥 [AUDIO] Fetched: ${key}, size: ${res.headers.get('content-length')}`);
                return res.arrayBuffer();
            })
            .then(buf => {
                console.log(`📦 [AUDIO] Buffer received: ${key}, size: ${buf.byteLength}`);
                return audioCtx.decodeAudioData(buf);
            })
            .then(decoded => {
                // ⭐ 중요: 소문자로 저장하여 fakeAudio.sounds 키와 일치시킴
                const normalizedKey = key.toLowerCase();
                this.decodedBuffers[normalizedKey] = decoded;
                console.log(`✅ [AUDIO] Decoded: ${key} → stored as "${normalizedKey}", duration: ${decoded.duration.toFixed(2)}s, channels: ${decoded.numberOfChannels}`);
            })
            .catch(err => {
                console.error(`❌ [AUDIO] Failed to decode ${key}:`, err);
            });
        soundLoadPromises.push(promise);
        this.loader.add(ASSETS_PATH.SOUNDS[key]);
    }

    Promise.all(soundLoadPromises).then(() => {
        console.log('✅ [AUDIO] All sounds decoded');
        console.log('🔑 [AUDIO] Available buffer keys:', Object.keys(this.decodedBuffers));
        this.loader.load(() => this.startOfflineProcessing(pack));
    });
  }

  ensureDOMElements(container) {
    const ids = [
        'player1-chat-box', 'player2-chat-box', 
        'player1-nickname', 'player2-nickname', 
        'player1-partial-ip', 'player2-partial-ip',
        'player1-chat-disabled', 'player2-chat-disabled'
    ];
    ids.forEach(id => {
        if (!document.getElementById(id)) {
            const el = document.createElement('div');
            el.id = id;
            el.style.display = 'none';
            container.appendChild(el);
        }
    });
  }

  async startOfflineProcessing(pack) {
    this.updateStatus('오프라인 렌더링 시작...');
    
    this.pikaVolley = new PikachuVolleyballReplay(
      this.stage,
      this.loader.resources,
      pack.roomID,
      pack.nicknames,
      pack.partialPublicIPs,
      pack.inputs,
      pack.options,
      pack.chats
    );

    try {
        //@ts-ignore
        setGetSpeechBubbleNeeded(this.pikaVolley); 
    } catch(e){
        console.warn('⚠️ [GAME] setGetSpeechBubbleNeeded failed:', e);
    }
    
    this.pikaVolley.willDisplayChat = true;

    // [핵심] 오디오 후킹
    this.audioLog = [];
    this.mockAudioSystem();

    const fps = 30;
    const totalFrames = pack.inputs.length;
    this.totalDuration = totalFrames / fps;

    console.log(`📊 [RENDER] Total frames: ${totalFrames}, duration: ${this.totalDuration.toFixed(2)}s`);

    // Muxer 설정
    this.muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: 432, height: 304 },
        audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 },
        fastStart: 'in-memory',
    });

    this.videoEncoder = new VideoEncoder({
        output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
        error: (e) => console.error('❌ [VIDEO] Encoder error:', e)
    });
    this.videoEncoder.configure({
        codec: 'avc1.42001f',
        width: 432,
        height: 304,
        bitrate: 2_500_000,
        framerate: fps,
    });

    this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('❌ [AUDIO] Encoder error:', e)
    });
    this.audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: 44100,
        numberOfChannels: 2,
        bitrate: 128_000,
    });

    const progressBar = document.getElementById('progress-bar');
    
    // [STEP 1] 비디오 렌더링
    for (let i = 0; i < totalFrames; i++) {
        if (this.videoEncoder.encodeQueueSize > 20) {
            await new Promise(r => setTimeout(r, 10));
        }

        try {
            this.pikaVolley.gameLoopSilent(); 
        } catch(e) {
            if (i % 1000 === 0) console.warn(`⚠️ [RENDER] Frame ${i} error:`, e);
        }

        this.renderer.render(this.stage);
        this.drawOverlaysOnCanvas();

        const bitmap = await createImageBitmap(this.renderer.view);
        const videoFrame = new VideoFrame(bitmap, { timestamp: (i * 1000000) / fps });
        
        const keyFrame = i % 90 === 0;
        this.videoEncoder.encode(videoFrame, { keyFrame });
        videoFrame.close();

        if (i % 30 === 0) {
            const percent = Math.floor((i / totalFrames) * 100);
            this.updateStatus(`영상 처리 중... ${percent}%`);
            if(progressBar) progressBar.style.width = `${percent}%`;
            await new Promise(r => setTimeout(r, 0));
        }
    }

    await this.videoEncoder.flush();
    console.log('✅ [VIDEO] All frames encoded');
    
    // [STEP 2] 오디오 재조립
    console.log(`🔊 [AUDIO] Audio log entries: ${this.audioLog.length}`);
    if (this.audioLog.length > 0) {
        console.log('🔊 [AUDIO] Sample events:', this.audioLog.slice(0, 5));
    }
    
    this.updateStatus('오디오 합성 중...');
    await this.synthesizeAndEncodeAudio(fps);

    // [STEP 3] 저장
    this.muxer.finalize();
    const buffer = this.muxer.target.buffer;
    this.saveFile(buffer);
  }

  mockAudioSystem() {
    console.log('🔊 [AUDIO-HOOK] Starting mockAudioSystem...');
    this.pikaVolley.audio.turnBGMVolume(false);
    this.pikaVolley.audio.turnSFXVolume(true);

    const fakeSounds = this.pikaVolley.fakeAudio.sounds;
    console.log('🔊 [AUDIO-HOOK] fakeAudio.sounds keys:', Object.keys(fakeSounds));
    
    // 각 사운드 키를 새로운 객체로 교체
    for (const key in fakeSounds) {
        if (key === 'bgm') {
            console.log('🔇 [AUDIO-HOOK] Skipping BGM');
            continue;
        }
        
        console.log(`🔊 [AUDIO-HOOK] Hooking sound: "${key}"`);
        
        // 새 객체 할당 (중요: 참조 끊기)
        fakeSounds[key] = {
            play: (pan = 0) => {
                const currentFrame = this.pikaVolley.replayFrameCounter;
                console.log(`🎵 [AUDIO-EVENT] Sound: "${key}", Frame: ${currentFrame}, Pan: ${pan}`);
                this.audioLog.push({
                    key: key,
                    frame: currentFrame,
                    pan: pan
                });
            },
            stop: () => {}
        };
    }
    console.log('✅ [AUDIO-HOOK] mockAudioSystem complete');
  }

  async synthesizeAndEncodeAudio(fps) {
    if (this.audioLog.length === 0) {
        console.warn('⚠️ [AUDIO] No audio events recorded - skipping audio synthesis');
        return;
    }

    console.log(`🔊 [AUDIO-SYNTH] Starting synthesis with ${this.audioLog.length} events`);

    const sampleRate = 44100;
    const length = Math.ceil(this.totalDuration * sampleRate) + sampleRate; 
    
    console.log(`🔊 [AUDIO-SYNTH] Creating OfflineAudioContext: ${length} samples, ${this.totalDuration.toFixed(2)}s`);
    const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

    let eventCount = 0;
    let skippedCount = 0;
    this.audioLog.forEach((log, index) => {
        const buffer = this.decodedBuffers[log.key];
        if (!buffer) {
            skippedCount++;
            if (index < 5) {
                console.warn(`⚠️ [AUDIO-SYNTH] No buffer for key: "${log.key}"`);
                console.warn(`   Available keys: ${Object.keys(this.decodedBuffers).join(', ')}`);
            }
            return;
        }

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;

        // 스테레오 패닝
        const panner = offlineCtx.createStereoPanner();
        panner.pan.value = (log.pan || 0) * 0.75;

        source.connect(panner);
        panner.connect(offlineCtx.destination);
        
        const startTime = log.frame / fps;
        source.start(startTime);
        
        eventCount++;
        if (index < 5 || index % 100 === 0) {
            console.log(`🎵 [AUDIO-SYNTH] Event ${index}: ${log.key} at ${startTime.toFixed(2)}s, pan: ${panner.pan.value.toFixed(2)}`);
        }
    });

    console.log(`✅ [AUDIO-SYNTH] Placed ${eventCount} audio events (skipped ${skippedCount} due to missing buffers)`);
    console.log('🔊 [AUDIO-SYNTH] Starting offline rendering...');
    
    const renderedBuffer = await offlineCtx.startRendering();
    
    console.log(`✅ [AUDIO-SYNTH] Rendered: ${renderedBuffer.length} samples, ${renderedBuffer.duration.toFixed(2)}s`);
    
    // 샘플 확인 (디버깅)
    const leftChannel = renderedBuffer.getChannelData(0);
    const rightChannel = renderedBuffer.getChannelData(1);
    let maxLeft = 0, maxRight = 0;
    for (let i = 0; i < Math.min(1000, leftChannel.length); i++) {
        maxLeft = Math.max(maxLeft, Math.abs(leftChannel[i]));
        maxRight = Math.max(maxRight, Math.abs(rightChannel[i]));
    }
    console.log(`🔊 [AUDIO-SYNTH] Sample check - Left peak: ${maxLeft.toFixed(4)}, Right peak: ${maxRight.toFixed(4)}`);

    // AudioEncoder에 주입
    console.log('🔊 [AUDIO-ENCODE] Starting audio encoding...');
    const chunkSize = 4096;  // 작은 청크로 변경 (더 안정적)
    const lengthSamples = renderedBuffer.length;
    const numberOfChannels = renderedBuffer.numberOfChannels;

    let encodedChunks = 0;
    for (let frame = 0; frame < lengthSamples; frame += chunkSize) {
        const size = Math.min(chunkSize, lengthSamples - frame);
        
        // Planar 형식: [L0, L1, ..., Ln, R0, R1, ..., Rn]
        const planarData = new Float32Array(size * numberOfChannels);
        
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = renderedBuffer.getChannelData(ch);
            const offset = ch * size;
            for (let i = 0; i < size; i++) {
                planarData[offset + i] = channelData[frame + i];
            }
        }

        const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: sampleRate,
            numberOfChannels: numberOfChannels,
            numberOfFrames: size,
            timestamp: (frame / sampleRate) * 1_000_000,
            data: planarData.buffer,  // ArrayBuffer 전달
        });

        this.audioEncoder.encode(audioData);
        audioData.close();
        
        encodedChunks++;
        if (encodedChunks % 100 === 0) {
            console.log(`🔊 [AUDIO-ENCODE] Encoded ${encodedChunks} chunks`);
        }
    }

    await this.audioEncoder.flush();
    console.log(`✅ [AUDIO-ENCODE] Complete - ${encodedChunks} chunks encoded`);
  }

  saveFile(buffer) {
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    
    console.log(`💾 [SAVE] File size: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    let filename = `${dateStr}_${timeStr}_pikavolley_replay.mp4`;
    
    if (this.pikaVolley.nicknames && this.pikaVolley.nicknames.length === 2) {
        const n1 = this.pikaVolley.nicknames[0].replace(/[/\\?%*:|"<>]/g, '_');
        const n2 = this.pikaVolley.nicknames[1].replace(/[/\\?%*:|"<>]/g, '_');
        filename = `${dateStr}_${timeStr}_${n1}_vs_${n2}.mp4`;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    
    this.updateStatus('완료!');
    const recordBtn = document.getElementById('record-btn');
    //@ts-ignore
    if (recordBtn) recordBtn.disabled = false;
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    
    setTimeout(() => {
        URL.revokeObjectURL(url);
        this.muxer = null;
        this.videoEncoder = null;
        this.audioEncoder = null;
        this.audioLog = [];
    }, 1000);
  }

  // [핵심] 중앙 대칭 UI
  drawOverlaysOnCanvas() {
    const ctx = this.renderer.view.getContext('2d');
    if (!ctx) return;

    ctx.save();
    
    // 중앙 기준 대칭 위치 (432 / 2 = 216 중심)
    const centerX = 216;
    const offsetX = 136;  // 중앙에서 136px 떨어진 위치
    const leftX = centerX - offsetX;   // 80
    const rightX = centerX + offsetX;  // 352

    const p1Nick = document.getElementById('player1-nickname')?.textContent || '';
    const p1IP = document.getElementById('player1-partial-ip')?.textContent || '';
    const p2Nick = document.getElementById('player2-nickname')?.textContent || '';
    const p2IP = document.getElementById('player2-partial-ip')?.textContent || '';

    // Player 1 (Left) - 중앙 정렬
    if (p1Nick) {
        ctx.font = 'bold 16px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';  // 중앙 정렬
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.strokeText(p1Nick, leftX, 10);
        ctx.fillText(p1Nick, leftX, 10);
        
        if (p1IP) {
            ctx.font = '12px sans-serif';
            ctx.strokeText(p1IP, leftX, 30);
            ctx.fillText(p1IP, leftX, 30);
        }
    }

    // Player 2 (Right) - 중앙 정렬
    if (p2Nick) {
        ctx.font = 'bold 16px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';  // 중앙 정렬
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 3;
        ctx.strokeText(p2Nick, rightX, 10);
        ctx.fillText(p2Nick, rightX, 10);
        
        if (p2IP) {
            ctx.font = '12px sans-serif';
            ctx.strokeText(p2IP, rightX, 30);
            ctx.fillText(p2IP, rightX, 30);
        }
    }

    // 채팅 말풍선 (동일한 x 좌표 사용)
    this.drawChatBubble(ctx, 'player1-chat-box', leftX, 60);
    this.drawChatBubble(ctx, 'player2-chat-box', rightX, 60);
    
    ctx.restore();
  }

  drawChatBubble(ctx, elementId, x, y) {
      const el = document.getElementById(elementId);
      if (!el || !el.textContent || el.textContent.trim() === '') return;
      
      const text = el.textContent;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      
      const textMetrics = ctx.measureText(text);
      const width = textMetrics.width + 20;
      const height = 30;

      // 말풍선 배경
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(x - width / 2, y, width, height);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - width / 2, y, width, height);

      // 텍스트
      ctx.fillStyle = 'black';
      ctx.fillText(text, x, y + 10);
  }
}

function adjustAssetsPath() {
  const prefix = '../../';
  if (!ASSETS_PATH.SPRITE_SHEET.startsWith(prefix)) {
    const clean = (p) => p.replace(/^\.\.\//, '');
    ASSETS_PATH.SPRITE_SHEET = prefix + clean(ASSETS_PATH.SPRITE_SHEET);
    for (const k in ASSETS_PATH.SOUNDS) ASSETS_PATH.SOUNDS[k] = prefix + clean(ASSETS_PATH.SOUNDS[k]);
  }
}
adjustAssetsPath();

const converter = new OfflineConverter();
const recordBtn = document.getElementById('record-btn');
if (recordBtn) {
  recordBtn.addEventListener('click', () => converter.handleRecordButtonClick());
}

console.log('✅ [INIT] Offline converter ready');
