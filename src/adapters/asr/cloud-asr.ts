// 雲端 ASR 適配器——支持 OpenAI Whisper API 與 Deepgram WebSocket。
// 端點自動識別：含 "deepgram" → WebSocket 流式；其他 → OpenAI 兼容 multipart。
import type { ASRProvider } from '../../domain/ports/asr-provider';
import type { ASRConfig } from '../../domain/models/config';
import type { ASRRequest, ASRResult } from '../../domain/models/asr';
import type { SubtitleSegment } from '../../domain/models/subtitle';
import { recordDiagnostic } from '../../infrastructure/diagnostics';

/** 將 Float32Array PCM 轉換為 WAV Blob（16kHz mono）。 */
function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const numSamples = pcm.length;
  const bytesPerSample = 2; // 16-bit
  const buffer = new ArrayBuffer(44 + numSamples * bytesPerSample);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + numSamples * bytesPerSample, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, numSamples * bytesPerSample, true);

  // PCM data (Float32 → Int16)
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** OpenAI Whisper API 響應格式。 */
interface WhisperAPIResponse {
  text: string;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
}

/**
 * 雲端 ASR Provider——支持 OpenAI Whisper API 與 Deepgram WebSocket。
 * 端點自動識別：含 "deepgram" → WebSocket；其他 → OpenAI 兼容。
 */
export class CloudASR implements ASRProvider {
  readonly engineId: string;
  readonly location = 'cloud' as const;

  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(config: { endpoint: string; apiKey: string; model?: string }) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'whisper-1';

