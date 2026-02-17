/**
 * Main script for converting Pikachu Volleyball replay files to video
 * OFFLINE RENDERING (High Speed)
 * - Resolution: Fixed 432x304
 * - Audio: Reconstructs stereo sound (FakeAudio Hooking)
 * - UI: Canvas rendering simulating CSS 'fade-inout' animation & speech bubble style
 * Uses 'mp4-muxer' library
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
import { PikachuVolleyballReplay } from '../replay/pikavolley_replay.js';
import { setGetSpeechBubbleNeeded } from '../chat_display.js';
import { serialize } from '../utils/serialize.js';
import { getHashCode } from '../utils/hash_code.js';
import seedrandom from 'seedrandom';
import '../../style.css';

import * as Mp4Muxer from 'mp4-muxer';

console.log('🎬 [INIT] Offline Renderer (CSS Animation Sync)');

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
    
    settings.RESOLUTION = 1;
    settings.SCALE_MODE = SCALE_MODES.NEAREST;
    settings.ROUND_PIXELS = true;

    this.renderer = null;
    this.stage = null;
    this.loader = null;
    this.pikaVolley = null;
    
    this.audioLog = []; 
    this.decodedBuffers = {}; 
    this.totalDuration = 0;
    
    // 채팅 상태 관리
    this.chats = [];
    this.chatHead = 0;
    // { side, text, x, y, elapsed, duration }
    this.activeBubbles = []; 
    this.rng = null;

    this.muxer = null;
    this.videoEncoder = null;
    this.audioEncoder = null;
    this.chatSizeSelect = null;
    this.showNicknamesCheckbox = null;
    this.showIPsCheckbox = null;
    this.bgmCheckbox = null;
    this.sfxCheckbox = null;
    this.sharpGraphicsCheckbox = null;
  }

  updateUI() {
    this.chatSizeSelect = document.getElementById('chat-size-select');
    this.showNicknamesCheckbox = document.getElementById('show-nicknames-checkbox');
    this.showIPsCheckbox = document.getElementById('show-ip-addresses-checkbox');
    this.bgmCheckbox = document.getElementById('turn-on-bgm-checkbox');
    this.sfxCheckbox = document.getElementById('turn-on-sfx-checkbox');
    this.sharpGraphicsCheckbox = document.getElementById('graphic-sharp-checkbox');
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
      // @ts-ignore
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
        // @ts-ignore
        const packWithComment = JSON.parse(event.target.result);
        const pack = packWithComment.pack;
        
        const originalHash = pack.hash;
        pack.hash = 0;
        if (originalHash !== getHashCode(serialize(pack))) {
             console.warn('⚠️ Hash mismatch - ignored');
        }
        pack.hash = originalHash;

        this.initializeRenderer(pack);
      } catch (err) {
        console.error('❌ Error:', err);
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
    // @ts-ignore
    container.innerHTML = '';
    // @ts-ignore
    container.appendChild(this.renderer.view);
    
    this.ensureDOMElements(container); 

    this.loader.add(ASSETS_PATH.SPRITE_SHEET);
    
    const soundLoadPromises = [];
    //@ts-ignore
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext();
    
    const keyMapping = {
      'BGM': 'bgm', 'PIPIKACHU': 'pipikachu', 'PIKA': 'pika', 'CHU': 'chu',
      'PI': 'pi', 'PIKACHU': 'pikachu', 'POWERHIT': 'powerHit', 'BALLTOUCHESGROUND': 'ballTouchesGround',
    };

    this.updateUI();
    
    for (const key in ASSETS_PATH.SOUNDS) {
        const url = ASSETS_PATH.SOUNDS[key];
        const promise = fetch(url)
            .then(res => res.arrayBuffer())
            .then(buf => audioCtx.decodeAudioData(buf))
            .then(decoded => {
                const mappedKey = keyMapping[key] || key.toLowerCase();
                this.decodedBuffers[mappedKey] = decoded;
            });
        soundLoadPromises.push(promise);
        this.loader.add(ASSETS_PATH.SOUNDS[key]);
    }

    Promise.all(soundLoadPromises).then(() => {
        this.loader.load(() => this.startOfflineProcessing(pack));
    });
  }

  ensureDOMElements(container) {
    const ids = ['player1-nickname', 'player2-nickname', 'player1-partial-ip', 'player2-partial-ip'];
    ids.forEach(id => {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.style.display = 'none'; 
            container.appendChild(el);
        } else {
            el.textContent = '';
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

    // [RNG] 채팅 위치용 (chat_display.js와 동일한 시드 사용)
    this.rng = seedrandom.alea(pack.roomID.slice(10));

    this.chats = pack.chats || [];
    this.chatHead = 0;
    this.activeBubbles = [];

    try {
        // @ts-ignore
        setGetSpeechBubbleNeeded(this.pikaVolley); 
    } catch(e){}
    this.pikaVolley.willDisplayChat = true;

    this.audioLog = [];
    this.mockAudioSystem();

    const fps = 30;
    const totalFrames = pack.inputs.length;
    this.totalDuration = totalFrames / fps;

    // @ts-ignore
    this.muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: 432, height: 304 },
        audio: { codec: 'aac', sampleRate: 44100, numberOfChannels: 2 },
        fastStart: 'in-memory',
    });

    this.videoEncoder = new VideoEncoder({
        output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
        error: (e) => console.error('Video Error:', e)
    });
    this.videoEncoder.configure({
        codec: 'avc1.42001f', width: 432, height: 304, bitrate: 2_500_000, framerate: fps,
    });

    this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
        error: (e) => console.error('Audio Error:', e)
    });
    this.audioEncoder.configure({
        codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000,
    });

    const progressBar = document.getElementById('progress-bar');
    
    for (let i = 0; i < totalFrames; i++) {
        if (this.videoEncoder.encodeQueueSize > 20) {
            await new Promise(r => setTimeout(r, 10));
        }

        try {
            this.pikaVolley.gameLoopSilent(); 
        } catch(e) {}

        this.processChatFrame(i); // 채팅 상태 업데이트

        this.renderer.render(this.stage);
        this.drawOverlaysOnCanvas();

        // @ts-ignore
        const bitmap = await createImageBitmap(this.renderer.view);
        const videoFrame = new VideoFrame(bitmap, { timestamp: (i * 1000000) / fps });
        
        const keyFrame = i % 90 === 0;
        this.videoEncoder.encode(videoFrame, { keyFrame });
        videoFrame.close();

        if (i % 30 === 0) {
            const percent = Math.floor((i / totalFrames) * 100);
            this.updateStatus(`영상 처리 중... ${percent}%`);
            // @ts-ignore
            if(progressBar) progressBar.style.width = `${percent}%`;
            await new Promise(r => setTimeout(r, 0));
        }
    }

    await this.videoEncoder.flush();
    
    this.updateStatus('오디오 합성 중...');
    await this.synthesizeAndEncodeAudio(fps);

    this.muxer.finalize();
    const buffer = this.muxer.target.buffer;
    this.saveFile(buffer);
  }

  // [핵심] CSS @keyframes fade-inout 시뮬레이션
  // 0%~25%: Fade In | 25%~75%: Visible | 75%~100%: Fade Out
  // Duration: 5초 (30FPS 기준 150프레임)
  processChatFrame(currentFrame) {
      // 1. 새 채팅 확인
      while (this.chatHead < this.chats.length && this.chats[this.chatHead][0] === currentFrame) {
          const chat = this.chats[this.chatHead];
          const side = chat[1]; 
          const message = chat[2];
          
          // 위치 계산 (chat_display.js 로직 흉내)
          const rand1 = this.rng();
          const rand2 = this.rng();
          const canvasW = 432;
          const canvasH = 304;
          
          // Y 좌표: top 20% + 30% * rng
          const y = canvasH * (0.20 + 0.30 * rand1);
          let x;

          if (side === 1) {
              // P1: right 55% + 25% * rng -> left 좌표로 변환
              // right%가 55~80% 이면 left%는 20~45%
              const rightPct = 0.55 + 0.25 * rand2;
              x = canvasW * (1 - rightPct); 
          } else {
              // P2: left 55% + 25% * rng
              const leftPct = 0.55 + 0.25 * rand2;
              x = canvasW * leftPct;
          }

          // 기존 말풍선 중 같은 편인 것 제거
          this.activeBubbles = this.activeBubbles.filter(b => b.side !== side);

          this.activeBubbles.push({
              side: side,
              text: message,
              x: x,
              y: y,
              elapsed: 0,
              duration: 150 // 5초 * 30fps
          });

          this.chatHead++;
      }

      // 2. 애니메이션 프레임 진행
      for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
          const b = this.activeBubbles[i];
          b.elapsed++;

          // CSS fade-inout 시뮬레이션
          // 0~25%: Fade In
          // 25~75%: Visible
          // 75~100%: Fade Out
          const progress = b.elapsed / b.duration;
          
          if (progress < 0.25) {
              // 0 -> 1
              b.alpha = progress / 0.25;
          } else if (progress < 0.75) {
              // 1 유지
              b.alpha = 1.0;
          } else {
              // 1 -> 0
              b.alpha = 1.0 - ((progress - 0.75) / 0.25);
          }

          if (b.elapsed >= b.duration) {
              this.activeBubbles.splice(i, 1);
          }
      }
  }

  mockAudioSystem() {
    //@ts-ignore
    this.pikaVolley.audio.turnBGMVolume(this.bgmCheckbox.checked);
    //@ts-ignore
    this.pikaVolley.audio.turnSFXVolume(this.sfxCheckbox.checked);

    const fakeSounds = this.pikaVolley.fakeAudio.sounds;
    for (const key in fakeSounds) {
        if (key === 'bgm') continue;
        fakeSounds[key] = {
            play: (pan = 0) => {
                const currentFrame = this.pikaVolley.replayFrameCounter;
                this.audioLog.push({ key, frame: currentFrame, pan });
            },
            stop: () => {}
        };
    }
  }

  async synthesizeAndEncodeAudio(fps) {
    if (this.audioLog.length === 0) return;

    const sampleRate = 44100;
    const length = Math.ceil(this.totalDuration * sampleRate) + sampleRate; 
    const offlineCtx = new OfflineAudioContext(2, length, sampleRate);

    this.audioLog.forEach(log => {
        const buffer = this.decodedBuffers[log.key];
        if (buffer) {
            const source = offlineCtx.createBufferSource();
            source.buffer = buffer;
            const panner = offlineCtx.createStereoPanner();
            panner.pan.value = (log.pan || 0) * 0.75;
            source.connect(panner);
            panner.connect(offlineCtx.destination);
            source.start(log.frame / fps);
        }
    });

    const renderedBuffer = await offlineCtx.startRendering();
    this.downloadWav(renderedBuffer);

    const chunkSize = 4096; 
    const lengthSamples = renderedBuffer.length;
    const numberOfChannels = renderedBuffer.numberOfChannels;

    for (let frame = 0; frame < lengthSamples; frame += chunkSize) {
        const size = Math.min(chunkSize, lengthSamples - frame);
        const planarData = new Float32Array(size * numberOfChannels);
        for (let ch = 0; ch < numberOfChannels; ch++) {
            const channelData = renderedBuffer.getChannelData(ch);
            planarData.set(channelData.subarray(frame, frame + size), ch * size);
        }
        const audioData = new AudioData({
            format: 'f32-planar', sampleRate, numberOfChannels, numberOfFrames: size,
            timestamp: (frame / sampleRate) * 1_000_000, data: planarData
        });
        this.audioEncoder.encode(audioData);
        audioData.close();
    }
    await this.audioEncoder.flush();
  }

  saveFile(buffer) {
    const blob = new Blob([buffer], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
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
    // @ts-ignore
    if (recordBtn) recordBtn.disabled = false;
    const loadingOverlay = document.getElementById('loading-overlay');
    // @ts-ignore
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    
    setTimeout(() => {
        URL.revokeObjectURL(url);
        this.muxer = null;
        this.videoEncoder = null;
        this.audioEncoder = null;
        this.audioLog = [];
    }, 1000);
  }

  drawOverlaysOnCanvas() {
    // @ts-ignore
    const ctx = this.renderer.view.getContext('2d');
    if (!ctx) return;

    ctx.save();
    
    const center = 216;
    const distance = 50;
    const nicknameY = 10;
    const ipY = 25;
    let p1Nickset = '';
    let p2Nickset = '';
    let p1IPset = '';
    let p2IPset = '';
    //@ts-ignore
    if (this.showNicknamesCheckbox.checked) {
        p1Nickset = document.getElementById('player1-nickname')?.textContent || '';
        p2Nickset = document.getElementById('player2-nickname')?.textContent || '';
    }
    //@ts-ignore
    if (this.showIPsCheckbox.checked) {
        p1IPset = document.getElementById('player1-partial-ip')?.textContent || '';
        p2IPset = document.getElementById('player2-partial-ip')?.textContent || '';
    }

    const p1Nick = p1Nickset;
    const p2Nick = p2Nickset;
    const p1IP = p1IPset;
    const p2IP = p2IPset;

    // Player 1
    if (p1Nick) {
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.strokeText(p1Nick, center - distance, nicknameY);
        ctx.fillText(p1Nick, center - distance, nicknameY);
        if (p1IP) {
            ctx.font = '8px sans-serif';
            ctx.lineWidth = 1;
            ctx.strokeText(p1IP, center - distance, ipY);
            ctx.fillText(p1IP, center - distance, ipY);
        }
    }

    // Player 2
    if (p2Nick) {
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 1;
        ctx.strokeText(p2Nick, center + distance, nicknameY);
        ctx.fillText(p2Nick, center + distance, nicknameY);
        if (p2IP) {
            ctx.font = '8px sans-serif';
            ctx.lineWidth = 1;
            ctx.strokeText(p2IP, center + distance, ipY);
            ctx.fillText(p2IP, center + distance, ipY);
        }
    }

    // 말풍선 그리기 (페이드아웃 알파 적용)
    this.activeBubbles.forEach(b => {
        this.drawSpeechBubble(ctx, b.text, b.x, b.y, b.alpha);
    });
    
    ctx.restore();
  }

  // [핵심] CSS 스타일 흉내 (흰색 배경, 둥근 모서리, 패딩)
  drawSpeechBubble(ctx, text, x, y, alpha) {
      if (!text) return;
      
      ctx.save();
      ctx.globalAlpha = alpha; // 계산된 투명도 적용
      //@ts-ignore
      if (this.chatSizeSelect.value === 'large') {
        ctx.font = '18px "Segoe UI", sans-serif';
        //@ts-ignore
      } else if (this.chatSizeSelect.value === 'small') {
        ctx.font = '12px "Segoe UI", sans-serif';
      } else {
        return;
      }
      ctx.font = '12px sans-serif'; // CSS: font-size: calc(1.5 * var(--font-size)) approx 24px but scaled down here
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const textMetrics = ctx.measureText(text);
      const padding = 6; // CSS: padding: 10px
      const width = textMetrics.width + (padding * 2);
      const height = 24 + padding; // 대략적인 높이
      const r = 10; // CSS: border-radius: 10px

      // 말풍선 위치 조정 (Top, Left/Right 기준 보정)
      const bubbleX = x - width / 2;
      const bubbleY = y;

      // 둥근 사각형 그리기
      ctx.beginPath();
      ctx.moveTo(bubbleX + r, bubbleY);
      ctx.lineTo(bubbleX + width - r, bubbleY);
      ctx.quadraticCurveTo(bubbleX + width, bubbleY, bubbleX + width, bubbleY + r);
      ctx.lineTo(bubbleX + width, bubbleY + height - r);
      ctx.quadraticCurveTo(bubbleX + width, bubbleY + height, bubbleX + width - r, bubbleY + height);
      ctx.lineTo(bubbleX + r, bubbleY + height);
      ctx.quadraticCurveTo(bubbleX, bubbleY + height, bubbleX, bubbleY + height - r);
      ctx.lineTo(bubbleX, bubbleY + r);
      ctx.quadraticCurveTo(bubbleX, bubbleY, bubbleX + r, bubbleY);
      ctx.closePath();

      // CSS: background-color: rgba(255, 255, 255, 0.95)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fill();

      // 텍스트 그리기 (CSS: color: black)
      ctx.fillStyle = 'black';
      ctx.fillText(text, x, bubbleY + height / 2);

      ctx.restore();
  }

  downloadWav(audioBuffer) {
    const buffer = this.bufferToWave(audioBuffer, audioBuffer.length);
    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pikavolley_audio.wav`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
  }

  bufferToWave(abuffer, len) {
    const numOfChan = abuffer.numberOfChannels;
    const length = len * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let i, sample, offset = 0, pos = 0;

    setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); 
    setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
    setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan); 
    setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4); 

    for (i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));

    while (pos < len) {
      for (i = 0; i < numOfChan; i++) {
        sample = Math.max(-1, Math.min(1, channels[i][pos])); 
        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
        view.setInt16(44 + offset, sample, true);
        offset += 2;
      }
      pos++;
    }
    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
    return buffer;
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