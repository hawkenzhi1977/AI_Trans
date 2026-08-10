/**
 * Mock for @huggingface/transformers (optional dependency).
 * Used in tests to avoid requiring the actual package.
 */
export async function pipeline(_task: string, _model: string): Promise<unknown> {
  throw new Error('Mock: @huggingface/transformers not available in test environment');
}