    // 端點識別：含 "deepgram" → WebSocket；其他 → OpenAI。
    this.engineId = config.endpoint.toLowerCase().includes('deepgram')
      ? 'cloud-asr-deepgram'
      : 'cloud-asr-openai';
  }

  async warmup(_config: ASRConfig): Promise<void> {
    // 雲端 ASR 無需預熱（首次請求即建立連接）。
  }

  async transcribe(req: ASRRequest): Promise<ASRResult> {
    const startTime = performance.now();

    if (this.engineId === 'cloud-asr-deepgram') {
      return this.transcribeDeepgram(req, startTime);
    }
    return this.transcribeOpenAI(req, startTime);
  }

  async transcribeStream(req: ASRRequest, emit: (r: ASRResult) => void): Promise<void> {
    if (this.engineId === 'cloud-asr-deepgram') {
      await this.transcribeDeepgramStream(req, emit);
      return;
    }
    // OpenAI Whisper API 不支持流式，回退到非流式。
    const result = await this.transcribe(req);
    emit(result);
  }

  /** OpenAI Whisper API（multipart/form-data）。 */
  private async transcribeOpenAI(req: ASRRequest, startTime: number): Promise<ASRResult> {
    const { chunk, hintLang } = req;
    const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);

    const formData = new FormData();
    formData.append('file', wavBlob, 'audio.wav');
    formData.append('model', this.model);
    formData.append('response_format', 'verbose_json');
    if (hintLang) formData.append('language', hintLang);

    const url = `${this.endpoint}/v1/audio/transcriptions`;
    const response = await globalThis.fetch.bind(globalThis)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`OpenAI Whisper API failed: HTTP ${response.status}: ${errorText}`);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-engine-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }

    const data = (await response.json()) as WhisperAPIResponse;
    const durationMs = performance.now() - startTime;
    const audioDurationMs = chunk.duration;
    const rtf = durationMs / audioDurationMs;

    const segments: SubtitleSegment[] = data.segments?.map((seg, i) => ({
      id: `${chunk.seq}-${i}`,
      sourceText: seg.text.trim(),
      translatedText: undefined, // 由翻譯管線處理
      provisional: false,
      start: seg.start * 1000, // 秒 → 毫秒
      end: seg.end * 1000,
      origin: 'realtime-asr' as const,
      revision: 0,
    })) ?? [
      {
        id: `${chunk.seq}-0`,
        sourceText: data.text.trim(),
        translatedText: undefined,
        provisional: false,
        start: 0,
        end: chunk.duration,
        origin: 'realtime-asr' as const,
        revision: 0,
      },
    ];

    return {
      seq: chunk.seq,
      segments,
      isPartial: false,
      rtf,
    };
  }

  /** Deepgram WebSocket 流式（非流式回退）。 */
  private async transcribeDeepgram(req: ASRRequest, startTime: number): Promise<ASRResult> {
    // Deepgram REST API 回退（非流式）。
    const { chunk, hintLang } = req;
    const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);

    const url = `${this.endpoint}/v1/listen?model=nova-2${hintLang ? `&language=${hintLang}` : ''}`;
    const response = await globalThis.fetch.bind(globalThis)(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: wavBlob,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Deepgram API failed: HTTP ${response.status}: ${errorText}`);
      recordDiagnostic({
        type: 'pipeline-error',
        error: {
          port: 'asr',
          code: 'asr-engine-failed',
          recoverable: true,
          cause: error,
        },
      });
      throw error;
    }

    const data = (await response.json()) as {
      results: {
        channels: Array<{
          alternatives: Array<{
            transcript: string;
            words: Array<{ word: string; start: number; end: number }>;
          }>;
        }>;
      };
    };
    const durationMs = performance.now() - startTime;
    const audioDurationMs = chunk.duration;
    const rtf = durationMs / audioDurationMs;

    const alternative = data.results.channels[0]?.alternatives[0];
    const segments: SubtitleSegment[] = alternative
      ? [
          {
            id: `${chunk.seq}-0`,
            sourceText: alternative.transcript.trim(),
            translatedText: undefined,
            provisional: false,
            start: 0,
            end: chunk.duration,
            origin: 'realtime-asr' as const,
            revision: 0,
          },
        ]
      : [];

    return {
      seq: chunk.seq,
      segments,
      isPartial: false,
      rtf,
    };
  }

  /** Deepgram WebSocket 流式（provisional → final）。 */
  private async transcribeDeepgramStream(
    req: ASRRequest,
    emit: (r: ASRResult) => void
  ): Promise<void> {
    const { chunk, hintLang } = req;
    const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&interim_results=true${
      hintLang ? `&language=${hintLang}` : ''
    }`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, ['token', this.apiKey]);
      let finalEmitted = false;

      ws.onopen = () => {
        // 發送音頻數據。
        const wavBlob = pcmToWav(chunk.pcm, chunk.sampleRate);
        wavBlob.arrayBuffer().then((buffer) => {
          ws.send(buffer);
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        });
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type: string;
            is_final?: boolean;
            channel?: {
              alternatives?: Array<{
                transcript: string;
                words?: Array<{ word: string; start: number; end: number }>;
              }>;
            };
          };

          if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
            const alt = data.channel.alternatives[0];
            const isFinal = data.is_final === true;
            const segment: SubtitleSegment = {
              id: `${chunk.seq}-0`,
              sourceText: alt.transcript.trim(),
              translatedText: undefined,
              provisional: !isFinal,
              start: 0,
              end: chunk.duration,
              origin: 'realtime-asr' as const,
              revision: 0,
            };

            emit({
              seq: chunk.seq,
              segments: [segment],
              isPartial: !isFinal,
              rtf: undefined, // 流式不計算 RTF。
            });

            if (isFinal) finalEmitted = true;
          }
        } catch {
          // JSON 解析失敗，忽略。
        }
      };

      ws.onclose = () => {
        if (!finalEmitted) {
          // 未收到 final 結果，發空結果。
          emit({
            seq: chunk.seq,
            segments: [],
            isPartial: false,
            rtf: undefined,
          });
        }
        resolve();
      };

      ws.onerror = (err) => {
        const error = new Error(`Deepgram WebSocket error: ${err}`);
        recordDiagnostic({
          type: 'pipeline-error',
          error: {
            port: 'asr',
            code: 'asr-engine-failed',
            recoverable: true,
            cause: error,
          },
        });
        reject(error);
      };
    });
  }
}
