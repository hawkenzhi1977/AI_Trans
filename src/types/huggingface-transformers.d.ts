declare module '@huggingface/transformers' {
  export interface PipelineOptions {
    dtype?: string;
    device?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    progress_callback?: (progress: any) => void;
  }

  export interface TranscriptionResult {
    text: string;
    chunks?: Array<{
      text: string;
      timestamp: [number, number | null];
    }>;
  }

  export type PipelineTask = 'automatic-speech-recognition' | 'text-generation';

  export function pipeline(
    task: PipelineTask,
    model: string,
    options?: PipelineOptions
  ): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (input: any, options?: { chunk_length_s?: number; stride_length_s?: number }): Promise<TranscriptionResult>;
  }>;

  export interface OnnxWasmConfig {
    wasmPaths?: string;
    numThreads?: number;
  }

  export interface TransformersEnv {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    logLevel?: string;
    remoteHost?: string;
    useCustomCache?: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customCache?: any;
    backends?: {
      webgpu?: boolean;
      wasm?: boolean;
      onnx?: {
        wasm?: OnnxWasmConfig;
      };
    };
  }

  export const env: TransformersEnv;
}
